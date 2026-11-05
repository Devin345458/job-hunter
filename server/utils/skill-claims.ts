import { and, desc, eq, inArray } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { applications, jobs, questions } from '../db/schema'
import {
  SKILL_CLAIM_ANSWERS,
  type JobRescoreResult,
  type QuestionView,
  type Requirement,
  type ScoreBreakdown,
  type SkillClaimAnswer,
  type SkillClaimKnowledge,
  type SkillClaimPreview,
  type SkillClaimResult,
  type SkillClaimSource,
} from '#shared/types/pipeline'
import { EXAMPLE_MAX_CHARS } from '#shared/utils/limits'
import { capitalize, plainError, secondPerson } from '#shared/utils/plain-text'
import { loadKnowledge, type KnowledgeEntry } from './knowledge'
import { ruleTerm } from './learned-score'
import {
  answerQuestion,
  askSkillQuestion,
  findKnowledgeEntry,
  isNegativeKnowledge,
  knowledgeCovers,
  knowledgeTargetFor,
  knowsQuestionText,
  mergedIntoId,
  parseYesNo,
  questionExample,
  subjectTarget,
  type QuestionRow,
  type YesNo,
} from './questions'
import { rejectSkillLabel } from './reject-skills'
import { parseJson, toQuestionView } from './review'
import { repoSuggestionsFor } from './repos/suggest-store'
import { scoreJobs } from './scoring'

// The skill panel: Devin taps a Missing chip or a requirement row that is not Have, says whether
// he has it, and the answer goes through the normal question path (answerQuestion), so the
// knowledge base, waiting applications, and code rescores all work as they do on /questions.
// Then the job's requirement statuses take the answer, and Claude scores the job's skills again.
// Nothing here ever writes a positive claim Devin did not make: a No writes the plain negative
// entry answerQuestion writes, and sandbox jobs write nothing at all.

type JobRow = InferSelectModel<typeof jobs>
type AppRow = InferSelectModel<typeof applications>

/** The statuses POST /api/applications/:id/prepare accepts (ALLOWED in server/api/applications/[id]/prepare.post.ts). */
const PREPARE_STATUSES = new Set(['preparing', 'needs_input', 'proposed', 'needs_manual', 'submit_failed', 'draft', 'ready'])

function norm(s: string) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase()
}

// ── Names, reasons, and subjects ──

/** A parenthetical that explains the gap ("knowledge base explicitly states no production experience"), not one that lists examples ("SSO, SAML, OIDC"). */
const REASON_WORDS = /\b(knowledge base|profile|resume|not|no|never|unknown|only|partial|partly|lacks?|missing|mention(?:ed|s)?|explicit(?:ly)?|evidence|limited|states?|unclear|but|without|isn't|doesn't|though|although)\b/i

/**
 * Splits a Missing chip into its name and its closing parenthetical reason:
 * "Python proficiency (knowledge base explicitly states no production experience)" gives
 * "Python proficiency" and the reason. A closing parenthesis that lists examples stays in the name.
 */
export function splitClaimReason(text: string): { name: string; reason: string | null } {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t.endsWith(')')) return { name: t, reason: null }
  let depth = 0
  for (let i = t.length - 1; i >= 0; i--) {
    const c = t[i]
    if (c === ')') depth++
    else if (c === '(') {
      depth--
      if (depth === 0) {
        const name = t.slice(0, i).trim()
        const reason = t.slice(i + 1, -1).trim()
        if (!name || !reason || !REASON_WORDS.test(reason)) return { name: t, reason: null }
        return { name, reason }
      }
    }
  }
  return { name: t, reason: null }
}

function sentence(text: string): string {
  const t = capitalize(text.trim())
  return /[.!?]$/.test(t) ? t : `${t}.`
}

/** The chip's reason in plain words, addressed to Devin. */
export function plainClaimWhy(reason: string): string {
  const r = reason.trim().replace(/\s+/g, ' ')
  if (/^(unknown|not known|not mentioned)\.?$/i.test(r)) return 'Your knowledge base does not mention it.'
  return sentence(secondPerson(r)
    .replace(/\bthe (knowledge base|profile|resume)\b/gi, 'your $1')
    .replace(/(?<!\byour )\bknowledge base\b/gi, 'your knowledge base')
    .replace(/\b(in|from|on) (profile|resume)\b/gi, '$1 your $2'))
}

/** "skill/Sentry" as "your Sentry entry". */
function entryName(evidence: string | null): string | null {
  if (!evidence) return null
  const i = evidence.indexOf('/')
  const key = (i >= 0 ? evidence.slice(i + 1) : evidence).replace(/^has done:\s*/i, '').trim()
  return key ? `your ${key} entry` : null
}

/** Why a requirement row is not Have, from its status and the entry it cites. */
function requirementWhy(r: Requirement): string | null {
  const entry = entryName(r.evidence)
  if (r.status === 'partial') return entry ? `Your knowledge base has something close (${entry}), not this exactly.` : 'Your knowledge base has something close, not this exactly.'
  if (r.status === 'lack') return entry ? `Your knowledge base says otherwise (${entry}).` : 'Your knowledge base says otherwise.'
  if (r.status === 'unknown') return 'Your knowledge base does not mention it.'
  return null
}

const LEAD_QUALIFIER = /^(?:excellent|strong|solid|deep|good|great|proven|practical|hands-on|working|advanced|basic|exceptional|expert|extensive|demonstrated|significant|professional|real-world|nice to have:|preferred:|bonus:)\s+/i
const LEAD_OF = /^(?:knowledge|understanding|experience|proficiency|familiarity|fluency|expertise|background)\s+(?:of|in|with)\s+/i
const LEAD_RECORD = /^(?:a\s+)?(?:(?:proven|strong|demonstrated)\s+)?(?:track\s+)?(?:record|history)\s+of\s+/i
const TRAIL = /\s+(?:proficiency|experience|expertise|knowledge|skills?|background|record|fluency|patterns?|practices|concepts?|principles|fundamentals)$/i

/**
 * The subject a question about a name asks: "Excellent technical writing" is Technical writing,
 * "Practical knowledge of failure handling" is Failure handling, "Python proficiency" is Python.
 */
export function skillClaimSubject(name: string): string {
  let t = name.replace(/\b\d+\s*\+?\s*(?:years?|yrs?)\b(?:\s+of)?/gi, ' ').replace(/\s+/g, ' ').trim()
  for (let i = 0; i < 4; i++) {
    const before = t
    t = t.replace(LEAD_QUALIFIER, '').replace(LEAD_OF, '').replace(LEAD_RECORD, '').replace(TRAIL, '').trim()
    if (t === before) break
  }
  t = t.replace(/[.,;:]+$/, '').trim()
  return capitalize(t.length >= 2 ? t : name.trim())
}

/** Compares two subjects: the same skill whether singular or plural ("Workflow engine" and "Workflow engines"). */
export function skillClaimKey(subject: string): string {
  return ruleTerm(skillClaimSubject(subject))
    .split(' ')
    .map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ')
}

/** knows for a language, tool, or framework (a name); has_done for experience or a practice. */
export function skillClaimKind(subject: string, requirementKind: Requirement['kind'] | null): 'knows' | 'has_done' {
  if (requirementKind === 'experience' || requirementKind === 'domain') return 'has_done'
  const label = subject.split(' ').length <= 3 ? rejectSkillLabel(subject, { name: true }) : null
  if (!label) return 'has_done'
  // "Distributed systems", "Machine learning": a practice written in plain words, not a named tool.
  if (/^[A-Z][a-z]+(?:[ -][a-z]+)+$/.test(label) || /^[a-z]/.test(label)) return 'has_done'
  return 'knows'
}

/** "Technical writing" reads "technical writing" mid-sentence; "SDK/platform" and "GraphQL" keep their capitals. */
function midSentence(subject: string): string {
  const first = /^\S*/.exec(subject)![0]
  return /^[A-Z][a-z]*$/.test(first) ? subject.charAt(0).toLowerCase() + subject.slice(1) : subject
}

export function hasDoneQuestionText(subject: string): string {
  const s = midSentence(subject)
  if (/^\S+ing\b/i.test(s) && s.split(' ').length > 2) return `Have you done this in a real job or project: ${s}?`
  if (/ing$/i.test(s)) return `Have you done ${s} in a real job or project?`
  return `Have you worked with ${s} in a real job or project?`
}

// ── The posting requirement a chip is about ──

const LINK_STOP = new Set(['with', 'and', 'the', 'for', 'from', 'that', 'this', 'your', 'experience', 'knowledge', 'practical', 'strong', 'excellent', 'ability', 'proficiency', 'skill', 'record', 'background', 'another', 'other', 'one', 'more', 'year', 'plus', 'similar', 'such', 'like', 'using', 'build', 'building'])

function linkWords(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9+#.]{3,}/g) ?? [])
    .map(w => w.replace(/\.$/, '').replace(/s$/, ''))
    .filter(w => w.length >= 2 && !LINK_STOP.has(w)))
}

/** The requirement sharing most words with a chip name, when at least half the name's words are in it. */
function linkRequirement(name: string, reqs: Requirement[]): Requirement | null {
  const want = linkWords(name)
  if (!want.size) return null
  let best: { r: Requirement; hits: number } | null = null
  for (const r of reqs) {
    const have = linkWords(r.text)
    const hits = [...want].filter(w => have.has(w)).length
    if (!hits) continue
    if (!best || hits > best.hits || (hits === best.hits && best.r.status === 'have' && r.status !== 'have')) best = { r, hits }
  }
  return best && best.hits / want.size >= 0.5 ? best.r : null
}

// ── The claim's context ──

export interface SkillClaimContext {
  job: JobRow
  app: AppRow | null
  isSandbox: boolean
  source: SkillClaimSource
  /** The tapped text as stored (chip or requirement). */
  text: string
  name: string
  why: string | null
  /** The tapped requirement row, or the requirement a chip links to. */
  requirement: Requirement | null
  subject: string
  kind: 'knows' | 'has_done'
  /** An existing question on the same subject, or null when a save creates one. */
  question: QuestionRow | null
}

function loadJob(jobId: number): JobRow {
  const job = Number.isInteger(jobId) && jobId > 0 ? useDb().select().from(jobs).where(eq(jobs.id, jobId)).get() : null
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Job not found' })
  return job
}

/** The application the panel was opened from, or the job's newest one. */
function loadApplication(job: JobRow, applicationId: number | null | undefined): AppRow | null {
  const db = useDb()
  if (applicationId) {
    const app = db.select().from(applications).where(and(eq(applications.id, applicationId), eq(applications.jobId, job.id))).get()
    if (app) return app
  }
  return db.select().from(applications).where(eq(applications.jobId, job.id)).orderBy(desc(applications.id)).limit(1).get() ?? null
}

const STATUS_RANK: Record<string, number> = { pending: 0, answered: 1, skipped: 2 }

/**
 * An existing knows or has_done question on the same subject: pending, answered, or skipped (never
 * a merged duplicate). One tied to this job or application comes first, so answering it here
 * clears it from the card's optional questions; then answered, then pending, then skipped.
 */
function findQuestion(subject: string, job: JobRow, app: AppRow | null): QuestionRow | null {
  const key = skillClaimKey(subject)
  if (!key) return null
  const rows = useDb().select().from(questions)
    .where(and(inArray(questions.kind, ['knows', 'has_done']), inArray(questions.status, ['pending', 'answered', 'skipped'])))
    .all()
    .filter(q => q.subject && q.answerType === 'yes_no' && !mergedIntoId(q))
    .filter(q => skillClaimKey(q.subject!) === key)
  const local = (q: QuestionRow) => q.jobId === job.id || (!!app && q.applicationId === app.id)
  rows.sort((a, b) => Number(local(b)) - Number(local(a))
    || (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
    || b.id - a.id)
  // Answered beats a pending question elsewhere: it already holds what the knowledge base says.
  const top = rows[0] ?? null
  if (top && !local(top)) return rows.find(q => q.status === 'answered') ?? top
  return top
}

export function skillClaimContext(jobId: number, rawText: unknown, rawSource: unknown, applicationId?: number | null): SkillClaimContext {
  const job = loadJob(jobId)
  if (typeof rawText !== 'string' || !rawText.trim()) throw createError({ statusCode: 400, statusMessage: 'Say which skill this is about' })
  if (rawSource !== 'missing' && rawSource !== 'requirement') throw createError({ statusCode: 400, statusMessage: 'source must be "missing" or "requirement"' })
  const source = rawSource as SkillClaimSource
  const app = loadApplication(job, applicationId)
  const score = parseJson<ScoreBreakdown | null>(job.scoreBreakdown, null)
  const reqs = parseJson<Requirement[]>(job.requirementsJson, [])
  const want = norm(rawText)

  let text: string
  let name: string
  let why: string | null
  let requirement: Requirement | null
  if (source === 'missing') {
    const chip = score?.skills.missing.find(m => norm(m) === want)
    if (!chip) throw createError({ statusCode: 409, statusMessage: 'That skill is no longer in this job\'s Missing list. The score changed since the page loaded; reload it.' })
    const split = splitClaimReason(chip)
    text = chip
    name = split.name
    requirement = linkRequirement(name, reqs)
    why = split.reason ? plainClaimWhy(split.reason) : requirement ? requirementWhy(requirement) : null
  }
  else {
    const req = reqs.find(r => norm(r.text) === want)
    if (!req) throw createError({ statusCode: 409, statusMessage: 'That requirement is no longer on this job. Reload the page.' })
    text = req.text
    requirement = req
    name = skillClaimSubject(req.text)
    why = requirementWhy(req)
  }

  const subject = skillClaimSubject(name)
  const question = findQuestion(subject, job, app)
  return {
    job,
    app,
    isSandbox: !!job.isSandbox || !!app?.isSandbox,
    source,
    text,
    name,
    why,
    requirement,
    subject: question?.subject ?? subject,
    kind: (question?.kind as 'knows' | 'has_done' | undefined) ?? skillClaimKind(subject, requirement?.kind ?? null),
    question,
  }
}

/** Where the answer is written: the question's own target, or the one a new question gets. */
function claimTarget(ctx: SkillClaimContext): { category: string; key: string } {
  if (ctx.question) return knowledgeTargetFor(ctx.question)
  return subjectTarget(ctx.subject, ctx.kind)
}

function claimKnowledge(ctx: SkillClaimContext): KnowledgeEntry | null {
  const target = claimTarget(ctx)
  return findKnowledgeEntry(target.category, target.key, loadKnowledge(target.category)) ?? knowledgeCovers(ctx.subject)
}

function questionText(ctx: SkillClaimContext): string {
  return ctx.question?.question ?? (ctx.kind === 'knows' ? knowsQuestionText(ctx.subject) : hasDoneQuestionText(ctx.subject))
}

function materials(app: AppRow | null): SkillClaimPreview['materials'] {
  if (!app) return null
  return {
    applicationId: app.id,
    written: !!(app.tailoredResumeJson || app.coverLetter) && app.status !== 'preparing',
    canPrepare: PREPARE_STATUSES.has(app.status),
  }
}

function toKnowledge(e: KnowledgeEntry | null): SkillClaimKnowledge | null {
  return e ? { category: e.category, key: e.key, value: e.value } : null
}

const YN_ANSWER: Record<YesNo, SkillClaimAnswer> = { yes: 'Yes', some: 'Some experience', no: 'No' }

/** What an existing knowledge base entry says, as a yes or no answer: "Does not know X" is No, "Some experience with X" is Some experience, any other entry is Yes. */
function knowledgeYesNo(e: KnowledgeEntry): YesNo {
  if (isNegativeKnowledge(e.value)) return 'no'
  if (/^\s*(?:some experience with|has partly done)\b/i.test(e.value)) return 'some'
  return 'yes'
}

/** The status a requirement takes after an answer: a Have is never lowered (the rule applyToRequirements and applyAnswerToOpenJobs follow). */
function statusAfter(status: Requirement['status'], yn: YesNo): Requirement['status'] {
  if (yn === 'yes' && status !== 'have') return 'have'
  if (yn === 'some' && (status === 'unknown' || status === 'lack')) return 'partial'
  if (yn === 'no' && (status === 'unknown' || status === 'partial')) return 'lack'
  return status
}

/**
 * The answer Devin already gave on this subject (an answered question first, else the knowledge
 * base entry), when this job's requirement still shows a status from before it: the job was scored
 * before the answer. Null when nothing answers it, or when the requirement already agrees.
 */
function knownAnswerFor(ctx: SkillClaimContext, entry: KnowledgeEntry | null): { yn: YesNo; from: 'question' | 'knowledge' } | null {
  const req = ctx.requirement
  if (!req || ctx.isSandbox) return null
  const q = ctx.question
  const fromQuestion = q?.status === 'answered' && q.answer ? parseYesNo(q.answer) : null
  const known = fromQuestion ? { yn: fromQuestion, from: 'question' as const } : entry ? { yn: knowledgeYesNo(entry), from: 'knowledge' as const } : null
  if (!known) return null
  // A chip linked to a requirement only takes a Yes or Some experience (applyToRequirements' "linked" rule).
  if (ctx.source === 'missing' && known.yn === 'no') return null
  return statusAfter(req.status, known.yn) !== req.status ? known : null
}

export function skillClaimPreview(ctx: SkillClaimContext): SkillClaimPreview {
  const q = ctx.question
  const entry = claimKnowledge(ctx)
  const known = knownAnswerFor(ctx, entry)
  // A long name that is the requirement minus a few lead words ("A record of building ...") needs no second copy.
  const repeats = !!ctx.requirement && (norm(ctx.requirement.text) === norm(ctx.name)
    || (ctx.name.split(' ').length > 6 && norm(ctx.requirement.text).includes(norm(ctx.name))))
  const requirement = ctx.requirement && !repeats ? ctx.requirement.text : null
  return {
    name: ctx.name,
    why: known ? 'This job was scored before your answer.' : ctx.why,
    requirement,
    question: {
      id: q?.id ?? null,
      text: questionText(ctx),
      kind: ctx.kind,
      subject: ctx.subject,
      status: q?.status ?? null,
      answer: q?.answer ?? null,
      example: q ? questionExample(q) : null,
      repoSuggestion: q && q.status === 'pending' && !ctx.isSandbox ? repoSuggestionsFor([q.id]).get(q.id) ?? null : null,
    },
    knowledge: toKnowledge(entry),
    knownAnswer: known ? { answer: YN_ANSWER[known.yn], from: known.from } : null,
    isSandbox: ctx.isSandbox,
    materials: materials(ctx.app),
  }
}

/**
 * "Use my answer": applies the answer Devin already gave (knownAnswerFor) to this job's requirement
 * statuses, the same way a fresh answer does (applyToRequirements), and to the other open jobs that
 * name the same skill (applyAnswerToOpenJobs). Nothing is asked and the knowledge base is not
 * written. The panel then scores this job again (POST /api/jobs/:id/rescore). Sandbox jobs write nothing.
 */
export function applyKnownSkillClaim(ctx: SkillClaimContext): SkillClaimResult {
  if (ctx.isSandbox) return { written: false, question: null, knowledge: null, requirementsChanged: 0 }
  const entry = claimKnowledge(ctx)
  const known = knownAnswerFor(ctx, entry)
  if (!known) throw createError({ statusCode: 409, statusMessage: 'This job already reads your answer, or there is no answer on this skill yet. Reload the page.' })
  const target = claimTarget(ctx)
  const knowledge: SkillClaimKnowledge = toKnowledge(entry) ?? { category: target.category, key: target.key, value: ctx.question?.answer ?? '' }
  const requirementsChanged = applyToRequirements(ctx, known.yn, knowledge)
  applyAnswerToOpenJobs(ctx.subject, YN_ANSWER[known.yn], `${knowledge.category}/${knowledge.key.trim()}`)
  return { written: true, question: null, knowledge, requirementsChanged }
}

/** The existing question, or a new pending one tied to this job and application. Never on a sandbox job. */
export async function ensureSkillClaimQuestion(ctx: SkillClaimContext): Promise<QuestionRow> {
  if (ctx.isSandbox) throw createError({ statusCode: 409, statusMessage: 'Sandbox cards never create questions or write your knowledge base.' })
  if (ctx.question) return ctx.question
  const asks = ctx.requirement?.text ?? ctx.name
  // The meaning check first: an existing question that asks the same claim in other words is the one to answer.
  return askSkillQuestion({
    phrase: asks,
    question: questionText(ctx),
    context: `${ctx.job.title} at ${ctx.job.company} asks for: ${asks.replace(/\.+$/, '')}. Your answer decides whether the resume and letter can mention it.`,
    kind: ctx.kind,
    subject: ctx.subject,
    answerType: 'yes_no',
    applicationId: ctx.app?.id,
    jobId: ctx.job.id,
    blocking: false,
    category: 'technical',
  })
}

/**
 * The job's requirement statuses after an answer, so the next skills score reads what Devin said
 * instead of the status judged at enrichment. Changes the tapped row, any requirement that names
 * the same subject, and (for Yes and Some experience only) the requirement a chip links to.
 * A Have is never lowered: "Python, TypeScript, or Go" stays Have through TypeScript after a No to Python.
 */
function applyToRequirements(ctx: SkillClaimContext, yn: YesNo, entry: SkillClaimKnowledge | null): number {
  if (!entry) return 0
  const reqs = parseJson<Requirement[]>(ctx.job.requirementsJson, [])
  const key = skillClaimKey(ctx.subject)
  const evidence = `${entry.category}/${entry.key.trim()}`
  let changed = 0
  const next = reqs.map((r) => {
    const tapped = ctx.source === 'requirement' && !!ctx.requirement && norm(r.text) === norm(ctx.requirement.text)
    const same = skillClaimKey(r.text) === key
    const linked = ctx.source === 'missing' && !!ctx.requirement && norm(r.text) === norm(ctx.requirement.text) && yn !== 'no'
    if (!tapped && !same && !linked) return r
    let status: Requirement['status'] = r.status
    if (yn === 'yes' && r.status !== 'have') status = 'have'
    else if (yn === 'some' && (r.status === 'unknown' || r.status === 'lack')) status = 'partial'
    else if (yn === 'no' && (r.status === 'unknown' || r.status === 'partial')) status = 'lack'
    // Some experience on a Partly row stays Partly, now citing his own answer instead of the nearby entry.
    const cite = status === r.status && yn === 'some' && r.status === 'partial' && (tapped || same) && r.evidence !== evidence
    if (status === r.status && !cite) return r
    changed++
    return { ...r, status, evidence }
  })
  if (changed) useDb().update(jobs).set({ requirementsJson: JSON.stringify(next) }).where(eq(jobs.id, ctx.job.id)).run()
  return changed
}

/**
 * Saves Devin's answer from the skill panel through answerQuestion(), the same path as /questions.
 * A sandbox job writes nothing and creates no question (the guard reject-skills follows).
 */
export async function saveSkillClaim(ctx: SkillClaimContext, rawAnswer: unknown, rawExample: unknown): Promise<SkillClaimResult> {
  if (typeof rawAnswer !== 'string' || !(SKILL_CLAIM_ANSWERS as readonly string[]).includes(rawAnswer)) {
    throw createError({ statusCode: 400, statusMessage: 'Answer Yes, Some experience, or No' })
  }
  const answer = rawAnswer as SkillClaimAnswer
  let example: string | null | undefined
  if (rawExample !== undefined) {
    if (rawExample !== null && typeof rawExample !== 'string') throw createError({ statusCode: 400, statusMessage: 'The example must be text' })
    example = rawExample
  }
  if (answer === 'No' && example) throw createError({ statusCode: 400, statusMessage: 'A No answer takes no example' })
  if (typeof example === 'string' && example.trim().length > EXAMPLE_MAX_CHARS) {
    throw createError({ statusCode: 400, statusMessage: `Keep the example under ${EXAMPLE_MAX_CHARS.toLocaleString('en-US')} characters` })
  }
  if (ctx.isSandbox) return { written: false, question: null, knowledge: null, requirementsChanged: 0 }

  const q = await ensureSkillClaimQuestion(ctx)
  const outcome = await answerQuestion(q.id, answer, example)
  const yn = parseYesNo(answer)!
  // answerQuestion rescored jobs from the stored row; re-read it so the statuses apply to the current one.
  const fresh = { ...ctx, job: loadJob(ctx.job.id) }
  const requirementsChanged = applyToRequirements(fresh, yn, outcome.knowledge)
  const row = useDb().select().from(questions).where(eq(questions.id, q.id)).get()!
  return {
    written: true,
    question: toQuestionView(row) as QuestionView,
    knowledge: outcome.knowledge,
    requirementsChanged,
  }
}

// ── A fresh skills score ──

const rescoring = new Map<number, Promise<JobRescoreResult>>()

/**
 * Claude scores one job's skills again (scoreJobs with fresh), reading the knowledge base and the
 * requirement statuses as they are now. A second request for the same job waits for the first and
 * then runs, so an answer saved during a score is never lost.
 */
export function rescoreJobSkills(jobId: number): Promise<JobRescoreResult> {
  loadJob(jobId)
  const before = rescoring.get(jobId)
  const run = (before ? before.catch(() => null) : Promise.resolve(null)).then(() => freshScore(jobId))
  rescoring.set(jobId, run)
  run.finally(() => {
    if (rescoring.get(jobId) === run) rescoring.delete(jobId)
  }).catch(() => {})
  return run
}

async function freshScore(jobId: number): Promise<JobRescoreResult> {
  const previousScore = loadJob(jobId).matchScore
  const stats = await scoreJobs({ jobIds: [jobId], fresh: true, log: m => console.log(`[skill-claims] ${m}`) })
  const job = loadJob(jobId)
  let message: string | null = null
  if (stats.budgetStopped) message = `Today's AI budget is used up, so the score was not refreshed. ${plainError(stats.errors[0])}`.trim()
  else if (stats.noText) message = 'This posting has no text saved, so Claude cannot score it again.'
  else if (!stats.scored) message = plainError(stats.errors[0]) || 'Claude did not return a score. Try again in a minute.'
  return {
    ok: stats.scored > 0,
    message,
    score: parseJson<ScoreBreakdown | null>(job.scoreBreakdown, null),
    requirements: parseJson<Requirement[]>(job.requirementsJson, []),
    matchScore: job.matchScore,
    previousScore,
  }
}

/**
 * Applies an answered skill or experience question to every open job's requirement statuses, the
 * same way a tapped chip changes its own job: a requirement whose text is the same skill becomes
 * Have after Yes, Partly after Some experience (from Unknown or Missing), Missing after No (from
 * Unknown or Partly). A Have is never lowered. Changed jobs are queued for a fresh skills score.
 * Without this, statuses judged at enrichment kept saying Unknown after Devin answered.
 * Idempotent; sandbox jobs and jobs with a submitted, approved, or declined application are left alone.
 */
export function applyAnswerToOpenJobs(subject: string | null | undefined, answer: string | null | undefined, evidence: string | null): number {
  const yn = answer ? parseYesNo(answer) : null
  if (!subject?.trim() || !yn || !evidence) return 0
  const key = skillClaimKey(subject)
  if (!key) return 0
  const db = useDb()
  const closed = new Set(db.select({ jobId: applications.jobId }).from(applications)
    .where(inArray(applications.status, ['submitted', 'declined', 'approved', 'submitting'])).all().map(r => r.jobId))
  const open = db.select().from(jobs).all()
    .filter(j => j.requirementsJson && !j.isSandbox && !closed.has(j.id) && !['rejected', 'expired'].includes(j.status ?? ''))
  let changedJobs = 0
  for (const job of open) {
    const reqs = parseJson<Requirement[]>(job.requirementsJson, [])
    let changed = 0
    const next = reqs.map((r) => {
      if (skillClaimKey(r.text) !== key) return r
      let status: Requirement['status'] = r.status
      if (yn === 'yes' && r.status !== 'have') status = 'have'
      else if (yn === 'some' && (r.status === 'unknown' || r.status === 'lack')) status = 'partial'
      else if (yn === 'no' && (r.status === 'unknown' || r.status === 'partial')) status = 'lack'
      if (status === r.status) return r
      changed++
      return { ...r, status, evidence }
    })
    if (!changed) continue
    db.update(jobs).set({ requirementsJson: JSON.stringify(next), scoredAt: null }).where(eq(jobs.id, job.id)).run()
    changedJobs++
  }
  return changedJobs
}

/** Every answered skill or experience question applied to open jobs (catches answers given before this existed). */
export function applyAllAnswersToOpenJobs(): number {
  const rows = useDb().select().from(questions)
    .where(and(eq(questions.status, 'answered'), inArray(questions.kind, ['knows', 'has_done'])))
    .all()
  let n = 0
  for (const q of rows) {
    const k = q.knowledgeKey ?? ''
    const i = k.indexOf(':')
    n += applyAnswerToOpenJobs(q.subject, q.answer, i > 0 ? `${k.slice(0, i)}/${k.slice(i + 1)}` : null)
  }
  return n
}
