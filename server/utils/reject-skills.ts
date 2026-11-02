import { and, eq, inArray } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { decisions, jobs, questions } from '../db/schema'
import type { RejectSkillOption, RejectSkillsMode, RejectSkillsRecord, Requirement, ScoreBreakdown } from '#shared/types/pipeline'
import { properSkillName } from '#shared/utils/names'
import { capitalize } from '#shared/utils/plain-text'
import { loadKnowledge, upsertKnowledge } from './knowledge'
import { ruleTerm } from './learned-score'
import { GENERIC_TERMS } from './learning'
import { answerQuestion, cleanSkillSubject, findKnowledgeEntry, isNegativeKnowledge, negativeSkillValue } from './questions'
import { parseJson } from './review'

// "Wrong tech stack" rejections that name the skills at fault. The dialog offers the job's
// requirements as chips; the reject route validates the picks here, learning makes evidence
// only for them, and "I don't have these" writes each one to the knowledge base as a No.

type JobRow = InferSelectModel<typeof jobs>

const MAX_SKILLS = 20
const MAX_SKILL_LENGTH = 80
const MAX_OPTIONS = 24

/** "Nice to have: Go in production" names Go in production. */
const OPTIONAL_PREFIX = /^(nice to have|nice-to-have|bonus|plus|a plus|preferred|optional|desired)\s*:\s*/i
/**
 * Requirements that are tasks, activities, or conditions rather than skills ("Run CI/CD in
 * GitHub Actions", "Designing APIs and integrations", "Evaluating AI quality", "Open to using AI").
 */
const TASK_START = /^(run|build|deploy|design|tune|write|lead|leading|own|ship|manage|create|develop|implement|maintain|drive|work|collaborate|communicate|mentor|mentoring|identify|resolve|coach|hire|grow|onboard|translate|explain|give|read|debug|evaluate|use|leverage|integrate|operate|measure|improve|deliver|support|scale|contribute|learn|partner|designing|building|evaluating|using|leveraging|integrating|operating|debugging|developing|implementing|managing|measuring|improving|creating|writing|running|deploying|delivering|shipping|supporting|scaling|maintaining|translating|coaching|hiring|explaining|contributing|played|previous|prior|interest|open to|comfortable|authorized|ability|able to|live)\b/i
/** How much of a skill, not which one: "Go in production" names Go. */
const AMOUNT_SUFFIX = /\s+(?:in (?:a )?production(?: environments?)?|at scale)\s*$/i
/** "modern JavaScript" names JavaScript. */
const LEADING_QUALIFIER = /^(?:modern|current|recent)\s+/i
/** Requirement kinds that never name a stack. */
const NOT_STACK_KINDS = new Set<Requirement['kind']>(['education', 'certification'])
/** Requirement kinds whose lists ("Ruby, Java, Go, or Python") are split into one chip per skill. */
const SPLIT_KINDS = new Set<Requirement['kind']>(['skill', 'language', 'framework', 'domain'])
/**
 * One capitalized word that names no stack. Requirement lines start with a capital, so a lone
 * "Identity" (from "Identity and access management") or "Performance" reads like a name.
 */
const NOT_A_STACK = new Set(['identity', 'privacy', 'risk', 'compliance', 'governance', 'mentorship', 'leadership', 'ownership', 'collaboration', 'communication', 'teamwork', 'experience', 'interest', 'ability', 'familiarity', 'knowledge', 'understanding', 'proficiency', 'expertise', 'performance', 'reliability', 'scalability', 'quality', 'similar', 'other', 'etc', 'others'])
/** Generic beyond the learning list: "Software-as-a-Service product" is SaaS. */
const GENERIC_EXTRA = new Set(['software-as-a-service', 'enterprise software', 'kanban', 'waterfall', 'lean'])
const STATUS_ORDER: Record<Requirement['status'], number> = { lack: 0, unknown: 0, partial: 1, have: 2 }

/**
 * A one-word name the question cleaner leaves out: it treats a capital first letter as the
 * start of a sentence, so "Python", "Go", "Clojure", and "Sidekiq" read as plain words there.
 * Only stack requirement kinds call this, where a lone capitalized word is a name.
 */
function oneWordName(text: string): string | null {
  const t = text
    .replace(/\([^()]*\)/g, ' ')
    .replace(/\b\d+\s*\+?\s*(?:years?|yrs?)\b(?:\s+of)?/gi, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/^(?:at least|one of|either|with|using|in)\s+/i, '')
    .replace(/^(?:solid|strong|deep|good|working|advanced|basic|proven|hands-on|excellent|exceptional|expert)\s+/i, '')
    .replace(/^(?:understanding|knowledge|expertise|experience|proficiency|familiarity|fluency)\s+(?:of|in|with)\s+/i, '')
    .replace(/\b(?:commercial|professional|hands-on)?\s*experience\b/gi, ' ')
    .replace(/[.,;:]+$/, '')
    .replace(/\s+/g, ' ').trim()
  // "backend engineering in Java", "technical background in Clojure": the name at the end.
  const name = /^[A-Z][A-Za-z0-9.+#/-]*$/.test(t) ? t : /\s(?:in|with)\s+([A-Z][A-Za-z0-9.+#/-]*)$/.exec(t)?.[1] ?? null
  return !name || NOT_A_STACK.has(name.toLowerCase()) ? null : name
}

/**
 * The short skill name a requirement line names, or null when it is generic or not a skill.
 * `name` accepts a lone capitalized word ("Python"), for stack requirement kinds and list items.
 */
export function rejectSkillLabel(text: string, opts: { name?: boolean } = {}): string | null {
  const raw = text.replace(OPTIONAL_PREFIX, '').replace(/\s+/g, ' ').trim()
  if (TASK_START.test(raw)) return null
  const t = raw.replace(/\s*\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim().replace(AMOUNT_SUFFIX, '').replace(/[.,;:]+$/, '').trim()
  let label = cleanSkillSubject(t) ?? (opts.name ? oneWordName(t) : null)
  if (!label) return null
  label = label.replace(LEADING_QUALIFIER, '').replace(AMOUNT_SUFFIX, '').trim()
  if (!label || TASK_START.test(label) || NOT_A_STACK.has(label.toLowerCase())) return null
  // "or similar OOP languages", "another modern CMS": a stand-in, not a skill.
  if (/^(?:similar|other|another|related|equivalent|comparable)\b/i.test(label)) return null
  const term = ruleTerm(label)
  const bare = term.replace(/\s+products?$/, '')
  if (!term || GENERIC_TERMS.has(term) || GENERIC_TERMS.has(bare) || GENERIC_EXTRA.has(bare)) return null
  // Before capitalize, so "ios" becomes "iOS" rather than "Ios".
  return capitalize(properSkillName(label))
}

/** Each parenthesized group swapped for a marker, so splitting never cuts inside "(SSO, SAML)". */
function maskParens(text: string): { masked: string; groups: string[] } {
  const groups: string[] = []
  let masked = ''
  let buf = ''
  let depth = 0
  for (const c of text) {
    if (c === '(') {
      if (depth > 0) buf += c
      depth++
    }
    else if (c === ')' && depth > 0) {
      depth--
      if (depth === 0) {
        masked += `\u0001${groups.length}\u0001`
        groups.push(buf)
        buf = ''
      }
      else buf += c
    }
    else if (depth > 0) buf += c
    else masked += c
  }
  // An unclosed parenthesis stays as text; the label cleaner drops what it cannot use.
  if (depth > 0) masked += `(${buf}`
  return { masked, groups }
}

function unmask(text: string, groups: string[]): string {
  return text.replace(/\u0001(\d+)\u0001/g, (_, i: string) => `(${groups[Number(i)]})`)
}

/**
 * Splits a list at its own separators: commas, semicolons, "or", "and", "and/or", "&", " + ",
 * and a slash between two names of three or more characters ("HTML/CSS", never "CI/CD").
 * Text inside parentheses must be masked first.
 */
function splitList(text: string): string[] {
  return text
    .split(/\s*[,;]\s*|\s+(?:and\/or|or|and|&|\+)\s+|(?<=[A-Za-z0-9.+#]{3})\/(?=[A-Za-z0-9.+#]{3})/i)
    .map(p => p.replace(/^\s*(?:and\/or|or|and)\s+/i, '').trim())
    .filter(Boolean)
}

/** Words that introduce examples: "such as", "e.g.", "including". */
const EXAMPLES = /^(.*?)\b(?:like|such as|e\.g\.?,?|including|for example|using)\s+(.+)$/i

function labelsOf(parts: string[]): string[] {
  return parts.map(p => rejectSkillLabel(p, { name: true }))
    .filter((l): l is string => !!l && l.split(' ').length <= 3)
}

/**
 * One label per skill in a list requirement: "a language like Ruby, Java, Go, or Python" gives
 * Ruby, Java, Go, Python. A parenthesized list adds its own names: "Identity and access
 * management concepts (SSO, SAML, OIDC, SCIM)" gives SSO, SAML, OIDC, SCIM, and "Clojure or
 * Frontend (React + Typescript)" gives Clojure, React, Typescript. Parentheses are split as a
 * whole, so a chip is never a fragment cut out of them ("scope)", "Gemini)").
 */
function listLabels(text: string): string[] {
  const { masked, groups } = maskParens(text.replace(OPTIONAL_PREFIX, ''))
  const example = EXAMPLES.exec(masked)
  const out = labelsOf(splitList(example ? example[2]! : masked).map(p => unmask(p, groups)))
  for (const g of groups) {
    const inner = g.trim()
      .replace(/^(?:e\.g\.?|i\.e\.?|such as|including|like|for example)\s*,?\s*/i, '')
      .replace(/,?\s*(?:etc\.?|and more|or similar|preferred|required)\s*$/i, '')
    out.push(...labelsOf(splitList(maskParens(inner).masked)))
  }
  // "LLM integration patterns such as tool use, function calling": the examples are plain words,
  // so the words before them name the skill.
  if (out.length === 0 && example) {
    const head = rejectSkillLabel(unmask(example[1]!, groups), { name: true })
    if (head) out.push(head)
  }
  return out
}

/**
 * Skills the knowledge base now says Devin does not have, as rule terms. A requirement's status
 * was judged when the job was enriched; a No saved since (an answer, or a rejection here) wins.
 */
export function negativeSkillTerms(): Set<string> {
  const out = new Set<string>()
  for (const e of loadKnowledge()) {
    if ((e.category !== 'skill' && e.category !== 'experience') || !isNegativeKnowledge(e.value)) continue
    const t = ruleTerm(e.key.replace(/^has done:\s*/i, ''))
    if (t) out.add(t)
  }
  return out
}

/**
 * The chips the reject dialog offers under "Wrong tech stack": lack and unknown first, then
 * partial, then the ones the knowledge base says Devin has. Generic requirements are left out.
 */
export function rejectSkillOptions(requirements: Requirement[], negative: Set<string> = new Set()): RejectSkillOption[] {
  const all: Array<RejectSkillOption & { term: string; i: number }> = []
  requirements.forEach((r, i) => {
    if (!r?.text || NOT_STACK_KINDS.has(r.kind)) return
    const one = rejectSkillLabel(r.text, { name: SPLIT_KINDS.has(r.kind) })
    const labels = one ? [one] : SPLIT_KINDS.has(r.kind) ? listLabels(r.text) : []
    for (const label of labels) {
      const term = ruleTerm(label)
      if (term) all.push({ label, term, i, status: negative.has(term) ? 'lack' : r.status, requirement: r.text })
    }
  })
  all.sort((a, b) => (STATUS_ORDER[a.status] ?? 0) - (STATUS_ORDER[b.status] ?? 0) || a.i - b.i)
  const out: RejectSkillOption[] = []
  const seen = new Set<string>()
  for (const o of all) {
    if (seen.has(o.term)) continue
    seen.add(o.term)
    out.push({ label: o.label, status: o.status, requirement: o.requirement })
  }
  return out.slice(0, MAX_OPTIONS)
}

function norm(s: string) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Validates the optional skills and skillsMode of a reject body against the job.
 * Each skill must be one of the job's requirement texts, chip labels, skills, or tags.
 * Returns null when no skills were named, so the rejection learns as it always did.
 */
export function resolveRejectSkills(job: JobRow, reasonCode: string, rawSkills: unknown, rawMode: unknown): RejectSkillsRecord | null {
  if (rawSkills == null || (Array.isArray(rawSkills) && rawSkills.length === 0)) return null
  if (!Array.isArray(rawSkills)) throw createError({ statusCode: 400, statusMessage: 'skills must be a list of skill names' })
  if (reasonCode !== 'wrong_stack') throw createError({ statusCode: 400, statusMessage: 'Skills can only be named for Wrong tech stack' })
  if (rawSkills.length > MAX_SKILLS) throw createError({ statusCode: 400, statusMessage: `Pick at most ${MAX_SKILLS} skills` })
  const mode: RejectSkillsMode = rawMode == null ? 'lack' : rawMode as RejectSkillsMode
  if (mode !== 'lack' && mode !== 'avoid') throw createError({ statusCode: 400, statusMessage: 'skillsMode must be "lack" or "avoid"' })

  const requirements = parseJson<Requirement[]>(job.requirementsJson, [])
  const score = parseJson<ScoreBreakdown | null>(job.scoreBreakdown, null)
  // Value Devin may send, to the skill name learning and the knowledge base use.
  const allowed = new Map<string, string>()
  for (const o of rejectSkillOptions(requirements)) allowed.set(norm(o.label), o.label)
  const raw = [
    ...requirements.map(r => r?.text),
    ...(score?.skills.missing ?? []),
    ...(score?.skills.matched ?? []),
    ...parseJson<string[]>(job.tags, []),
  ].filter((s): s is string => typeof s === 'string' && !!s.trim())
  for (const s of raw) if (!allowed.has(norm(s))) allowed.set(norm(s), rejectSkillLabel(s, { name: true }) ?? s.trim().replace(/\s+/g, ' '))

  const skills: RejectSkillsRecord['skills'] = []
  const seen = new Set<string>()
  for (const s of rawSkills) {
    if (typeof s !== 'string') throw createError({ statusCode: 400, statusMessage: 'Each skill must be text' })
    const value = s.trim().replace(/\s+/g, ' ')
    if (!value) continue
    if (value.length > MAX_SKILL_LENGTH) throw createError({ statusCode: 400, statusMessage: `Each skill must be ${MAX_SKILL_LENGTH} characters or fewer` })
    const label = allowed.get(norm(value))
    if (!label) throw createError({ statusCode: 400, statusMessage: `"${value}" is not one of this job's requirements` })
    const term = ruleTerm(label)
    if (!term || seen.has(term)) continue
    seen.add(term)
    // A skill the knowledge base says Devin has is never overwritten from the reject dialog;
    // "I don't have these" then only lowers jobs that ask for it.
    const existing = mode === 'lack' ? findKnowledgeEntry('skill', label) : null
    const kept = !!existing && !isNegativeKnowledge(existing.value)
    skills.push(kept ? { value, label, term, kept } : { value, label, term })
  }
  return skills.length ? { mode, skills } : null
}

/**
 * "I don't have these": writes each named skill to the knowledge base as a No (the same entry a
 * No answer to "Have you used X?" writes, so it is never claimed), and answers every pending
 * knows or has_done question about the skill with No through the normal answer path, which
 * refreshes the applications waiting on it and rescores the jobs it touches.
 * Never writes a positive value. Runs after onDecision() so those rescores see the new rules.
 * The outcome is stored on the decision's features_json.
 */
export async function applyRejectSkillKnowledge(decisionId: number, record: RejectSkillsRecord, job: Pick<JobRow, 'title' | 'company'>): Promise<NonNullable<RejectSkillsRecord['knowledge']>> {
  const db = useDb()
  const outcome: NonNullable<RejectSkillsRecord['knowledge']> = { written: [], questionsAnswered: [], errors: [] }
  if (record.mode !== 'lack') return outcome
  const pending = db.select().from(questions)
    .where(and(eq(questions.status, 'pending'), inArray(questions.kind, ['knows', 'has_done'])))
    .all()
  for (const skill of record.skills.filter(s => !s.kept)) {
    let knowsAnswered = false
    for (const q of pending.filter(q => q.subject && ruleTerm(q.subject) === skill.term)) {
      if (outcome.questionsAnswered.includes(q.id)) continue
      try {
        const res = await answerQuestion(q.id, 'No')
        outcome.questionsAnswered.push(q.id)
        if (res.knowledge) outcome.written.push({ category: res.knowledge.category, key: res.knowledge.key, replaced: null })
        if (q.kind === 'knows') knowsAnswered = true
      }
      catch (e: any) {
        const msg = `Question ${q.id} (${q.subject}): ${e?.statusMessage || e?.message || String(e)}`
        console.error(`[reject-skills] could not answer ${msg}`)
        outcome.errors.push(msg)
      }
    }
    // A knows question answered No has written skill:<subject> already.
    if (knowsAnswered) continue
    try {
      const existing = findKnowledgeEntry('skill', skill.label)
      // An entry that already says No keeps its own wording; a positive one is never overwritten here.
      if (existing) continue
      const key = existing?.key ?? skill.label
      const value = negativeSkillValue(skill.label, `(Said when rejecting ${job.title} at ${job.company} for the wrong tech stack.)`)
      upsertKnowledge('skill', key, value, 'user_answer')
      outcome.written.push({ category: 'skill', key, replaced: existing ? existing.value.slice(0, 300) : null })
    }
    catch (e: any) {
      const msg = `Knowledge for ${skill.label}: ${e?.message || String(e)}`
      console.error(`[reject-skills] could not write ${msg}`)
      outcome.errors.push(msg)
    }
  }
  const d = db.select().from(decisions).where(eq(decisions.id, decisionId)).get()
  if (d) {
    const f = parseJson<Record<string, unknown>>(d.featuresJson, {})
    db.update(decisions)
      .set({ featuresJson: JSON.stringify({ ...f, rejectSkills: { ...record, knowledge: outcome } }) })
      .where(eq(decisions.id, decisionId))
      .run()
  }
  return outcome
}
