import { and, eq, inArray, notInArray } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { applications, jobs, questions } from '../db/schema'
import type { GapAnalysis, Requirement } from '#shared/types/pipeline'
import type { AnswerOutcome, QuestionListItem } from '#shared/types/learning'
import { loadKnowledge, upsertKnowledge, type KnowledgeEntry } from './knowledge'
import { ruleTerm, ruleWordMatch } from './learned-score'
import { nowSql, parseJson, referencedQuestionIds } from './review'
import { rescoreJobs } from './scoring'

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
  return db.insert(questions).values({
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
export function knowledgeCovers(subject: string): KnowledgeEntry | null {
  const want = ruleTerm(subject)
  if (!want) return null
  for (const e of loadKnowledge()) {
    if (e.category !== 'skill' && e.category !== 'experience') continue
    const key = e.key.replace(/^has done:\s*/i, '')
    if (ruleTerm(key) === want || key.split(/[/,]/).some(p => ruleTerm(p) === want)) return e
  }
  return null
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

/** The sentence stored in the knowledge base for an answer. A No is stored too, so it is never asked or claimed. */
export function knowledgeValueFor(q: QuestionRow, answer: string): { value: string; negative: boolean } {
  const subject = q.subject?.trim() || 'this'
  const asked = `(Answer to: ${q.question})`
  if (q.answerType === 'yes_no') {
    const yn = parseYesNo(answer) ?? 'no'
    if (q.kind === 'knows') {
      if (yn === 'yes') return { value: `Knows ${subject}. ${asked}`, negative: false }
      if (yn === 'some') return { value: `Some experience with ${subject}, not in depth. Do not claim production or expert level ${subject}. ${asked}`, negative: false }
      return { value: `Does not know ${subject}. No production experience with ${subject}. Never claim ${subject} experience. ${asked}`, negative: true }
    }
    if (q.kind === 'has_done') {
      if (yn === 'yes') return { value: `Has done this: ${subject}. ${asked}`, negative: false }
      if (yn === 'some') return { value: `Has partly done this: ${subject}. Do not overstate it. ${asked}`, negative: false }
      return { value: `Has not done this: ${subject}. Never claim it. ${asked}`, negative: true }
    }
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

function writeKnowledge(target: { category: string; key: string }, value: string, negative: boolean): KnowledgeEntry {
  const existing = findKnowledgeEntry(target.category, target.key)
  const key = existing?.key ?? target.key
  // A Yes on something the resume already lists keeps the resume text and adds the answer under it.
  if (existing && !negative && existing.source !== 'user_answer' && !isNegativeKnowledge(existing.value)) {
    const merged = existing.value.includes(value) ? existing.value : `${existing.value}\n${value}`
    return upsertKnowledge(target.category, key, merged, existing.source)
  }
  return upsertKnowledge(target.category, key, value, 'user_answer')
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
    askedAt: q.askedAt,
    answeredAt: q.answeredAt,
    applicationId: q.applicationId,
    jobId: q.jobId,
    job,
    waitingApplicationIds: waitingIds,
    legacy: isLegacyQuestion(q),
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
  return rows
    .map((q) => {
      const jobId = q.jobId ?? (q.applicationId ? appJob.get(q.applicationId) : undefined)
      return toQuestionListItem(q, jobId != null ? jobById.get(jobId) ?? null : null, q.status === 'pending' ? waitingApplicationIds(q, waiting) : [])
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
 */
export async function answerQuestion(id: number, rawAnswer: string): Promise<AnswerOutcome> {
  const db = useDb()
  const q = db.select().from(questions).where(eq(questions.id, id)).get()
  if (!q) throw createError({ statusCode: 404, statusMessage: 'Question not found' })
  const answer = (rawAnswer ?? '').toString().trim()
  if (!answer) throw createError({ statusCode: 400, statusMessage: 'Type an answer, or skip the question' })
  if (answer.length > 4000) throw createError({ statusCode: 400, statusMessage: 'Keep the answer under 4,000 characters' })

  let normalized = answer
  if (q.answerType === 'yes_no') {
    const yn = parseYesNo(answer)
    if (!yn) throw createError({ statusCode: 400, statusMessage: 'Answer Yes, No, or Some experience' })
    normalized = YES_NO_LABELS[yn]
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

  const target = knowledgeTargetFor(q)
  const { value, negative } = knowledgeValueFor(q, normalized)
  const entry = writeKnowledge(target, value, negative)
  const waiting = waitingApplicationIds(q)
  db.update(questions).set({
    status: 'answered',
    answer: normalized,
    answeredAt: nowSql(),
    knowledgeKey: `${entry.category}:${entry.key}`,
  }).where(eq(questions.id, id)).run()

  const { refreshed, unavailable } = await refreshWaitingApplications(waiting)
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
export function askKnows(subject: string, opts: AskOptions = {}): QuestionRow | null {
  if (knowledgeCovers(subject)) return null
  return askQuestion({
    question: `Do you know ${subject}?`,
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

const MAX_NEW_DAILY_QUESTIONS = 5

/**
 * Called by learn:daily. Asks for the pay floor when it is unknown, and asks "Do you know X?"
 * for short technology requirements that open real jobs need and the knowledge base does not
 * cover (a must-have in one job, or any requirement in two or more). At most five new per day.
 * Sandbox jobs never create questions.
 */
export function askDailyQuestions(): QuestionRow[] {
  const db = useDb()
  const before = new Set(db.select({ id: questions.id }).from(questions).all().map(r => r.id))
  const created: QuestionRow[] = []
  const floor = askCompFloor()
  if (floor && !before.has(floor.id)) created.push(floor)

  const open = db.select({ id: jobs.id, requirementsJson: jobs.requirementsJson, isSandbox: jobs.isSandbox })
    .from(jobs).where(notInArray(jobs.status, CLOSED_JOB_STATUSES)).all()
    .filter(j => !j.isSandbox && j.requirementsJson)
  const wanted = new Map<string, { subject: string; jobs: Set<number>; mustHave: boolean; firstJob: number }>()
  for (const j of open) {
    for (const r of parseJson<Requirement[]>(j.requirementsJson, [])) {
      if (r.status !== 'unknown' || !['language', 'framework', 'skill'].includes(r.kind)) continue
      const subject = r.text.trim()
      if (!subject || subject.length > 40) continue
      const key = ruleTerm(subject)
      const w = wanted.get(key) ?? { subject, jobs: new Set<number>(), mustHave: false, firstJob: j.id }
      w.jobs.add(j.id)
      w.mustHave ||= r.mustHave
      wanted.set(key, w)
    }
  }
  const candidates = [...wanted.values()]
    .filter(w => w.mustHave || w.jobs.size >= 2)
    .sort((a, b) => b.jobs.size - a.jobs.size || Number(b.mustHave) - Number(a.mustHave))
  for (const c of candidates) {
    if (created.length >= MAX_NEW_DAILY_QUESTIONS) break
    const row = askKnows(c.subject, {
      jobId: c.firstJob,
      context: `${c.jobs.size === 1 ? 'An open job asks' : `${c.jobs.size} open jobs ask`} for ${c.subject}. Your answer goes into your knowledge base. A No means it is never claimed.`,
    })
    if (row && !before.has(row.id)) created.push(row)
  }
  return created
}
