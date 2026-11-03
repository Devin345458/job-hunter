import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { applications, jobs, questions } from '../db/schema'
import type { FormAnswer, GapAnalysis, Requirement } from '#shared/types/pipeline'
import type { AnswerOutcome, QuestionListItem } from '#shared/types/learning'
import { aiStructured, fallbackModel } from './ai'
import {
  ADDRESS_KNOWLEDGE_KEYS,
  addressAnswerParts,
  factForQuestion,
  isAddressFact,
  isAddressQuestion,
  labelText,
  missingAddressParts,
  questionFor,
  resolveFacts,
  storeKeyOf,
  type AddressPart,
  type AddressParts,
  type FactDef,
  type FactValues,
} from './facts'
import { loadKnowledge, setKnowledgeIfChanged, upsertKnowledge, type KnowledgeEntry } from './knowledge'
import { dataPath } from './paths'
import { ruleTerm, ruleWordMatch } from './learned-score'
import { nowSql, parseJson, referencedQuestionIds } from './review'
import { queueSkillRescore, rescoreJobs } from './scoring'
import { applyAnswerToOpenJobs } from './skill-claims'
import { NOT_A_GAP } from '#shared/utils/requirement-kinds'
import { queueRepoSuggest, repoSuggestionsFor } from './repos/suggest-store'

export type QuestionRow = InferSelectModel<typeof questions>

export interface AskInput {
  /** Plain question Devin can answer in a tap or a sentence, e.g. "Have you used Go in production?" */
  question: string
  /** Why the pipeline is asking. Shown under the question. */
  context?: string
  kind: 'has_done' | 'knows' | 'preference' | 'fact' | 'form_field' | 'other'
  /** What the question is about, e.g. "Go", "salary floor". Drives dedupe. */
  subject: string
  answerType?: 'yes_no' | 'text' | 'number' | 'choice'
  choices?: string[]
  /** Where the answer is stored in the knowledge base, "category:key". */
  knowledgeKey?: string
  applicationId?: number
  jobId?: number
  /** True when an application cannot be approved until this is answered. */
  blocking?: boolean
  category?: string
}

export function dedupeKeyOf(kind: string, subject: string) {
  return `${kind}:${subject.toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim()}`
}

/**
 * Ask Devin a question, at most once per (kind, subject).
 * - Already answered: returns the existing row (status 'answered'), so the caller can use the answer.
 * - Already pending: returns it, and marks it blocking if this caller needs it to block.
 * - Otherwise inserts a new pending question.
 */
export function askQuestion(input: AskInput): QuestionRow {
  const db = useDb()
  const dedupeKey = dedupeKeyOf(input.kind, input.subject)
  const existing = db.select().from(questions)
    .where(and(eq(questions.dedupeKey, dedupeKey), inArray(questions.status, ['pending', 'answered'])))
    .all()
  const answered = existing.find(q => q.status === 'answered')
  if (answered) return answered
  const pending = existing.find(q => q.status === 'pending')
  if (pending) {
    if (input.blocking && !pending.blocking) {
      db.update(questions).set({ blocking: true }).where(eq(questions.id, pending.id)).run()
      return { ...pending, blocking: true }
    }
    return pending
  }
  const row = db.insert(questions).values({
    question: input.question,
    context: input.context ?? null,
    category: input.category ?? (input.kind === 'preference' ? 'preference' : 'technical'),
    kind: input.kind,
    subject: input.subject,
    answerType: input.answerType ?? (input.kind === 'has_done' || input.kind === 'knows' ? 'yes_no' : 'text'),
    choicesJson: input.choices ? JSON.stringify(input.choices) : null,
    knowledgeKey: input.knowledgeKey ?? null,
    applicationId: input.applicationId ?? null,
    jobId: input.jobId ?? null,
    blocking: input.blocking ?? false,
    dedupeKey,
    status: 'pending',
  }).returning().get()
  // A new skill or experience question gets checked against Devin's own GitHub commits.
  if (row.kind === 'knows' || row.kind === 'has_done') queueRepoSuggest(row.id)
  return row
}

/** Answered value for a (kind, subject), or null if Devin has not answered it. */
export function answeredValue(kind: AskInput['kind'], subject: string): string | null {
  const row = useDb().select().from(questions)
    .where(and(eq(questions.dedupeKey, dedupeKeyOf(kind, subject)), eq(questions.status, 'answered')))
    .get()
  return row?.answer ?? null
}

// ── Learning unit (capability D): answering, knowledge writes, and plain questions ──
// askQuestion() and answeredValue() above keep their signatures. Everything below is added.

export const KNOWLEDGE_CATEGORIES = ['profile', 'experience', 'skill', 'preference', 'project', 'education', 'personal'] as const

/** Subject and knowledge key of the pay floor question. Other units read it with compensationFloor(). */
export const COMP_FLOOR_SUBJECT = 'compensation floor'
export const COMP_FLOOR_KEY = 'preference:Minimum Total Compensation'

const WAITING_STATUSES = ['needs_input', 'proposed']
const CLOSED_JOB_STATUSES = ['rejected', 'expired', 'applied']

/** Knowledge values written for a No answer start this way, so nothing ever claims them. */
const NEGATIVE_VALUE = /^(does not know|has not done|no production experience)/i

export function isNegativeKnowledge(value: string | null | undefined): boolean {
  return !!value && NEGATIVE_VALUE.test(value.trim())
}

export type YesNo = 'yes' | 'some' | 'no'

const YES_NO_LABELS: Record<YesNo, string> = { yes: 'Yes', some: 'Some experience', no: 'No' }

export function parseYesNo(answer: string): YesNo | null {
  const a = answer.trim().toLowerCase()
  if (['yes', 'y', 'true'].includes(a)) return 'yes'
  if (['no', 'n', 'false'].includes(a)) return 'no'
  if (['some experience', 'some', 'partly', 'a little'].includes(a)) return 'some'
  return null
}

/** "$150,000", "150k", "150000" and "150000/yr" all read as 150000. */
function parseMoney(answer: string): number | null {
  const s = answer.replace(/[,\s]/g, '').toLowerCase()
  const m = s.match(/^\$?(\d+(?:\.\d+)?)(k)?(?:\/?(?:yr|year|y|peryear))?$/)
  if (!m) return null
  const n = Number(m[1]) * (m[2] ? 1000 : 1)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

function money(n: number) {
  return `$${Math.round(n).toLocaleString('en-US')}`
}

function truncateWords(s: string, max = 150): string {
  const t = s.trim().replace(/\s+/g, ' ')
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : max)}...`
}

function capitalize(s: string) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/** True for rows from the original tailoring flow: no kind and no answer type. */
export function isLegacyQuestion(q: QuestionRow): boolean {
  return !q.kind && !q.answerType
}

/** Existing entry for (category, key). Skills compare as normalized terms, so "Vue.js" finds "Vue". */
export function findKnowledgeEntry(category: string, key: string, entries: KnowledgeEntry[] = loadKnowledge(category)): KnowledgeEntry | null {
  const want = category === 'skill' ? ruleTerm(key) : key.trim().toLowerCase()
  return entries.find(e => e.category === category
    && (category === 'skill' ? ruleTerm(e.key) === want : e.key.trim().toLowerCase() === want)) ?? null
}

/**
 * The knowledge base entry that already answers "does Devin know or has he done <subject>",
 * positive or negative. A covered subject is never asked about.
 */
/** Basics a senior web developer's knowledge base implies without listing them. */
const IMPLIED_BY: Record<string, string[]> = {
  html: ['javascript', 'css/sass/less', 'css', 'vue'],
  css: ['css/sass/less', 'sass'],
  json: ['javascript'],
  sql: ['mysql'],
  git: ['github actions'],
  docker: ['kubernetes'],
  'rest api': ['laravel', 'express', 'node'],
  'rest apis': ['laravel', 'express', 'node'],
}

export function knowledgeCovers(subject: string): KnowledgeEntry | null {
  const want = ruleTerm(subject)
  if (!want) return null
  const entries = loadKnowledge()
  for (const e of entries) {
    if (e.category !== 'skill' && e.category !== 'experience') continue
    const key = e.key.replace(/^has done:\s*/i, '')
    if (ruleTerm(key) === want || key.split(/[/,]/).some(p => ruleTerm(p) === want)) return e
  }
  const implied = IMPLIED_BY[want]
  if (implied) {
    const hit = entries.find(e => e.category === 'skill' && implied.includes(ruleTerm(e.key)))
    if (hit) return hit
  }
  return null
}

/** Single words that name a trait or a whole field, not a skill someone can say yes or no to. */
const GENERIC_WORDS = new Set(['api', 'apis', 'rest', 'rest apis', 'sdks', 'saas', 'b2b', 'learning', 'coding', 'programming', 'development', 'software', 'engineering', 'collaboration', 'teamwork', 'ownership', 'leadership', 'mentoring', 'problem solving', 'curiosity', 'creativity', 'debugging', 'architecture', 'design', 'quality', 'security', 'data', 'ai', 'ml', 'cloud', 'web', 'mobile', 'backend', 'frontend', 'full stack', 'fullstack'])

const HUMAN_LANGUAGE = /\b(english|spanish|french|german|portuguese|communication|written|verbal)\b/i

/**
 * The skill a requirement line names, or null when it is not a skill worth asking about.
 * "2+ years of experience with LangChain" becomes "LangChain", "Knowledge of Temporal is a
 * must" becomes "Temporal", "Next.js: 2+ years commercial experience" becomes "Next.js", and
 * "Advanced English communication" becomes null.
 */
export function cleanSkillSubject(raw: string): string | null {
  let t = raw.replace(/\s+/g, ' ').trim()
  const colon = t.indexOf(':')
  if (colon > 0 && /\d|year|experience/i.test(t.slice(colon))) t = t.slice(0, colon)
  t = t.replace(/\b\d+\s*\+?\s*(years?|yrs?)\b( of)?( (commercial|professional|hands-on|production))?( experience)?( (with|in|using))?/gi, ' ').trim()
  t = t.replace(/^(at least|one of|either|with|using|in)\s+/i, '')
  t = t.replace(/^(solid|strong|deep|good|working|advanced|basic|proven|hands-on|excellent|exceptional|expert)\s+/i, '')
  t = t.replace(/^(understanding|knowledge|expertise|experience|proficiency|familiarity|fluency)\s+(of|in|with)\s+/i, '')
  t = t.replace(/\s+(is|are)\s+(a\s+)?(must|required|preferred|plus|nice to have)\b.*$/i, '')
  t = t.replace(/\b(commercial|professional)?\s*experience\b/gi, ' ')
  t = t.replace(/\(.*?\)/g, ' ').replace(/[.,;:]+$/, '').replace(/\s+/g, ' ').trim()
  t = t.replace(/\s+(skills?|tools?|knowledge|concepts?|fundamentals|principles|expertise|mindset|solutions?|background|capabilit(?:y|ies))$/i, '').trim()
  t = t.replace(/\s+((back[\s-]?end|front[\s-]?end|full[\s-]?stack|software|application)\s+)?(development|practices|programming)$/i, '').trim()
  t = t.replace(/^(associated|related|relevant|modern|common|core|key|various|multiple)\s+(frameworks?|tools?|technologies)\s+/i, '').trim()
  if (t.length < 2 || t.length > 32) return null
  if (GENERIC_WORDS.has(t.toLowerCase())) return null
  if (HUMAN_LANGUAGE.test(t)) return null
  // Compound requirements ("RAG or OpenAI", "Golang and/or Python", lists) cannot be answered
  // with one yes or no; the single skills inside them get asked on their own.
  if (/\s(or|and)\s|\/|,|&/i.test(t)) return null
  // Activities rather than skills ("using data to inform decisions").
  if (/^(using|working|building|making|being|having|ability|able)\b/i.test(t)) return null
  // Fragments of a sentence ("the other", "any of these").
  if (/^(the|a|an|this|that|these|those|other|any|some|each|all)\b/i.test(t)) return null
  if (t.split(' ').length > 3) return null
  // Job titles, not skills ("Senior Salesforce Developer").
  if (/\b(senior|junior|staff|principal|lead|developer|engineer|manager|architect|specialist|analyst)s?\b/i.test(t)) return null
  // Generic phrases of plain lowercase words ("scalable data solutions", "integration"); a named
  // tool has a capital letter, a digit, or a symbol ("Databricks", "S3", "C#", "Next.js").
  // Requirement text starts sentences with a capital, so the first letter does not count.
  const plain = t.charAt(0).toLowerCase() + t.slice(1)
  const known = KNOWN_LOWERCASE_SKILLS.has(plain.toLowerCase())
  if (/^[a-z][a-z -]*$/.test(plain) && !known) return null
  return DISPLAY_ALIASES[t.toLowerCase()] ?? t
}

/** Lowercase skills worth asking about as written; any other all-lowercase phrase is too generic. */
const KNOWN_LOWERCASE_SKILLS = new Set(['machine learning', 'infrastructure-as-code', 'unit testing', 'test-driven development', 'microservices', 'kubernetes', 'docker', 'terraform', 'graphql', 'redis', 'kafka', 'linux', 'bash', 'webpack', 'vite', 'jest', 'vitest', 'cypress', 'playwright', 'accessibility', 'websockets', 'oauth', 'sso', 'ci/cd', 'event sourcing', 'distributed systems', 'system design', 'computer vision', 'data pipelines', 'stream processing'])

const DISPLAY_ALIASES: Record<string, string> = { golang: 'Go', nodejs: 'Node.js', reactjs: 'React', 'react.js': 'React', vuejs: 'Vue', 'vue.js': 'Vue', k8s: 'Kubernetes' }

/** Plain wording for a "knows" question: tools by name, practices as "worked with". */
export function knowsQuestionText(subject: string): string {
  // "System integration" and "Infrastructure-as-code" are practices: a capitalized first word
  // followed only by lowercase words. Everything else (MobX, Next.js, AI-assisted coding) is a tool.
  const practice = /^[A-Z][a-z]+([ -][a-z]+)+$/.test(subject) || /^[a-z]/.test(subject)
  return practice
    ? `Have you worked with ${subject.charAt(0).toLowerCase()}${subject.slice(1)} in a real project?`
    : `Have you used ${subject} in a real project?`
}

/** Where an answer is written: the question's knowledge_key, or one derived from its kind and subject. */
export function knowledgeTargetFor(q: QuestionRow): { category: string; key: string } {
  if (q.knowledgeKey) {
    const i = q.knowledgeKey.indexOf(':')
    const category = i > 0 ? q.knowledgeKey.slice(0, i).trim().toLowerCase() : ''
    const key = i > 0 ? q.knowledgeKey.slice(i + 1).trim() : ''
    if (key && (KNOWLEDGE_CATEGORIES as readonly string[]).includes(category)) return { category, key }
  }
  const subject = q.subject?.trim() || ''
  switch (q.kind) {
    case 'knows': return { category: 'skill', key: subject || truncateWords(q.question) }
    case 'has_done': return { category: 'experience', key: `Has done: ${subject || truncateWords(q.question)}` }
    case 'preference': return { category: 'preference', key: capitalize(subject) || truncateWords(q.question) }
    case 'fact':
    case 'form_field':
    case 'other': return { category: 'personal', key: capitalize(subject) || truncateWords(q.question) }
  }
  // Legacy rows from the original tailoring flow carry only a category and the question text.
  if (q.category === 'preference') return { category: 'preference', key: truncateWords(q.question) }
  return { category: 'experience', key: truncateWords(q.question) }
}

/** The knowledge value for a skill Devin does not have. A No to "Have you used X?" and a "Wrong tech stack: I don't have these" rejection both write it. */
export function negativeSkillValue(subject: string, source: string): string {
  return `Does not know ${subject}. No production experience with ${subject}. Never claim ${subject} experience. ${source}`
}

/** Longest example Devin can give with a Yes or Some experience answer. */
export const EXAMPLE_MAX_CHARS = 1000

/** A yes or no question about a skill or past work. A Yes or Some experience answer to it can carry an example. */
export function takesExample(q: Pick<QuestionRow, 'answerType' | 'kind'>): boolean {
  return q.answerType === 'yes_no' && (q.kind === 'knows' || q.kind === 'has_done')
}

/** The claim a Yes or Some experience answer writes, before any example. Null for a No and for other questions. */
function positiveClaim(q: QuestionRow, yn: YesNo): string | null {
  const subject = q.subject?.trim() || 'this'
  if (q.kind === 'knows') {
    if (yn === 'yes') return `Knows ${subject}.`
    if (yn === 'some') return `Some experience with ${subject}, not in depth. Do not claim production or expert level ${subject}.`
  }
  if (q.kind === 'has_done') {
    if (yn === 'yes') return `Has done this: ${subject}.`
    if (yn === 'some') return `Has partly done this: ${subject}. Do not overstate it.`
  }
  return null
}

const EXAMPLE_MARK = ' Example: '

function askedNote(q: QuestionRow) {
  return `(Answer to: ${q.question})`
}

/**
 * The sentence stored in the knowledge base for an answer. A No is stored too, so it is never asked or claimed.
 * A Yes or Some experience answer to a skill or experience question can carry Devin's example, stored exactly
 * as he typed it (trimmed) between the claim and the "(Answer to: ...)" note:
 * "Has done this: Live event demos. Example: <his text> (Answer to: <question>)".
 * exampleFromValue() reads it back, so the two must change together.
 */
export function knowledgeValueFor(q: QuestionRow, answer: string, example?: string | null): { value: string; negative: boolean } {
  const subject = q.subject?.trim() || 'this'
  const asked = askedNote(q)
  if (q.answerType === 'yes_no') {
    const yn = parseYesNo(answer) ?? 'no'
    const claim = positiveClaim(q, yn)
    if (claim) {
      const text = example?.trim()
      return { value: `${claim}${text ? `${EXAMPLE_MARK}${text}` : ''} ${asked}`, negative: false }
    }
    if (q.kind === 'knows') return { value: negativeSkillValue(subject, asked), negative: true }
    if (q.kind === 'has_done') return { value: `Has not done this: ${subject}. Never claim it. ${asked}`, negative: true }
    return { value: `${YES_NO_LABELS[yn]}. ${asked}`, negative: false }
  }
  if (q.answerType === 'number') {
    const n = parseMoney(answer)
    if (q.subject === COMP_FLOOR_SUBJECT && n) {
      return { value: `${money(n)} a year in total compensation (base, bonus, equity, and benefits) is the lowest he would accept. ${asked}`, negative: false }
    }
    return { value: `${answer.trim()} ${asked}`, negative: false }
  }
  // Text and choice answers are stored in his own words.
  return { value: answer.trim(), negative: false }
}

/**
 * Devin's example inside a knowledge value that knowledgeValueFor() wrote for this question and
 * answer, exactly as he typed it. Null when the value holds no example (or was edited by hand).
 */
export function exampleFromValue(q: QuestionRow, answer: string | null, value: string): string | null {
  if (!takesExample(q)) return null
  const yn = parseYesNo(answer ?? '')
  const claim = yn ? positiveClaim(q, yn) : null
  if (!claim) return null
  const start = `${claim}${EXAMPLE_MARK}`
  const endAt = value.lastIndexOf(` ${askedNote(q)}`)
  if (endAt < 0) return null
  const startAt = value.lastIndexOf(start, endAt)
  if (startAt < 0) return null
  return value.slice(startAt + start.length, endAt).trim() || null
}

/** The example saved with an answered Yes or Some experience question, read from its knowledge entry. */
export function questionExample(q: QuestionRow, entries?: KnowledgeEntry[]): string | null {
  if (q.status !== 'answered' || !q.answer || !takesExample(q)) return null
  const target = knowledgeTargetFor(q)
  const entry = findKnowledgeEntry(target.category, target.key, entries ?? loadKnowledge(target.category))
  return entry ? exampleFromValue(q, q.answer, entry.value) : null
}

/** `value` without one copy of `segment`, and the line break that set it apart. */
function withoutSegment(value: string, segment: string): string {
  for (const s of [`\n${segment}`, `${segment}\n`, segment]) {
    if (value.includes(s)) return value.replace(s, () => '')
  }
  return value
}

/**
 * Writes an answer's value to its entry. `previous` is the value this question's earlier answer
 * wrote, so a changed answer or an added example replaces that sentence instead of stacking a
 * second one under resume text.
 */
function writeKnowledge(target: { category: string; key: string }, value: string, negative: boolean, previous?: string | null): KnowledgeEntry {
  const existing = findKnowledgeEntry(target.category, target.key)
  const key = existing?.key ?? target.key
  // A Yes on something the resume already lists keeps the resume text and adds the answer under it.
  if (existing && !negative && existing.source !== 'user_answer' && !isNegativeKnowledge(existing.value)) {
    const base = previous && previous !== value ? withoutSegment(existing.value, previous) : existing.value
    if (!base.trim()) return upsertKnowledge(target.category, key, value, 'user_answer')
    const merged = base.includes(value) ? base : `${base}\n${value}`
    return upsertKnowledge(target.category, key, merged, existing.source)
  }
  return upsertKnowledge(target.category, key, value, 'user_answer')
}

/**
 * Writes an answer to the knowledge base. The home address is split into street, city, state,
 * and ZIP, each its own entry, so any part fills any address field on any form. Every other
 * answer goes to its question's knowledge key as before.
 */
function writeAnswerKnowledge(q: QuestionRow, answer: string, example: string | null = null): KnowledgeEntry {
  const def = factForQuestion(q)
  if (isAddressQuestion(q) || isAddressFact(def)) {
    const facts = resolveFacts(loadKnowledge(), { answered: answeredValue })
    // The single address question asks for whatever is missing. An older question about one
    // part ("What city and state do you live in now?") asks for the parts its fact needs.
    const asked: AddressPart[] = isAddressQuestion(q)
      ? (missingAddressParts(facts).length ? missingAddressParts(facts) : ['street', 'city', 'state', 'zip'])
      : (def?.needs?.length ? def.needs : [])
    const { parts, missingAfter } = addressAnswerParts(answer, asked)
    if (missingAfter.length === 0 && Object.keys(parts).some(k => k !== 'country')) return writeAddressParts(parts, 'user_answer').main
    if (isAddressQuestion(q)) {
      throw createError({ statusCode: 400, statusMessage: addressAnswerHint(asked) })
    }
    // An older address question answered in words the parser cannot split ("Remote") is stored as written.
  }
  const target = knowledgeTargetFor(q)
  const { value, negative } = knowledgeValueFor(q, answer, example)
  // Only values that end in the "(Answer to: ...)" note are unique enough to find and replace inside resume text.
  const previous = q.status === 'answered' && q.answer && (q.answerType === 'yes_no' || q.answerType === 'number')
    ? knowledgeValueFor(q, q.answer, questionExample(q)).value
    : null
  return writeKnowledge(target, value, negative, previous)
}

/** What to write when an address answer is missing a part the question asked for, with an example in that shape. */
function addressAnswerHint(asked: AddressPart[]): string {
  const has = (p: AddressPart) => asked.includes(p)
  const words = { street: 'street', city: 'city', state: 'state', zip: 'ZIP code' } as const
  const list = asked.map(p => words[p])
  const named = list.length <= 1 ? list.join('') : list.length === 2 ? `${list[0]} and ${list[1]}` : `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`
  const example = [has('street') ? '123 Main St' : '', has('city') || has('state') ? [has('city') ? 'Columbus' : '', has('state') ? 'OH' : ''].filter(Boolean).join(', ') : ''].filter(Boolean).join(', ') + (has('zip') ? ' 43215' : '')
  return `Write the ${named}${list.length > 1 ? ', separated by commas' : ''}, for example: ${example.trim()}`
}

/**
 * Stores the parts of a home address as separate profile entries. Location ("Columbus, OH")
 * is written first: the resume header reads it. Returns the most complete entry written.
 */
function writeAddressParts(parts: AddressParts, source: string, opts: { onlyIfMissing?: boolean } = {}): { main: KnowledgeEntry; written: number } {
  const writes: Array<[string, string | undefined]> = [
    [ADDRESS_KNOWLEDGE_KEYS.location, parts.city && parts.state ? `${parts.city}, ${parts.state}` : undefined],
    [ADDRESS_KNOWLEDGE_KEYS.street, parts.street ? (parts.line2 ? `${parts.street}, ${parts.line2}` : parts.street) : undefined],
    [ADDRESS_KNOWLEDGE_KEYS.city, parts.city],
    [ADDRESS_KNOWLEDGE_KEYS.state, parts.state],
    [ADDRESS_KNOWLEDGE_KEYS.zip, parts.zip],
  ]
  let main: KnowledgeEntry | null = null
  let written = 0
  for (const [target, value] of writes) {
    if (!value) continue
    const i = target.indexOf(':')
    const res = setKnowledgeIfChanged(target.slice(0, i), target.slice(i + 1), value, source, opts)
    if (res.written) written++
    if (!main || target === ADDRESS_KNOWLEDGE_KEYS.street) main = res.entry
  }
  if (!main) throw createError({ statusCode: 400, statusMessage: 'No address parts found in the answer' })
  return { main, written }
}

function gapQuestionIds(app: InferSelectModel<typeof applications>): number[] {
  return (parseJson<GapAnalysis | null>(app.gapAnalysisJson, null)?.items ?? [])
    .map(i => i.questionId)
    .filter((id): id is number => typeof id === 'number')
}

/**
 * needs_input and proposed applications that wait on a question: the one that asked it
 * (application_id) plus every application whose form answers or gap analysis reference it.
 * askQuestion() dedupes by subject, so one row can serve several applications.
 */
export function waitingApplicationIds(q: QuestionRow, waiting = useDb().select().from(applications).where(inArray(applications.status, WAITING_STATUSES)).all()): number[] {
  return waiting
    .filter(a => a.id === q.applicationId || referencedQuestionIds(a).includes(q.id) || gapQuestionIds(a).includes(q.id))
    .map(a => a.id)
}

/** needs_input and proposed applications with an optional field that was asked as this question without blocking. */
function optionalAskApplicationIds(questionId: number): number[] {
  const marker = `Optional: asked you as question #${questionId}`
  return useDb().select().from(applications).where(inArray(applications.status, WAITING_STATUSES)).all()
    .filter(a => parseJson<FormAnswer[]>(a.answersJson, []).some(x => x.sourceDetail === marker))
    .map(a => a.id)
}

async function refreshWaitingApplications(ids: number[]): Promise<{ refreshed: number[]; unavailable: boolean }> {
  if (ids.length === 0) return { refreshed: [], unavailable: false }
  // refreshApplicationAnswers(applicationId) is built by the apply unit in server/utils/apply/index.ts.
  // Nitro auto-imports every export under server/utils, so once that file is merged the name below
  // resolves to it. On a build without it the name is undeclared and typeof returns 'undefined'.
  // @ts-ignore: declared only on builds that include the apply unit
  const refresh = (typeof refreshApplicationAnswers === 'function' ? refreshApplicationAnswers : null) as ((applicationId: number) => Promise<unknown>) | null
  if (!refresh) {
    console.warn(`[questions] refreshApplicationAnswers is not on this build; applications ${ids.join(', ')} keep their old answers until it is`)
    return { refreshed: [], unavailable: true }
  }
  const refreshed: number[] = []
  for (const id of ids) {
    try {
      await refresh(id)
      refreshed.push(id)
    }
    catch (e) {
      console.error(`[questions] refreshApplicationAnswers(${id}) failed`, e)
    }
  }
  return { refreshed, unavailable: false }
}

/** Jobs whose score can depend on this answer. */
function affectedJobIds(q: QuestionRow, applicationIds: number[]): number[] | 'open' {
  if (q.subject === COMP_FLOOR_SUBJECT) return 'open'
  const db = useDb()
  const ids = new Set<number>()
  if (q.jobId) {
    const job = db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, q.jobId)).get()
    if (job && !CLOSED_JOB_STATUSES.includes(job.status)) ids.add(q.jobId)
  }
  if (applicationIds.length) {
    for (const a of db.select({ jobId: applications.jobId }).from(applications).where(inArray(applications.id, applicationIds)).all()) ids.add(a.jobId)
  }
  const term = q.subject ? ruleTerm(q.subject) : ''
  if (term && (q.kind === 'knows' || q.kind === 'has_done')) {
    const open = db.select({ id: jobs.id, requirementsJson: jobs.requirementsJson }).from(jobs).where(notInArray(jobs.status, CLOSED_JOB_STATUSES)).all()
    for (const j of open) {
      const text = parseJson<Requirement[]>(j.requirementsJson, []).map(r => r.text).join('\n').toLowerCase()
      if (text && ruleWordMatch(text, term)) ids.add(j.id)
    }
  }
  return [...ids]
}

export function toQuestionListItem(
  q: QuestionRow,
  job: { id: number; title: string; company: string } | null,
  waitingIds: number[],
  waitingApplications?: Array<{ id: number; company: string; title: string }>,
  example: string | null = null,
  repoSuggestion: QuestionListItem['repoSuggestion'] = null,
): QuestionListItem {
  return {
    id: q.id,
    question: q.question,
    context: q.context,
    category: q.category,
    kind: q.kind,
    subject: q.subject,
    answerType: (q.answerType as QuestionListItem['answerType']) ?? null,
    choices: parseJson<string[] | null>(q.choicesJson, null),
    knowledgeKey: q.knowledgeKey,
    blocking: q.blocking,
    status: q.status,
    answer: q.answer,
    example,
    takesExample: takesExample(q),
    askedAt: q.askedAt,
    answeredAt: q.answeredAt,
    applicationId: q.applicationId,
    jobId: q.jobId,
    job,
    waitingApplicationIds: waitingIds,
    ...(waitingApplications ? { waitingApplications } : {}),
    legacy: isLegacyQuestion(q),
    repoSuggestion: q.status === 'pending' && takesExample(q) ? repoSuggestion : null,
  }
}

/** Questions for the /questions page, or for one application (asked by it or referenced by its answers). */
export function listQuestionItems(filter: { status?: string; applicationId?: number } = {}): QuestionListItem[] {
  const db = useDb()
  let rows = db.select().from(questions).all()
  if (filter.status) rows = rows.filter(q => q.status === filter.status)
  if (filter.applicationId) {
    const app = db.select().from(applications).where(eq(applications.id, filter.applicationId)).get()
    const refs = new Set(app ? [...referencedQuestionIds(app), ...gapQuestionIds(app)] : [])
    rows = rows.filter(q => q.applicationId === filter.applicationId || refs.has(q.id))
  }
  const waiting = db.select().from(applications).where(inArray(applications.status, WAITING_STATUSES)).all()
  const appIds = [...new Set(rows.map(q => q.applicationId).filter((id): id is number => id != null))]
  const appJob = new Map(appIds.length
    ? db.select({ id: applications.id, jobId: applications.jobId }).from(applications).where(inArray(applications.id, appIds)).all().map(a => [a.id, a.jobId] as const)
    : [])
  const jobIds = [...new Set(rows.map(q => q.jobId ?? (q.applicationId ? appJob.get(q.applicationId) : undefined)).filter((id): id is number => id != null))]
  const jobById = new Map(jobIds.length
    ? db.select({ id: jobs.id, title: jobs.title, company: jobs.company }).from(jobs).where(inArray(jobs.id, jobIds)).all().map(j => [j.id, j] as const)
    : [])
  const waitingJob = new Map(waiting.length
    ? db.select({ id: jobs.id, title: jobs.title, company: jobs.company }).from(jobs).where(inArray(jobs.id, [...new Set(waiting.map(a => a.jobId))])).all().map(j => [j.id, j] as const)
    : [])
  const named = (ids: number[]) => ids.map((id) => {
    const job = waitingJob.get(waiting.find(a => a.id === id)!.jobId)
    return { id, company: job?.company ?? '', title: job?.title ?? '' }
  })
  const knowledge = rows.some(q => q.status === 'answered' && takesExample(q)) ? loadKnowledge() : []
  const suggestions = repoSuggestionsFor(rows.filter(q => q.status === 'pending' && takesExample(q)).map(q => q.id))
  return rows
    .map((q) => {
      const jobId = q.jobId ?? (q.applicationId ? appJob.get(q.applicationId) : undefined)
      const waitingIds = q.status === 'pending' ? waitingApplicationIds(q, waiting) : []
      return toQuestionListItem(q, jobId != null ? jobById.get(jobId) ?? null : null, waitingIds, named(waitingIds), questionExample(q, knowledge), suggestions.get(q.id) ?? null)
    })
    .sort((a, b) => Number(b.blocking || b.waitingApplicationIds.length > 0) - Number(a.blocking || a.waitingApplicationIds.length > 0)
      || Number(a.legacy) - Number(b.legacy)
      || b.askedAt.localeCompare(a.askedAt)
      || b.id - a.id)
}

function questionItem(id: number): QuestionListItem {
  const item = listQuestionItems().find(q => q.id === id)
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Question not found' })
  return item
}

/**
 * Devin's answer to one question:
 * 1. writes the knowledge base (a No too, so the pipeline never asks again and never claims it)
 * 2. marks the question answered and records where the answer went
 * 3. refreshes every application waiting on it (refreshApplicationAnswers from the apply unit)
 * 4. rescores the jobs the answer can change
 * Answering an already answered question replaces the old answer.
 *
 * `example` is Devin's own description of where he did it, for a Yes or Some experience answer to a
 * skill or experience question. A string sets it (blank clears it), null clears it, and undefined
 * keeps the one already saved, so changing Yes to Some experience does not lose it. The review card
 * cannot send a separate field through its parents, so for a yes or no question an answer with more
 * than one line ("Yes\n<example>") is read as the answer on its first line and the example after it.
 */
export async function answerQuestion(id: number, rawAnswer: string, example?: string | null): Promise<AnswerOutcome> {
  const db = useDb()
  const q = db.select().from(questions).where(eq(questions.id, id)).get()
  if (!q) throw createError({ statusCode: 404, statusMessage: 'Question not found' })
  let answer = (rawAnswer ?? '').toString().trim()
  if (q.answerType === 'yes_no' && example === undefined && answer.includes('\n')) {
    const nl = answer.indexOf('\n')
    example = answer.slice(nl + 1)
    answer = answer.slice(0, nl).trim()
  }
  if (!answer) throw createError({ statusCode: 400, statusMessage: 'Type an answer, or skip the question' })
  if (answer.length > 4000) throw createError({ statusCode: 400, statusMessage: 'Keep the answer under 4,000 characters' })
  // Trimmed only: the example is stored in his own words.
  const exampleText = typeof example === 'string' ? example.trim() : example
  if (exampleText && !takesExample(q)) {
    throw createError({ statusCode: 400, statusMessage: 'Only a Yes or Some experience answer about a skill or past work takes an example' })
  }
  if (exampleText && exampleText.length > EXAMPLE_MAX_CHARS) {
    throw createError({ statusCode: 400, statusMessage: `Keep the example under ${EXAMPLE_MAX_CHARS.toLocaleString('en-US')} characters` })
  }

  let normalized = answer
  let savedExample: string | null = null
  if (q.answerType === 'yes_no') {
    const yn = parseYesNo(answer)
    if (!yn) throw createError({ statusCode: 400, statusMessage: 'Answer Yes, No, or Some experience' })
    normalized = YES_NO_LABELS[yn]
    if (exampleText && yn === 'no') throw createError({ statusCode: 400, statusMessage: 'A No answer takes no example' })
    if (takesExample(q) && yn !== 'no') savedExample = exampleText === undefined ? questionExample(q) : (exampleText || null)
  }
  else if (q.answerType === 'number') {
    const n = parseMoney(answer)
    if (n == null) throw createError({ statusCode: 400, statusMessage: 'Enter a number, for example 150000' })
    normalized = String(n)
  }
  else if (q.answerType === 'choice') {
    const choices = parseJson<string[]>(q.choicesJson, [])
    if (choices.length && !choices.includes(answer)) throw createError({ statusCode: 400, statusMessage: `Pick one of: ${choices.join(', ')}` })
  }

  const entry = writeAnswerKnowledge(q, normalized, savedExample)
  // The same answer again (an example added or changed) changes no form answer and no score:
  // forms read the answer itself, and scores read whether he has it. Its answered date stays too.
  // One exception: a form field that still waits on this question (the card shows it again under
  // Answer first) is re-derived, or answering it again would do nothing.
  if (q.status === 'answered' && q.answer === normalized) {
    db.update(questions).set({ knowledgeKey: `${entry.category}:${entry.key}` }).where(eq(questions.id, id)).run()
    const stillWaiting = waitingApplicationIds(q).filter(appId => {
      const app = db.select({ answersJson: applications.answersJson }).from(applications).where(eq(applications.id, appId)).get()
      return parseJson<FormAnswer[]>(app?.answersJson, []).some(a => a.needsQuestionId === id)
    })
    const again = await refreshWaitingApplications(stillWaiting)
    return {
      question: questionItem(id),
      knowledge: { category: entry.category, key: entry.key, value: entry.value },
      refreshedApplicationIds: again.refreshed,
      refreshUnavailable: again.unavailable,
      rescored: 0,
    }
  }
  const waiting = waitingApplicationIds(q)
  // Optional fields asked without blocking ("Optional: asked you as question #N") fill in too.
  const toRefresh = [...new Set([...waiting, ...optionalAskApplicationIds(q.id)])]
  db.update(questions).set({
    status: 'answered',
    answer: normalized,
    answeredAt: nowSql(),
    knowledgeKey: `${entry.category}:${entry.key}`,
  }).where(eq(questions.id, id)).run()

  const { refreshed, unavailable } = await refreshWaitingApplications(toRefresh)
  // Other open jobs that name this skill get their skills judged again on the next scheduled run.
  if (q.kind === 'knows' || q.kind === 'has_done') {
    applyAnswerToOpenJobs(q.subject, normalized, `${entry.category}/${entry.key}`)
    queueSkillRescore(q.subject, q.jobId ? [q.jobId] : [])
  }
  const affected = affectedJobIds(q, waiting)
  const rescored = affected === 'open' || affected.length
    ? (await rescoreJobs(affected, 'rescore')).rescored
    : 0

  return {
    question: questionItem(id),
    knowledge: { category: entry.category, key: entry.key, value: entry.value },
    refreshedApplicationIds: refreshed,
    refreshUnavailable: unavailable,
    rescored,
  }
}

/** Adds or changes the example on an answered Yes or Some experience question, keeping the answer. */
export async function setQuestionExample(id: number, example: string): Promise<AnswerOutcome> {
  const q = useDb().select().from(questions).where(eq(questions.id, id)).get()
  if (!q) throw createError({ statusCode: 404, statusMessage: 'Question not found' })
  const yn = q.status === 'answered' && q.answer ? parseYesNo(q.answer) : null
  if (!takesExample(q) || !yn || yn === 'no') {
    throw createError({ statusCode: 409, statusMessage: 'Only an answered Yes or Some experience question about a skill or past work takes an example' })
  }
  if (!example.trim()) throw createError({ statusCode: 400, statusMessage: 'Type the example, or cancel' })
  return await answerQuestion(id, q.answer!, example)
}

/** Skip for now. A later pipeline run may ask again; askQuestion() only dedupes pending and answered rows. */
export function skipQuestion(id: number): QuestionListItem {
  const db = useDb()
  const q = db.select().from(questions).where(eq(questions.id, id)).get()
  if (!q) throw createError({ statusCode: 404, statusMessage: 'Question not found' })
  db.update(questions).set({ status: 'skipped' }).where(eq(questions.id, id)).run()
  return questionItem(id)
}

/** Puts a skipped question back in the pending list. */
export function reopenQuestion(id: number): QuestionListItem {
  const db = useDb()
  const q = db.select().from(questions).where(eq(questions.id, id)).get()
  if (!q) throw createError({ statusCode: 404, statusMessage: 'Question not found' })
  if (q.status !== 'skipped') throw createError({ statusCode: 409, statusMessage: 'Only a skipped question can be reopened' })
  db.update(questions).set({ status: 'pending' }).where(eq(questions.id, id)).run()
  return questionItem(id)
}

// ── Plain questions other units ask ──

export interface AskOptions {
  context?: string
  applicationId?: number
  jobId?: number
  blocking?: boolean
}

/** "Do you know Go?" Returns null when the knowledge base already says, yes or no. */
export function askKnows(rawSubject: string, opts: AskOptions = {}): QuestionRow | null {
  const subject = cleanSkillSubject(rawSubject)
  if (!subject || knowledgeCovers(subject)) return null
  return askQuestion({
    question: knowsQuestionText(subject),
    context: opts.context,
    kind: 'knows',
    subject,
    answerType: 'yes_no',
    knowledgeKey: `skill:${subject}`,
    applicationId: opts.applicationId,
    jobId: opts.jobId,
    blocking: opts.blocking,
    category: 'technical',
  })
}

/** "Have you led a team of five or more engineers?" Returns null when the knowledge base already says. */
export function askHasDone(subject: string, question: string, opts: AskOptions = {}): QuestionRow | null {
  if (knowledgeCovers(subject)) return null
  return askQuestion({
    question,
    context: opts.context,
    kind: 'has_done',
    subject,
    answerType: 'yes_no',
    knowledgeKey: `experience:Has done: ${subject}`,
    applicationId: opts.applicationId,
    jobId: opts.jobId,
    blocking: opts.blocking,
    category: 'technical',
  })
}

/** The lowest total yearly compensation Devin said he would accept, or null if he has not said. */
export function compensationFloor(): number | null {
  const e = findKnowledgeEntry('preference', COMP_FLOOR_KEY.slice(COMP_FLOOR_KEY.indexOf(':') + 1))
  const fromKb = e?.value.match(/\$\s?([\d,]+)/)
  if (fromKb) return Number(fromKb[1]!.replace(/,/g, ''))
  const answered = answeredValue('preference', COMP_FLOOR_SUBJECT)
  return answered ? parseMoney(answered) : null
}

/** "What is the lowest total yearly compensation you would accept?" Null when already answered. */
export function askCompFloor(opts: AskOptions = {}): QuestionRow | null {
  if (compensationFloor() != null) return null
  return askQuestion({
    question: 'What is the lowest total yearly compensation you would accept?',
    context: opts.context ?? 'Base salary plus bonus, equity, and benefits, in US dollars per year. Jobs below it score lower.',
    kind: 'preference',
    subject: COMP_FLOOR_SUBJECT,
    answerType: 'number',
    knowledgeKey: COMP_FLOOR_KEY,
    applicationId: opts.applicationId,
    jobId: opts.jobId,
    blocking: opts.blocking,
    category: 'preference',
  })
}

/**
 * Not a daily quota: every skill worth asking is asked as soon as the jobs that need it are
 * scored. This only stops a runaway (a bad parse of many postings); the rest wait for the next run.
 */
const MAX_NEW_SKILL_QUESTIONS_PER_RUN = 40

/** Skill questions come only from open jobs scoring at least this; the prepare threshold is 70. */
const QUESTION_SCORE_FLOOR = 50

/**
 * Called by learn:daily. Asks for the pay floor when it is unknown, and asks "Do you know X?"
 * for short technology requirements that open real jobs need and the knowledge base does not
 * cover (a must-have in one job, or any requirement in two or more). At most five new per day.
 * Sandbox jobs never create questions.
 */
/**
 * Keeps "knows" questions plain and unique. Runs before each day's new questions and is safe to
 * repeat. Every pending, non-blocking "knows" question gets its skill name cleaned
 * ("2+ years of experience with LangChain" becomes LangChain, "Golang" becomes Go), then:
 * - skipped when it is not a skill worth asking (English, communication) or the knowledge base
 *   already covers it (HTML is implied by JavaScript and CSS);
 * - skipped when an answered question or an older pending one already asks the same thing;
 * - otherwise reworded in plain language.
 * Questions an application waits on are never touched. Skipped questions can be reopened.
 */
export function tidyKnowsQuestions(): { reworded: number; skipped: number } {
  const db = useDb()
  const rows = db.select().from(questions).where(and(eq(questions.kind, 'knows'), inArray(questions.status, ['pending', 'answered']))).all()
  const cleanOf = (q: QuestionRow) => cleanSkillSubject(q.subject || q.question.replace(/^(Do you know|Have you (used|worked with))\s+/, '').replace(/( in a real project)?\?$/, ''))
  const taken = new Set<string>()
  const overlaps = (subject: string) => taken.has(ruleTerm(subject)) || subject.split(/\s+/).some(w => w.length > 1 && taken.has(ruleTerm(w)))
  for (const q of rows.filter(r => r.status === 'answered' || r.blocking)) {
    const c = cleanOf(q)
    if (c) taken.add(ruleTerm(c))
    if (q.subject) taken.add(ruleTerm(q.subject))
  }
  let reworded = 0
  let skipped = 0
  for (const q of rows.filter(r => r.status === 'pending' && !r.blocking).sort((a, b) => a.id - b.id)) {
    const subject = cleanOf(q)
    const term = subject ? ruleTerm(subject) : null
    if (!subject || !term || knowledgeCovers(subject) || overlaps(subject)) {
      db.update(questions).set({ status: 'skipped' }).where(eq(questions.id, q.id)).run()
      skipped++
      continue
    }
    taken.add(term)
    const text = q.question.startsWith('Do you know ') || q.question.startsWith('Have you used ') || q.question.startsWith('Have you worked with ')
      ? knowsQuestionText(subject)
      : q.question
    if (text !== q.question || subject !== q.subject) {
      db.update(questions).set({ question: text, subject, dedupeKey: dedupeKeyOf('knows', subject), knowledgeKey: `skill:${subject}` }).where(eq(questions.id, q.id)).run()
      reworded++
    }
  }
  return { reworded, skipped }
}

/** Closes pending gap questions about profile facts (NOT_A_GAP). Idempotent. */
export function closeNonGapQuestions(): number {
  const db = useDb()
  const rows = db.select().from(questions)
    .where(and(eq(questions.status, 'pending'), inArray(questions.kind, ['has_done', 'knows'])))
    .all()
    .filter(q => NOT_A_GAP.test(`${q.subject ?? ''} ${q.question}`))
  for (const q of rows) {
    const note = 'Closed: work authorization, location, and education come from your profile, not from a skill question.'
    db.update(questions).set({ status: 'skipped', blocking: false, context: `${note}${q.context ? ` ${q.context}` : ''}` }).where(eq(questions.id, q.id)).run()
  }
  return rows.length
}

/** Gap question context: what the answer changes, depending on whether code could show the skill. */
export const GAP_CONTEXT_CODE = 'Your answer decides whether the resume and letter can mention it, and whether a small demo project should be built.'
export const GAP_CONTEXT_EXPERIENCE = 'Your answer decides whether the resume and letter can mention it. A code project cannot show this, so no demo is built either way.'
/** Every gap question carried this before the code-or-experience split, even for experience no project can show. */
const GAP_CONTEXT_LEGACY = 'The answer decides whether a demo project should be built.'
const GAP_CONTEXT_NEUTRAL = 'Your answer decides whether the resume and letter can mention it, and, for a skill a code project can show, whether a demo is built.'

/** Rewords the old gap-question sentence on pending questions. Idempotent. */
export function rewordLegacyGapContexts(): number {
  return useDb().update(questions)
    .set({ context: sql`replace(${questions.context}, ${GAP_CONTEXT_LEGACY}, ${GAP_CONTEXT_NEUTRAL})` })
    .where(and(eq(questions.status, 'pending'), sql`${questions.context} like ${'%' + GAP_CONTEXT_LEGACY + '%'}`))
    .run().changes
}

export function askDailyQuestions(): QuestionRow[] {
  const db = useDb()
  rewordLegacyGapContexts()
  closeNonGapQuestions()
  tidyKnowsQuestions()
  const before = new Set(db.select({ id: questions.id }).from(questions).all().map(r => r.id))
  const created: QuestionRow[] = []
  const floor = askCompFloor()
  if (floor && !before.has(floor.id)) created.push(floor)

  const open = db.select({ id: jobs.id, requirementsJson: jobs.requirementsJson, isSandbox: jobs.isSandbox, matchScore: jobs.matchScore })
    .from(jobs).where(notInArray(jobs.status, CLOSED_JOB_STATUSES)).all()
    // Only jobs worth applying to: below this score no answer would bring a job near the
    // prepare threshold, and those postings are where the noise comes from.
    .filter(j => !j.isSandbox && j.requirementsJson && j.matchScore != null && j.matchScore >= QUESTION_SCORE_FLOOR)
  const scoreOf = new Map(open.map(j => [j.id, j.matchScore]))
  const wanted = new Map<string, { subject: string; jobs: Set<number>; mustHave: boolean; firstJob: number; value: number }>()
  for (const j of open) {
    for (const r of parseJson<Requirement[]>(j.requirementsJson, [])) {
      if (r.status !== 'unknown' || !['language', 'framework', 'skill'].includes(r.kind)) continue
      const subject = cleanSkillSubject(r.text)
      if (!subject) continue
      const key = ruleTerm(subject)
      const w = wanted.get(key) ?? { subject, jobs: new Set<number>(), mustHave: false, firstJob: j.id, value: 0 }
      if (!w.jobs.has(j.id)) {
        w.jobs.add(j.id)
        // How much the answer is worth: better-matching jobs count more, and a must-have more
        // than a nice-to-have. Unscored jobs count as middling.
        w.value += ((scoreOf.get(j.id) ?? QUESTION_SCORE_FLOOR) / 100) * (r.mustHave ? 1.5 : 1)
      }
      w.mustHave ||= r.mustHave
      wanted.set(key, w)
    }
  }
  const candidates = [...wanted.values()]
    .filter(w => w.mustHave || w.jobs.size >= 2)
    .sort((a, b) => b.value - a.value || b.jobs.size - a.jobs.size)
  const asked = new Set(db.select({ subject: questions.subject }).from(questions).where(eq(questions.kind, 'knows')).all().map(r => r.subject).filter(Boolean).map(x => ruleTerm(x!)))
  for (const c of candidates) {
    if (created.length >= MAX_NEW_SKILL_QUESTIONS_PER_RUN) break
    if (asked.has(ruleTerm(c.subject)) || c.subject.split(/\s+/).some(w => w.length > 1 && asked.has(ruleTerm(w)))) continue
    const row = askKnows(c.subject, {
      jobId: c.firstJob,
      context: `${c.jobs.size === 1 ? 'An open job asks' : `${c.jobs.size} open jobs ask`} for ${c.subject.replace(/[.\s]+$/, '')}. Your answer goes into your knowledge base. A No means it is never claimed.`,
    })
    if (row && !before.has(row.id)) created.push(row)
  }
  return created
}

// ── One question per fact: reuse before asking, and merge what was asked twice ──

/** Note the tidy puts at the start of a merged duplicate's context. */
const MERGED_NOTE = /^Merged into question #(\d+)/

export function mergedIntoId(q: Pick<QuestionRow, 'status' | 'context'>): number | null {
  if (q.status !== 'skipped') return null
  const m = (q.context ?? '').match(MERGED_NOTE)
  return m ? Number(m[1]) : null
}

/** The question a merged duplicate now points to, following the merge notes. Null when the chain ends on a skipped question. */
export function canonicalQuestion(id: number): QuestionRow | null {
  const db = useDb()
  let q = db.select().from(questions).where(eq(questions.id, id)).get() ?? null
  for (let hops = 0; q && hops < 10; hops++) {
    if (q.status === 'pending' || q.status === 'answered') return q
    const next = mergedIntoId(q)
    if (!next) return null
    q = db.select().from(questions).where(eq(questions.id, next)).get() ?? null
  }
  return null
}

const SHARED_FACT_CONTEXT = 'Application forms ask for this.'
export const ADDRESS_CONTEXT = 'Asked once for every form that wants any part of your home address. The answer is saved to your knowledge base as separate street, city, state, and ZIP entries and fills every address field.'

function sharedContext(def: FactDef | null): string {
  return isAddressFact(def)
    ? ADDRESS_CONTEXT
    : `${SHARED_FACT_CONTEXT} Your answer is saved to the knowledge base and fills every form that asks.`
}

// Decisions of the semantic check, one per normalized label, so a label never costs a second call.
// A JSON file next to the database: there is no table for it and the schema is not changed for it.

interface LabelDecision {
  /** "none", "Q<id>" (an existing question), or "K:<category>/<key>" (a profile knowledge entry). */
  match: string
  at: string
}

let labelCache: Record<string, LabelDecision> | null = null

function labelCachePath() {
  return dataPath('question-label-matches.json')
}

function loadLabelCache(): Record<string, LabelDecision> {
  if (labelCache) return labelCache
  const path = labelCachePath()
  labelCache = {}
  if (existsSync(path)) {
    try {
      labelCache = JSON.parse(readFileSync(path, 'utf8')) as Record<string, LabelDecision>
    }
    catch (e) {
      console.error(`[questions] ${path} is not valid JSON; starting a new label cache`, e)
    }
  }
  return labelCache
}

function saveLabelCache() {
  const path = labelCachePath()
  writeFileSync(`${path}.tmp`, JSON.stringify(labelCache ?? {}, null, 2))
  renameSync(`${path}.tmp`, path)
}

export type LabelMatch =
  | { type: 'question'; question: QuestionRow }
  | { type: 'knowledge'; entry: KnowledgeEntry }
  | { type: 'none' }

const MatchSchema = z.object({
  matches: z.array(z.object({
    item: z.string().describe('The item id, e.g. "L1"'),
    match: z.string().describe('"Q<id>" of the existing question that asks for the same information, "K<n>" of the profile entry that answers it as written, or "none"'),
  })),
})

const MATCH_SYSTEM = `You keep a job applicant from being asked the same thing twice. Each ITEM is a label from an application form. Decide whether an EXISTING QUESTION already asks for the same information, or a PROFILE ENTRY already holds it.
Match only when one answer would answer both as written: same fact, same scope, same person.
- "What city and state do you live in now?" and "Where are you currently based?" match.
- "Street address" and "City" do not match (different parts).
- "Tell us about your AI experience" and "Have you used OpenAI?" do not match (one is broader).
- A question about a reference, a referrer, or an emergency contact never matches the applicant's own details.
When unsure, answer "none".`

function resolveDecision(match: string, selfId?: number): LabelMatch {
  const q = match.match(/^Q(\d+)$/)
  if (q) {
    const row = canonicalQuestion(Number(q[1]))
    return row && row.id !== selfId ? { type: 'question', question: row } : { type: 'none' }
  }
  const k = match.match(/^K:([^/]+)\/(.+)$/)
  if (k) {
    const entry = findKnowledgeEntry(k[1]!, k[2]!)
    return entry ? { type: 'knowledge', entry } : { type: 'none' }
  }
  return { type: 'none' }
}

/**
 * The semantic duplicate check: for each label, an existing pending or answered fact or
 * form_field question that asks the same thing, or a profile entry that already answers it.
 * One call to the fallback (cheap) model for every label not already decided; decisions are
 * cached per normalized label. `selfId` excludes a question from matching itself, and only an
 * older question can absorb a newer one. Any failure (no credit, budget, a bad reply) means
 * "none": the caller asks as before, and the error is returned so the run log shows it.
 */
export async function matchLabelsToExisting(
  checks: Array<{ label: string; question?: string; selfId?: number }>,
  ref?: { type: string; id: number },
): Promise<{ results: LabelMatch[]; called: boolean; error: string | null }> {
  const cache = loadLabelCache()
  const results: LabelMatch[] = checks.map(() => ({ type: 'none' }))
  const open: number[] = []
  checks.forEach((c, i) => {
    const hit = cache[labelText(c.label)]
    if (hit) results[i] = resolveDecision(hit.match, c.selfId)
    else open.push(i)
  })
  if (open.length === 0) return { results, called: false, error: null }

  const db = useDb()
  const candidates = db.select().from(questions)
    .where(and(inArray(questions.kind, ['fact', 'form_field']), inArray(questions.status, ['pending', 'answered'])))
    .all()
  const profile = loadKnowledge('profile')
  const now = nowSql()
  const decide = (i: number, match: string) => {
    cache[labelText(checks[i]!.label)] = { match, at: now }
    results[i] = resolveDecision(match, checks[i]!.selfId)
  }
  const usable = (i: number) => candidates.filter(q => checks[i]!.selfId === undefined || q.id < checks[i]!.selfId!)
  if (open.every(i => usable(i).length === 0) && profile.length === 0) {
    for (const i of open) decide(i, 'none')
    saveLabelCache()
    return { results, called: false, error: null }
  }

  let reply: z.infer<typeof MatchSchema>
  try {
    reply = await aiStructured(MatchSchema, {
      purpose: 'question_match',
      model: fallbackModel(),
      effort: 'low',
      maxTokens: 1500,
      ref,
      system: MATCH_SYSTEM,
      prompt: `ITEMS
${open.map((i, n) => `L${n + 1}: ${checks[i]!.label}${checks[i]!.question && checks[i]!.question !== checks[i]!.label ? ` (asked as: ${checks[i]!.question})` : ''}${checks[i]!.selfId ? ` [this is question Q${checks[i]!.selfId}; only match an older question]` : ''}`).join('\n')}

EXISTING QUESTIONS
${candidates.map(q => `Q${q.id}: ${q.question}${q.subject && q.subject !== q.question ? ` (form label: ${q.subject})` : ''}${q.status === 'answered' ? ' [answered]' : ''}`).join('\n') || '(none)'}

PROFILE ENTRIES
${profile.map((e, n) => `K${n + 1}: ${e.key}`).join('\n') || '(none)'}`,
    })
  }
  catch (e: any) {
    const error = `${e?.constructor?.name ?? 'Error'}: ${e?.message ?? e}`
    console.warn(`[questions] semantic duplicate check failed, so these labels are asked as new questions: ${open.map(i => checks[i]!.label).join(' | ')}. ${error}`)
    return { results, called: true, error }
  }
  open.forEach((i, n) => {
    const raw = (reply.matches.find(m => m.item.trim().toUpperCase() === `L${n + 1}`)?.match ?? 'none').trim().toUpperCase()
    const q = raw.match(/^Q(\d+)$/)
    const k = raw.match(/^K(\d+)$/)
    if (q && usable(i).some(c => c.id === Number(q[1]))) decide(i, `Q${q[1]}`)
    else if (k && profile[Number(k[1]) - 1]) decide(i, `K:profile/${profile[Number(k[1]) - 1]!.key}`)
    else decide(i, 'none')
  })
  saveLabelCache()
  return { results, called: true, error: null }
}

export interface AskRequest {
  /** The form label that needs the answer. */
  label: string
  input: AskInput
  /** True when the registry in facts.ts chose this question (fixed subject, so no semantic check). */
  registry: boolean
  /** The registry fact the field asks for, e.g. "address.city". */
  factKey?: string
}

export type AskOutcome = { question: QuestionRow } | { knowledge: KnowledgeEntry }

function markBlocking(q: QuestionRow, blocking: boolean | undefined): QuestionRow {
  if (!blocking || q.blocking || q.status !== 'pending') return q
  useDb().update(questions).set({ blocking: true }).where(eq(questions.id, q.id)).run()
  return { ...q, blocking: true }
}

/**
 * Older questions about the same fact that the registry's own question would duplicate: pending
 * ones that share its question (every address part shares the address question), and answered
 * ones about exactly this fact. An answered street question never stands in for the city.
 */
function questionsForAsk(subject: string, kind: string, factKey?: string): QuestionRow[] {
  return useDb().select().from(questions)
    .where(and(inArray(questions.kind, ['fact', 'form_field', 'preference']), inArray(questions.status, ['pending', 'answered'])))
    .all()
    .filter((q) => {
      const def = factForQuestion(q)
      if (!def?.ask || def.ask.subject !== subject || def.ask.kind !== kind) return false
      return q.status === 'pending' || def.key === factKey
    })
    .sort((a, b) => Number(b.status === 'answered') - Number(a.status === 'answered') || a.id - b.id)
}

/**
 * askQuestion() for many fields at once, with the checks that stop a second question about the
 * same thing. In order: the registry's fixed question (or any older question about the same fact);
 * an existing question with the same wording; a merged duplicate's canonical question; the
 * per-label decision cache; one semantic check with the fallback model. Only then is a question
 * created. An outcome is either a question to wait on or use, or a profile entry that answers it.
 */
export async function askOrReuse(requests: AskRequest[], ref?: { type: string; id: number }): Promise<{ outcomes: AskOutcome[]; semanticError: string | null }> {
  const db = useDb()
  const outcomes: Array<AskOutcome | null> = requests.map(() => null)
  const semantic: number[] = []
  requests.forEach((r, i) => {
    const dedupeKey = dedupeKeyOf(r.input.kind, r.input.subject)
    const exact = db.select().from(questions).where(and(eq(questions.dedupeKey, dedupeKey), inArray(questions.status, ['pending', 'answered']))).all()
    if (r.registry) {
      const same = exact.length ? [] : questionsForAsk(r.input.subject, r.input.kind, r.factKey)
      if (same.length) {
        outcomes[i] = { question: markBlocking(same[0]!, r.input.blocking) }
        return
      }
      const q = askQuestion(r.input)
      // The address question names only the parts still missing; keep the open one current.
      if (q.status === 'pending' && isAddressQuestion(q) && q.question !== r.input.question) {
        db.update(questions).set({ question: r.input.question }).where(eq(questions.id, q.id)).run()
        outcomes[i] = { question: { ...q, question: r.input.question } }
        return
      }
      outcomes[i] = { question: q }
      return
    }
    if (exact.length) {
      outcomes[i] = { question: askQuestion(r.input) }
      return
    }
    const merged = db.select().from(questions).where(and(eq(questions.dedupeKey, dedupeKey), eq(questions.status, 'skipped'))).all()
      .map(q => (mergedIntoId(q) ? canonicalQuestion(q.id) : null)).find(Boolean)
    if (merged) {
      outcomes[i] = { question: markBlocking(merged, r.input.blocking) }
      return
    }
    semantic.push(i)
  })

  let semanticError: string | null = null
  if (semantic.length) {
    const { results, error } = await matchLabelsToExisting(semantic.map(i => ({ label: requests[i]!.label, question: requests[i]!.input.question })), ref)
    semanticError = error
    semantic.forEach((i, n) => {
      const m = results[n]!
      if (m.type === 'question') outcomes[i] = { question: markBlocking(m.question, requests[i]!.input.blocking) }
      else if (m.type === 'knowledge') outcomes[i] = { knowledge: m.entry }
      else outcomes[i] = { question: askQuestion(requests[i]!.input) }
    })
  }
  return { outcomes: outcomes as AskOutcome[], semanticError }
}

// ── The tidy ──

export interface FactTidyResult {
  /** Duplicates skipped, with the question each was merged into. */
  merged: Array<{ id: number; into: number }>
  /** Questions answered from the knowledge base, with the derived answer. */
  derived: Array<{ id: number; answer: string; from: string }>
  /** Canonical questions reworded or given the shared context. */
  reworded: number[]
  /** Address parts written to the knowledge base because they were derivable but not stored. */
  knowledgeWritten: number
  /** Waiting applications whose form answers were pointed at a canonical question. */
  repointed: number[]
  refreshed: number[]
  semanticCalled: boolean
  semanticError: string | null
}

/**
 * The knowledge key an auto-answered question shows ("Saved to your knowledge base as ..."): its
 * own store key when that entry exists, else profile:Location for the location-like address facts
 * the tidy stores as Location. Null keeps the question's key.
 */
function derivedKnowledgeKey(def: FactDef, store: string | null): string | null {
  const exists = (key: string) => {
    const i = key.indexOf(':')
    return !!findKnowledgeEntry(key.slice(0, i), key.slice(i + 1))
  }
  if (store && exists(store)) return store
  if (isAddressFact(def) && exists(ADDRESS_KNOWLEDGE_KEYS.location)) return ADDRESS_KNOWLEDGE_KEYS.location
  return null
}

function sameFactValue(def: FactDef, facts: FactValues): { value: string; detail: string } | null {
  const v = def.value(facts)
  return v ? { value: v.value, detail: v.detail } : null
}

/**
 * Keeps one question per fact. Runs in learn:daily before new questions are asked, and is safe to
 * run any number of times (a second run changes nothing):
 * 1. stores address parts the knowledge base implies but does not hold (Location, City, State),
 *    insert-only, never overwriting an entry;
 * 2. groups pending fact and form_field questions by the registry fact they ask for. A fact the
 *    knowledge base already answers groups by that fact (city and state, initials); an unknown one
 *    groups by the question that would be asked for it (every address part shares the one address
 *    question). The canonical question is the answered one, else the oldest. Every other question
 *    in the group is skipped with a note naming the canonical one;
 * 3. answers a canonical pending question the knowledge base already answers (initials from the
 *    full name), and words an open address question for only the parts still missing;
 * 4. runs the semantic check on the remaining pending form_field questions and merges a question
 *    into an older one that asks the same thing;
 * 5. points every waiting application's form answers and gap analysis at the canonical question,
 *    then refreshes those applications so the ones with nothing left to answer unblock.
 * An answered question's answer is never changed and no row is deleted. A merged duplicate that
 * is reopened by hand is merged again on the next run.
 */
export async function tidyFactQuestions(log: (m: string) => void = () => {}): Promise<FactTidyResult> {
  const db = useDb()
  const result: FactTidyResult = { merged: [], derived: [], reworded: [], knowledgeWritten: 0, repointed: [], refreshed: [], semanticCalled: false, semanticError: null }

  let facts = resolveFacts(loadKnowledge(), { answered: answeredValue })
  // 1. Address parts the stored address implies, written once so the knowledge page, the prompts,
  //    and the resume header see them. Only parts parsed from text Devin stored, never overwriting.
  if (facts['address.city']?.derived && facts['address.state']?.derived) {
    const w = writeAddressParts({ city: facts['address.city'].value, state: facts['address.state'].value }, 'inferred', { onlyIfMissing: true })
    result.knowledgeWritten = w.written
    if (w.written) facts = resolveFacts(loadKnowledge(), { answered: answeredValue })
  }

  const rows = db.select().from(questions)
    .where(and(inArray(questions.kind, ['fact', 'form_field', 'preference']), inArray(questions.status, ['pending', 'answered'])))
    .all()
    .sort((a, b) => a.id - b.id)
  const defs = new Map(rows.map(q => [q.id, factForQuestion(q)] as const))

  // 2. Groups. Answered questions only ever serve as the canonical one.
  const groups = new Map<string, QuestionRow[]>()
  for (const q of rows) {
    const def = defs.get(q.id)
    if (!def) continue
    const known = sameFactValue(def, facts)
    const key = known || q.status === 'answered' ? `fact:${def.key}` : def.ask ? `ask:${def.ask.kind}:${def.ask.subject}` : null
    if (!key) continue
    const list = groups.get(key) ?? []
    list.push(q)
    groups.set(key, list)
    // An answered question also anchors the unknown-fact group of its question, so a later pending
    // copy about the same thing merges into it instead of standing on its own. Not for the address
    // and the name: their shared question covers several facts, and an answered street question
    // must not absorb a pending city question.
    if (q.status === 'answered' && def.ask && !known && def.group !== 'address' && def.group !== 'name') {
      const askKey = `ask:${def.ask.kind}:${def.ask.subject}`
      groups.set(askKey, [...(groups.get(askKey) ?? []), q])
    }
  }

  const mergeMap = new Map<number, number>()
  const merge = (dup: QuestionRow, into: QuestionRow) => {
    if (dup.id === into.id || dup.status !== 'pending' || mergeMap.has(dup.id)) return
    const note = `Merged into question #${into.id} ("${into.question}"), which asks for the same thing. Answer that one.`
    db.update(questions).set({ status: 'skipped', blocking: false, context: `${note}${dup.context ? ` ${dup.context}` : ''}` }).where(eq(questions.id, dup.id)).run()
    mergeMap.set(dup.id, into.id)
    result.merged.push({ id: dup.id, into: into.id })
  }

  // 3. The canonical question itself: answered when the knowledge base answers it, else made the
  //    registry's question, worded for what is still missing. Settled before the duplicates are
  //    merged, so their notes quote its final wording.
  const settleCanonical = (canonical: QuestionRow) => {
    if (canonical.status !== 'pending' || mergeMap.has(canonical.id)) return
    const def = defs.get(canonical.id)!
    const known = sameFactValue(def, facts)
    if (known) {
      const store = storeKeyOf(def)
      // The Questions page says the answer was saved under the question's knowledge key, so it is:
      // insert-only, marked inferred, and never ahead of a value derived from Devin's own entries.
      if (store && !isAddressFact(def)) {
        const i = store.indexOf(':')
        if (setKnowledgeIfChanged(store.slice(0, i), store.slice(i + 1), known.value, 'inferred', { onlyIfMissing: true }).written) result.knowledgeWritten++
      }
      db.update(questions).set({
        status: 'answered',
        answer: known.value,
        answeredAt: nowSql(),
        blocking: false,
        knowledgeKey: derivedKnowledgeKey(def, store) ?? canonical.knowledgeKey,
        // The old context said an application waits on the answer; it no longer does.
        context: `Answered from your knowledge base: ${known.detail}. Answer it again to change it.`,
      }).where(eq(questions.id, canonical.id)).run()
      result.derived.push({ id: canonical.id, answer: known.value, from: known.detail })
      return
    }
    // Unknown: make it the registry's question, worded for what is still missing.
    const ask = questionFor(def, facts)
    if (!ask) return
    const next = {
      question: ask.question,
      kind: ask.kind,
      subject: ask.subject,
      dedupeKey: dedupeKeyOf(ask.kind, ask.subject),
      knowledgeKey: ask.knowledgeKey,
      answerType: ask.answerType,
      choicesJson: null as string | null,
      category: ask.category,
      context: canonical.context?.startsWith(SHARED_FACT_CONTEXT) || canonical.context === ADDRESS_CONTEXT ? canonical.context : sharedContext(def),
    }
    const changed = (Object.keys(next) as Array<keyof typeof next>).some(k => (canonical as any)[k] !== next[k])
    // A form_field question whose answer must be one of the form's options keeps them; it
    // becomes the registry question only when it is about a fact in its own words.
    if (changed && !(canonical.kind === 'form_field' && canonical.choicesJson && !isAddressFact(def))) {
      db.update(questions).set(next).where(eq(questions.id, canonical.id)).run()
      result.reworded.push(canonical.id)
    }
  }

  for (const [key, list] of groups) {
    const unique = [...new Map(list.map(q => [q.id, q])).values()]
    const pending = unique.filter(q => q.status === 'pending' && !mergeMap.has(q.id))
    if (pending.length === 0) continue
    const answered = unique.filter(q => q.status === 'answered')
    let canonical: QuestionRow
    if (key.startsWith('ask:')) {
      // The registry's own question when it exists, else an answered one, else the oldest.
      const [, kind, subject] = key.split(':') as [string, string, string]
      const own = unique.find(q => q.dedupeKey === dedupeKeyOf(kind, subject) && (q.status === 'pending' || q.status === 'answered'))
      canonical = own ?? answered[0] ?? pending[0]!
    }
    else {
      canonical = answered[0] ?? pending[0]!
    }
    settleCanonical(canonical)
    const settled = db.select().from(questions).where(eq(questions.id, canonical.id)).get() ?? canonical
    for (const q of pending) merge(q, settled)
  }

  // 4. Semantic pass over the form_field questions the registry does not cover.
  const loose = db.select().from(questions)
    .where(and(eq(questions.kind, 'form_field'), eq(questions.status, 'pending')))
    .all()
    .filter(q => !factForQuestion(q))
    .sort((a, b) => a.id - b.id)
  if (loose.length) {
    const { results, called, error } = await matchLabelsToExisting(loose.map(q => ({ label: q.subject || q.question, question: q.question, selfId: q.id })))
    result.semanticCalled = called
    result.semanticError = error
    loose.forEach((q, i) => {
      const m = results[i]!
      if (m.type === 'question' && m.question.id < q.id) merge(q, m.question)
    })
  }

  // 5. Point waiting applications at the canonical questions and refresh them.
  const touched = new Set<number>([...mergeMap.keys(), ...mergeMap.values(), ...result.derived.map(d => d.id)])
  if (touched.size === 0 && result.reworded.length === 0) {
    log('fact questions: nothing to merge or derive')
    return result
  }
  const texts = new Map<number, string | null>()
  const questionText = (id: number) => {
    if (!texts.has(id)) texts.set(id, db.select({ question: questions.question }).from(questions).where(eq(questions.id, id)).get()?.question ?? null)
    return texts.get(id)!
  }
  const resolveId = (id: number) => {
    let cur = id
    for (let hops = 0; mergeMap.has(cur) && hops < 10; hops++) cur = mergeMap.get(cur)!
    return cur
  }
  const waiting = db.select().from(applications).where(inArray(applications.status, WAITING_STATUSES)).all()
  const refresh = new Set<number>()
  for (const app of waiting) {
    const answers = parseJson<FormAnswer[]>(app.answersJson, [])
    let changed = false
    for (const a of answers) {
      // Assignments keep each answer's key order, which releaseStaleQuestions' LIKE match relies on.
      if (typeof a.needsQuestionId === 'number') {
        const to = resolveId(a.needsQuestionId)
        if (to !== a.needsQuestionId) {
          a.needsQuestionId = to
          changed = true
        }
        // The field's note names the question it waits on, in that question's current wording.
        const wording = touched.has(to) || result.reworded.includes(to) ? questionText(to) : null
        const detail = wording ? `question #${to}: ${wording}` : null
        if (detail && a.sourceDetail !== detail) {
          a.sourceDetail = detail
          changed = true
        }
        if (touched.has(to)) refresh.add(app.id)
      }
      const optional = a.sourceDetail?.match(/^Optional: asked you as question #(\d+)/)
      if (optional) {
        const to = resolveId(Number(optional[1]))
        if (to !== Number(optional[1])) {
          a.sourceDetail = a.sourceDetail!.replace(/question #\d+/, `question #${to}`)
          changed = true
        }
        if (touched.has(to)) refresh.add(app.id)
      }
    }
    const gap = parseJson<GapAnalysis | null>(app.gapAnalysisJson, null)
    let gapChanged = false
    for (const item of gap?.items ?? []) {
      if (typeof item.questionId === 'number' && resolveId(item.questionId) !== item.questionId) {
        item.questionId = resolveId(item.questionId)
        gapChanged = true
      }
    }
    if (changed || gapChanged) {
      db.update(applications).set({
        ...(changed ? { answersJson: JSON.stringify(answers) } : {}),
        ...(gapChanged ? { gapAnalysisJson: JSON.stringify(gap) } : {}),
        updatedAt: nowSql(),
      }).where(eq(applications.id, app.id)).run()
      result.repointed.push(app.id)
    }
  }
  // Applications that asked a merged or derived question themselves wait on it too.
  for (const id of touched) {
    const q = db.select({ applicationId: questions.applicationId }).from(questions).where(eq(questions.id, id)).get()
    if (q?.applicationId && waiting.some(a => a.id === q.applicationId)) refresh.add(q.applicationId)
  }
  const { refreshed, unavailable } = await refreshWaitingApplications([...refresh].sort((a, b) => a - b))
  result.refreshed = refreshed
  log(`fact questions: merged ${result.merged.map(m => `#${m.id} into #${m.into}`).join(', ') || 'none'}; answered from knowledge ${result.derived.map(d => `#${d.id} "${d.answer}"`).join(', ') || 'none'}; refreshed applications ${refreshed.join(', ') || 'none'}${unavailable ? ' (refresh not on this build)' : ''}`)
  return result
}
