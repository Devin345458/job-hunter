import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { z } from 'zod'
import { applications, jobs, questions, scoreHistory } from '../db/schema'
import type { CompensationBreakdown, Requirement, ScoreBreakdown } from '#shared/types/pipeline'
import { aiSpentToday, aiStructured, AiBudgetExceeded } from './ai'
import { askCompQuestions, type CompPreferences, type CompScore, FLOOR_SUBJECT, HEALTH_SUBJECT, loadCompPreferences, scoreCompensation } from './compensation'
import { type KnowledgeEntry, loadKnowledge } from './knowledge'
import { learnedAdjustment } from './learned-score'
import { dedupeKeyOf } from './questions'
import { htmlToText, nowSql, parseJson } from './review'
import { isPrefilterSkip } from './enrich'
import { knowledgeBlock } from './enrich/extract'
import { mapPool } from './job-sources/http'

// Owned by capability A (matching). Learning (capability D) calls rescoreJobs after rules
// change, so the next queue reflects them without a new Claude call per job.
//
// Final score = 0.6 x skills + 0.4 x compensation + learned adjustment, clamped 0 to 100.
// When the posting states no pay, compensation is null and skills carry the full weight.
// Skills come from one Claude call per job, reused until the posting is enriched again. The
// call returns four bounded parts (must-haves 45, stack 25, seniority 20, domain 10) that code sums.
// Compensation and the learned adjustment are computed in code on every score and rescore.

type JobRow = InferSelectModel<typeof jobs>

export const SCORE_WEIGHTS = { skills: 0.6, compensation: 0.4 } as const
/** Jobs sent to Claude for a skills score per jobs:match run. */
/** Jobs one request scores at most (scoreJobs). The jobs:match step has no cap: it queues every unscored job. */
export const MATCH_LIMIT = 60

// Haiku collapses a single 0 to 100 score onto a few values (62 again and again), which makes
// the ranking arbitrary. It scores four bounded parts instead, and code adds them up.
const SKILL_PARTS = { mustHaves: 45, stack: 25, seniority: 20, domain: 10 } as const

const SkillsSchema = z.object({
  mustHaves: z.number().describe('0 to 45: share of the must-have requirements the candidate has.'),
  stack: z.number().describe('0 to 25: how close the main languages and frameworks are to the candidate\'s primary stack.'),
  seniority: z.number().describe('0 to 20: role level against the candidate\'s target role and years of experience.'),
  domain: z.number().describe('0 to 10: how close the industry or product domain is to work the candidate has done.'),
  reasoning: z.string().describe('Two or three plain sentences naming the biggest strengths and gaps. Address the job seeker as "you" ("You have Laravel and Vue; you have not used Go."). Never refer to the job seeker as he, she, or they. Plain American English with no dashes.'),
  matched: z.array(z.string()).describe('Short names of requirements the candidate has.'),
  missing: z.array(z.string()).describe('Short names of must-have requirements the candidate lacks or that the knowledge base does not mention.'),
})

type SkillsResult = ScoreBreakdown['skills']

function requirementLines(reqs: Requirement[]): string {
  if (!reqs.length) return 'None extracted. Read them from the posting.'
  return reqs.map(r => `- [${r.mustHave ? 'must' : 'nice'}] ${r.text}: ${r.status}${r.evidence ? ` (${r.evidence})` : ''}`).join('\n')
}

export function skillsPrompt(job: Pick<JobRow, 'title' | 'company' | 'location'>, postingText: string, reqs: Requirement[], entries: KnowledgeEntry[]): string {
  return `Score how well this candidate's skills and experience fit this job, in four parts.

Use only the candidate knowledge base below. Do not assume skills it does not list.
Requirements marked unknown are not in the knowledge base. Count them as gaps, never as skills the candidate has.
The statuses below came from an earlier step and can be wrong. Before you list a requirement as matched, check that a knowledge base entry shows it. Compare every years requirement with profile/Years of Experience yourself: a requirement for more years than that entry states is not met, whatever its status says.
Use any whole number inside each range, not only round numbers.

- mustHaves (0 to 45): the share of must-have requirements the candidate has. 45 = all of them, 34 = three quarters, 22 = half, 11 = a quarter, 0 = none. A partial match counts as half.
- stack (0 to 25): the job's main languages and frameworks against the candidate's primary stack. 25 = the same primary stack, 15 = related (same language, different framework, or the reverse), 5 = a different stack the candidate could learn, 0 = an unrelated discipline such as hardware, data science, or sales.
- seniority (0 to 20): the role level against the candidate's target role and years of experience. 20 = the right level, 10 = one step off (for example staff when the candidate targets senior, or a large-team people manager), 0 = far off or not a software engineering role.
- domain (0 to 10): the industry or product domain against work the candidate has done. 10 = the same domain, 5 = nearby, 0 = unrelated or highly specialized (for example kernel, chip, or quantitative trading work).

## Requirements already judged against the knowledge base
${requirementLines(reqs)}

## Candidate knowledge base
${knowledgeBlock(entries)}

## Job
Title: ${job.title}
Company: ${job.company}
Location: ${job.location ?? 'not stated'}

${postingText.slice(0, 8000)}`
}

async function scoreSkills(job: JobRow, postingText: string, reqs: Requirement[], entries: KnowledgeEntry[]): Promise<SkillsResult> {
  const out = await aiStructured(SkillsSchema, {
    purpose: 'match',
    system: 'You score job fit for a job seeker\'s automated pipeline. You are realistic, you do not inflate scores, and you never credit the candidate with a skill the knowledge base does not show.',
    prompt: skillsPrompt(job, postingText, reqs, entries),
    effort: 'low',
    maxTokens: 2000,
    ref: { type: 'job', id: job.id },
  })
  const part = (value: number, max: number) => Math.max(0, Math.min(max, Math.round(Number(value) || 0)))
  const parts = {
    mustHaves: part(out.mustHaves, SKILL_PARTS.mustHaves),
    stack: part(out.stack, SKILL_PARTS.stack),
    seniority: part(out.seniority, SKILL_PARTS.seniority),
    domain: part(out.domain, SKILL_PARTS.domain),
  }
  return {
    score: parts.mustHaves + parts.stack + parts.seniority + parts.domain,
    parts,
    reasoning: out.reasoning.trim(),
    matched: out.matched.slice(0, 15),
    missing: out.missing.slice(0, 15),
  }
}

export function recommendationOf(final: number): ScoreBreakdown['recommendation'] {
  if (final >= 80) return 'strong_match'
  if (final >= 65) return 'good_match'
  if (final >= 45) return 'partial_match'
  return 'weak_match'
}

export function composeBreakdown(skills: SkillsResult, comp: CompScore, learned: ScoreBreakdown['learned']): ScoreBreakdown {
  const weights = comp.score == null ? { skills: 1, compensation: 0 } : { ...SCORE_WEIGHTS }
  const weighted = weights.skills * skills.score + weights.compensation * (comp.score ?? 0)
  const final = Math.max(0, Math.min(100, Math.round(weighted) + learned.total))
  return {
    final,
    skills,
    compensation: { score: comp.score, reasoning: comp.reasoning, floor: comp.floor, target: comp.target, estimate: comp.estimate, meetsFloor: comp.meetsFloor },
    learned,
    weights,
    recommendation: recommendationOf(final),
    computedAt: new Date().toISOString(),
  }
}

function summaryText(b: ScoreBreakdown): string {
  const learned = b.learned.total ? ` Learned adjustment ${b.learned.total > 0 ? '+' : ''}${b.learned.total}.` : ''
  return `Skills ${b.skills.score}/100: ${b.skills.reasoning} Compensation ${b.compensation.score == null ? 'not scored' : `${b.compensation.score}/100`}: ${b.compensation.reasoning}${learned}`
}

/** Writes the score columns, and a score_history row when the final score changed. */
function writeScore(job: JobRow, b: ScoreBreakdown, reason: 'initial' | 'rescore' | 'rule_change') {
  const db = useDb()
  db.update(jobs).set({
    skillsScore: b.skills.score,
    compScore: b.compensation.score,
    learnedAdjustment: b.learned.total,
    scoreBreakdown: JSON.stringify(b),
    matchScore: b.final,
    matchReasoning: summaryText(b),
    scoredAt: nowSql(),
  }).where(eq(jobs.id, job.id)).run()
  const hasHistory = !!db.select({ id: scoreHistory.id }).from(scoreHistory).where(eq(scoreHistory.jobId, job.id)).limit(1).get()
  if (!hasHistory || job.matchScore !== b.final) {
    db.insert(scoreHistory).values({
      jobId: job.id,
      score: b.final,
      skillsScore: b.skills.score,
      compScore: b.compensation.score,
      learnedAdjustment: b.learned.total,
      breakdownJson: JSON.stringify(b),
      reason: hasHistory ? reason : 'initial',
    }).run()
  }
}

/** Ids of preference questions already pending, so a rescore can point at them without asking again. */
function pendingPreferenceQuestionIds(): { floorQuestionId: number | null; healthQuestionId: number | null } {
  const rows = useDb().select({ id: questions.id, dedupeKey: questions.dedupeKey }).from(questions)
    .where(and(eq(questions.status, 'pending'), inArray(questions.dedupeKey, [dedupeKeyOf('preference', FLOOR_SUBJECT), dedupeKeyOf('preference', HEALTH_SUBJECT)])))
    .all()
  return {
    floorQuestionId: rows.find(r => r.dedupeKey === dedupeKeyOf('preference', FLOOR_SUBJECT))?.id ?? null,
    healthQuestionId: rows.find(r => r.dedupeKey === dedupeKeyOf('preference', HEALTH_SUBJECT))?.id ?? null,
  }
}

function scoreFromStored(job: JobRow, skills: SkillsResult, prefs: CompPreferences, questionIds: { floorQuestionId: number | null; healthQuestionId: number | null }): ScoreBreakdown {
  const comp = parseJson<CompensationBreakdown | null>(job.compJson, null)
  return composeBreakdown(skills, scoreCompensation(comp, prefs, questionIds), learnedAdjustment(job))
}

export interface MatchStats extends Record<string, unknown> {
  pending: number
  scored: number
  reusedSkills: number
  failed: number
  noText: number
  budgetStopped: boolean
  questionsAsked: number[]
  rescored: number
  costUsd: number
  errors: string[]
}

/** The outcome of scoring one job. 'budget' leaves it unscored for the next day. */
export type ScoreOutcome = 'scored' | 'reused' | 'noText' | 'failed' | 'budget' | 'already'

export interface ScoreOneResult extends Record<string, unknown> {
  jobId: number
  outcome: ScoreOutcome
  final?: number
  /** Preference questions this score asked or pointed at. */
  asked?: number[]
  error?: string
}

/** Enriched jobs with no skills score yet, or whose posting was read again after the last score. Newest first. */
export function pendingScoreJobs(): JobRow[] {
  return useDb().select().from(jobs).where(and(
    isNotNull(jobs.enrichedAt),
    or(isNull(jobs.enrichError), sql`${jobs.enrichError} NOT LIKE 'Skipped by prefilter:%'`),
    sql`${jobs.status} != 'expired'`,
    or(isNull(jobs.skillsScore), isNull(jobs.scoredAt), lt(jobs.scoredAt, jobs.enrichedAt)),
  )).all()
    .filter(j => !isPrefilterSkip(j.enrichError))
    .sort((a, b) => b.foundAt.localeCompare(a.foundAt))
}

/**
 * Scores one job: one Claude call for the skills score (reused when the stored one is newer than
 * the posting, unless fresh), then compensation and learned rules in code. A budget or credit stop
 * leaves the job unscored, so it is scored once the budget allows.
 */
export async function scoreOne(job: JobRow, ctx: { entries: KnowledgeEntry[]; prefs: CompPreferences; fresh?: boolean }, log: (msg: string) => void = console.log): Promise<ScoreOneResult> {
  const text = job.postingText || htmlToText(job.description)
  const previous = parseJson<ScoreBreakdown | null>(job.scoreBreakdown, null)
  const reuse = !ctx.fresh && !!previous && job.skillsScore != null && !!job.scoredAt && !!job.enrichedAt && job.scoredAt >= job.enrichedAt
  if (!text && !reuse) return { jobId: job.id, outcome: 'noText' }
  try {
    const skills = reuse ? previous!.skills : await scoreSkills(job, text!, parseJson<Requirement[]>(job.requirementsJson, []), ctx.entries)
    const comp = parseJson<CompensationBreakdown | null>(job.compJson, null)
    const qids = askCompQuestions(ctx.prefs, comp, job.id)
    const breakdown = composeBreakdown(skills, scoreCompensation(comp, ctx.prefs, qids), learnedAdjustment(job))
    writeScore(job, breakdown, job.matchScore == null ? 'initial' : 'rescore')
    log(`#${job.id} ${job.company} | ${job.title}: final ${breakdown.final} (skills ${skills.score}, comp ${breakdown.compensation.score ?? 'n/a'}, learned ${breakdown.learned.total})`)
    return { jobId: job.id, outcome: reuse ? 'reused' : 'scored', final: breakdown.final, asked: [qids.floorQuestionId, qids.healthQuestionId].filter((id): id is number => !!id) }
  }
  catch (e: any) {
    if (e instanceof AiBudgetExceeded) return { jobId: job.id, outcome: 'budget', error: e.message }
    const message = String(e?.message || e).slice(0, 300)
    log(`#${job.id} failed: ${message}`)
    return { jobId: job.id, outcome: 'failed', error: message }
  }
}

export function emptyMatchStats(): MatchStats {
  return { pending: 0, scored: 0, reusedSkills: 0, failed: 0, noText: 0, budgetStopped: false, questionsAsked: [], rescored: 0, costUsd: 0, errors: [] }
}

/** Adds one job's result to a run's counts (scoreJobs, and the jobs:match step over its queue items). */
export function tallyScore(stats: MatchStats, r: ScoreOneResult) {
  if (r.outcome === 'scored') stats.scored++
  else if (r.outcome === 'reused') { stats.scored++; stats.reusedSkills++ }
  else if (r.outcome === 'noText') stats.noText++
  else if (r.outcome === 'budget') {
    stats.budgetStopped = true
    if (r.error && !stats.errors.includes(r.error)) stats.errors.push(r.error)
  }
  else if (r.outcome === 'failed') {
    stats.failed++
    stats.errors.push(`#${r.jobId}: ${r.error ?? 'failed'}`)
  }
  for (const id of r.asked ?? []) if (!stats.questionsAsked.includes(id)) stats.questionsAsked.push(id)
}

/**
 * Scores jobs inside one request (POST /api/jobs/match, the skill panel), four at a time, then
 * rescores every open job in code when no jobIds were given. The jobs:match step does not use it
 * anymore: it queues one jobs:match-one item per job. fresh asks Claude again even when the stored
 * skills score is newer than the posting: the skill panel uses it after an answer changes the
 * knowledge base.
 */
export async function scoreJobs(opts: { jobIds?: number[]; limit?: number; fresh?: boolean; log?: (msg: string) => void } = {}): Promise<MatchStats> {
  const db = useDb()
  const log = opts.log ?? console.log
  const stats = emptyMatchStats()

  const rows = opts.jobIds?.length ? db.select().from(jobs).where(inArray(jobs.id, opts.jobIds)).all() : pendingScoreJobs()
  const todo = opts.jobIds?.length ? rows : rows.slice(0, opts.limit ?? MATCH_LIMIT)
  stats.pending = rows.length
  log(`${rows.length} jobs need a skills score, scoring ${todo.length}`)

  const ctx = { entries: loadKnowledge(), prefs: loadCompPreferences(), fresh: opts.fresh }
  const spentBefore = aiSpentToday()
  await mapPool(todo, 4, async (job) => {
    if (stats.budgetStopped) return
    tallyScore(stats, await scoreOne(job, ctx, log))
  })

  if (!opts.jobIds?.length) stats.rescored = (await rescoreJobs('open', 'rescore')).rescored
  stats.costUsd = Math.round((aiSpentToday() - spentBefore) * 10000) / 10000
  stats.errors = stats.errors.slice(0, 10)
  return stats
}

/**
 * Recomputes final scores from the stored skills score, the stored compensation, the current
 * preferences, and the current learned rules. No Claude calls.
 * 'open' means every scored job whose status is new or reviewed.
 * Writes a job only when its breakdown changed, and a score_history row only when the final changed.
 */
/**
 * After Devin answers a skill or experience question, the skills judgment of other open jobs that
 * name that skill is out of date (rescoreJobs only recombines stored scores). This clears their
 * scoredAt so the next jobs:match run judges their skills again with the new knowledge base.
 * Only open jobs scoring 50 or more, without a submitted or declined application, so a common
 * skill does not queue hundreds of Claude calls. A subject of three characters or fewer ("Go")
 * must match as a whole word with its own capitalization; longer ones ignore case.
 */
export function queueSkillRescore(subject: string | null | undefined, exceptJobIds: number[] = [], answeredAt: string | null = null): number {
  const s = (subject ?? '').trim()
  if (s.length < 2) return 0
  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = s.length <= 3 ? new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`) : new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`, 'i')
  const db = useDb()
  const closed = new Set(db.select({ jobId: applications.jobId }).from(applications)
    .where(inArray(applications.status, ['submitted', 'declined', 'approved', 'submitting'])).all().map(r => r.jobId))
  const rows = db.select({ id: jobs.id, breakdown: jobs.scoreBreakdown, scoredAt: jobs.scoredAt }).from(jobs)
    .where(and(isNotNull(jobs.scoredAt), sql`${jobs.matchScore} >= 50`, sql`${jobs.status} not in ('rejected', 'expired')`))
    .all()
    .filter(r => !closed.has(r.id) && !exceptJobIds.includes(r.id) && (!answeredAt || (r.scoredAt ?? '') < answeredAt) && re.test(r.breakdown ?? ''))
  if (!rows.length) return 0
  db.update(jobs).set({ scoredAt: null }).where(inArray(jobs.id, rows.map(r => r.id))).run()
  return rows.length
}

/**
 * Skill judgments made before a related answer: for every answered skill or experience question,
 * open jobs that name its subject and were scored before the answer are queued for re-scoring.
 * Catches answers given before queueSkillRescore existed, and any path that missed it. Idempotent:
 * a re-scored job is newer than the answer and is left alone.
 */
export function queueStaleSkillJudgments(): number {
  const answered = useDb().select({ subject: questions.subject, answeredAt: questions.answeredAt }).from(questions)
    .where(and(eq(questions.status, 'answered'), inArray(questions.kind, ['knows', 'has_done']), isNotNull(questions.answeredAt)))
    .all()
  let queued = 0
  for (const q of answered) queued += queueSkillRescore(q.subject, [], q.answeredAt)
  return queued
}

export async function rescoreJobs(jobIds: number[] | 'open', reason: 'rescore' | 'rule_change'): Promise<{ rescored: number }> {
  const db = useDb()
  const rows = jobIds === 'open'
    ? db.select().from(jobs).where(and(isNotNull(jobs.scoreBreakdown), inArray(jobs.status, ['new', 'reviewed']))).all()
    : jobIds.length ? db.select().from(jobs).where(and(isNotNull(jobs.scoreBreakdown), inArray(jobs.id, jobIds))).all() : []
  if (!rows.length) return { rescored: 0 }
  const prefs = loadCompPreferences()
  const questionIds = pendingPreferenceQuestionIds()
  let rescored = 0
  for (const job of rows) {
    const previous = parseJson<ScoreBreakdown | null>(job.scoreBreakdown, null)
    if (!previous?.skills) continue
    const next = scoreFromStored(job, previous.skills, prefs, questionIds)
    const same = JSON.stringify({ ...previous, computedAt: '' }) === JSON.stringify({ ...next, computedAt: '' })
    if (same) continue
    writeScore(job, next, reason)
    rescored++
  }
  return { rescored }
}
