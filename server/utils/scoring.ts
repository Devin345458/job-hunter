import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { z } from 'zod'
import { applications, jobs, questions, scoreHistory } from '../db/schema'
import type { CompensationBreakdown, Requirement, ScoreBreakdown } from '#shared/types/pipeline'
import { aiSpentToday, aiStructured, AiBudgetExceeded, cachedPrompt } from './ai'
import { askCompQuestions, type CompPreferences, type CompScore, FLOOR_SUBJECT, HEALTH_SUBJECT, loadCompPreferences, scoreCompensation } from './compensation'
import { type KnowledgeEntry, loadKnowledge } from './knowledge'
import { learnedAdjustment } from './learned-score'
import { dedupeKeyOf } from './questions'
import { htmlToText, nowSql, parseJson } from './review'
import { isPrefilterSkip } from './enrich'
import { knowledgeBlock } from './enrich/extract'
import { mapPool } from './job-sources/http'
import { applyJudgments, askGapQuestions, skillQuestions } from './skills-judge'

// Owned by capability A (matching). Learning (capability D) calls rescoreJobs after rules
// change, so the next queue reflects them without a new Claude call per job.
//
// Final score = 0.6 x skills + 0.4 x compensation + learned adjustment, clamped 0 to 100.
// When the posting states no pay, compensation is null and skills carry the full weight.
// Skills come from one Claude call per job (purpose match_gaps), reused until the posting is
// enriched again. Since decide-first the same call judges every requirement and plans the gaps
// (server/utils/skills-judge.ts): code computes the must-have share (0 to 45) from the final
// statuses, and the call scores stack 25, seniority 20, and domain 10. Code sums the four.
// Compensation and the learned adjustment are computed in code on every score and rescore.

type JobRow = InferSelectModel<typeof jobs>

export const SCORE_WEIGHTS = { skills: 0.6, compensation: 0.4 } as const
/** Jobs sent to Claude for a skills score per jobs:match run. */
/** Jobs one request scores at most (scoreJobs). The jobs:match step has no cap: it queues every unscored job. */
export const MATCH_LIMIT = 60

// Haiku collapses a single 0 to 100 score onto a few values (62 again and again), which makes
// the ranking arbitrary. It scores four bounded parts instead, and code adds them up.
const SKILL_PARTS = { mustHaves: 45, stack: 25, seniority: 20, domain: 10 } as const

/** The merged scoring call's purpose in ai_calls (and in NUXT_AI_STEP_MODELS). The old skills-only call was 'match'. */
export const MATCH_GAPS_PURPOSE = 'match_gaps'

const JudgmentSchema = z.object({
  index: z.number().int().describe('The requirement number from the list'),
  status: z.string().describe('"have", "reframe", "partial", "lack", or "unknown"'),
  evidence: z.string().nullable().describe('The knowledge base key from inside the square brackets, such as skill/Laravel. Null for unknown.'),
  subject: z.string().describe('The skill, language, tool, or experience in two to five words, e.g. "Go", "Kubernetes in production"'),
  askKind: z.string().describe('"has_done" for experience or practice, "knows" for a language or tool'),
  question: z.string().nullable().describe('For unknown only: a yes or no question for the candidate, e.g. "Have you used Go in a real project?" Null otherwise.'),
  codeShowable: z.boolean().describe('True only when a small code project could show this: a language, framework, tool, platform, or technical technique. False for experience a project cannot show: presenting or giving live demos, customer or stakeholder work, leading people, running something in production at scale, on-call, industry or domain experience. Also false when the requirement joins a technique to production scale or reliability ("at scale", "in production", "reliable and scalable"), because a small project cannot show the scale.'),
  rationale: z.string().describe('One plain sentence on the status, addressed to "you". For reframe, name the entry and say how it covers the requirement. No dashes.'),
  demoIdea: z.object({
    title: z.string().describe('Short project name, title case, no more than five words'),
    summary: z.string().describe('Two sentences: what the project does and what it shows'),
    stack: z.array(z.string()).describe('Language first, then libraries, e.g. ["Go", "net/http", "testing"]'),
    scopeHours: z.number().describe('Hours of focused human work'),
  }).nullable().describe('Only for partial or lack when a small demo project would show the skill directly (see the demo rules). Null otherwise.'),
  inGapPlan: z.boolean().describe('False for the kinds under "Leave out of the gap plan"; true otherwise.'),
})

const SkillsSchema = z.object({
  requirements: z.array(JudgmentSchema).describe('One judgment per numbered requirement, in order. Empty when no requirements were listed.'),
  mustHaves: z.number().describe('0 to 45: your estimate of the share of must-have requirements the candidate has. Used only when no requirements were listed.'),
  stack: z.number().describe('0 to 25: how close the main languages and frameworks are to the candidate\'s primary stack.'),
  seniority: z.number().describe('0 to 20: role level against the candidate\'s target role and years of experience.'),
  domain: z.number().describe('0 to 10: how close the industry or product domain is to work the candidate has done.'),
  reasoning: z.string().describe('Two or three plain sentences naming the biggest strengths and gaps, agreeing with your judgments. Address the job seeker as "you" ("You have Laravel and Vue; you have not used Go."). Never refer to the job seeker as he, she, or they. Plain American English with no dashes.'),
  matched: z.array(z.string()).describe('Only when no requirements were listed: short names of requirements the candidate has. Otherwise empty.'),
  missing: z.array(z.string()).describe('Only when no requirements were listed: short names of must-have requirements the candidate lacks or that the knowledge base does not mention. Otherwise empty.'),
})

type SkillsResult = ScoreBreakdown['skills']

function requirementLines(reqs: Requirement[]): string {
  if (!reqs.length) return 'None extracted. Read them from the posting, and leave the requirements list in your answer empty.'
  return reqs.map((r, i) => `${i + 1}. [${r.mustHave ? 'must' : 'nice'}] ${r.text} (kind: ${r.kind}): stored status ${r.status}${r.evidence ? ` (${r.evidence})` : ''}`).join('\n')
}

/** Knows and has_done questions already asked, so the call reuses their subjects and honors the answers. */
function askedLines(rows: Array<{ status: string; kind: string | null; subject: string | null; question: string; answer: string | null }>): string {
  const order = { answered: 0, skipped: 1, pending: 2 } as Record<string, number>
  const lines = [...rows]
    .sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3))
    .slice(0, 150)
    .map(q => `- [${q.status}] ${q.kind} "${q.subject}": ${q.question}${q.answer ? ` Answer: ${q.answer}` : ''}`)
  return lines.join('\n') || '(none)'
}

/**
 * The merged scoring prompt (decide-first): one call judges every requirement against the
 * knowledge base, decides what to do about each gap, and scores the parts of the fit the
 * statuses do not decide. Code computes the must-have share from the final statuses
 * (server/utils/skills-judge.ts). It carries the rules of the old match and gap_candidates and
 * gap_decisions prompts: stored statuses are re-checked, years are compared with the profile
 * entry, and the gap leave-out list applies.
 */
export function skillsPrompt(job: Pick<JobRow, 'title' | 'company' | 'location'>, postingText: string, reqs: Requirement[], entries: KnowledgeEntry[], asked: Parameters<typeof askedLines>[0] = []) {
  // Cached blocks, most stable first: the instructions, the knowledge base (changes when Devin
  // saves an answer), the questions already asked (change when one is asked or answered), then
  // this job's requirements and posting.
  return cachedPrompt([
    SKILLS_INSTRUCTIONS,
    `\n\n## Candidate knowledge base\n${knowledgeBlock(entries)}`,
    `\n\n## Questions already asked\n${askedLines(asked)}`,
  ], `\n\n## Requirements
${requirementLines(reqs)}

## Job
Title: ${job.title}
Company: ${job.company}
Location: ${job.location ?? 'not stated'}

${postingText.slice(0, 8000)}`)
}

const SKILLS_INSTRUCTIONS = `Judge how well this candidate's skills and experience fit this job: first every requirement, then three parts of the fit.

Use only the candidate knowledge base and the candidate's answered questions below. Do not assume skills they do not list.
The stored statuses below came from an earlier step and can be wrong. Judge every requirement again: before you say have or reframe, check that a knowledge base entry shows it. Compare every years requirement with profile/Years of Experience yourself: a requirement for more years than that entry states is lack, whatever its stored status says.
An answered question is the candidate's own word: a No answer is lack, a Yes answer is have.

## Part 1: one judgment per numbered requirement
- status:
  - have: an entry directly shows it (the same technology, or stated years that meet it). An entry for a specific technology also shows the general skill it is an example of: MySQL shows SQL, AWS shows cloud platforms, GitHub Actions shows CI/CD. The reverse is not have: a general entry does not show a product it does not name (AWS does not show ECS). When the posting accepts alternatives ("PostgreSQL or MySQL"), an entry that shows any one of them is have.
  - reframe: no entry names it, but real experience in one entry covers what the requirement asks for, so a hiring manager would accept it (for example Express in production for a requirement of "a Node.js web framework"). Cite that entry in evidence and say in the rationale how it covers the requirement. Never reframe a different technology the posting names on its own (Vue does not cover React), more years than the profile states, or production scale the entries do not state.
  - partial: an entry shows something close but not enough (an adjacent technology, fewer years, a nearby domain). Cite it.
  - lack: an entry or an answered question says the candidate does not have it. Cite the entry when there is one.
  - unknown: the knowledge base does not mention it. Use unknown whenever you would otherwise be guessing.
- evidence: for have, reframe, partial, or lack, the key of the entry, copied exactly from inside the square brackets (for example skill/Laravel). Null for unknown. A status without a real key counts as unknown.
- subject, askKind, question: when a question was already asked about the same thing, reuse its exact subject text. Write the question so the candidate can answer yes or no in one tap.
- Leave out of the gap plan (inGapPlan false, question null, no demo idea, but still give a status): soft skills and attitudes (communication, language fluency, reliability, adaptability, ownership, openness to or curiosity about a tool), leadership, years of experience, education, work authorization, and location.
- Demo rules: give a demoIdea only for a partial or lack must have (or a duty the posting names) when a small, credible, self-contained public project of about four hours would show the skill directly: written in that language or built around that tool, runnable and testable offline with nothing but its own code and package dependencies (no cloud accounts, paid APIs, API keys, or database servers), and something a senior web developer could read end to end and explain in an interview. At most one per job. Keep it modest (a webhook receiver with signature checks and retries, not a platform). Never one for years, degrees, certifications, industry experience, leadership, production scale, data volume, or on-call history.

## Part 2: three parts of the fit (code adds the must-have share from your statuses)
Use any whole number inside each range, not only round numbers.
- stack (0 to 25): the job's main languages and frameworks against the candidate's primary stack. 25 = the same primary stack, 15 = related (same language, different framework, or the reverse), 5 = a different stack the candidate could learn, 0 = an unrelated discipline such as hardware, data science, or sales.
- seniority (0 to 20): the role level against the candidate's target role and years of experience. 20 = the right level, 10 = one step off (for example staff when the candidate targets senior, or a large-team people manager), 0 = far off or not a software engineering role.
- domain (0 to 10): the industry or product domain against work the candidate has done. 10 = the same domain, 5 = nearby, 0 = unrelated or highly specialized (for example kernel, chip, or quantitative trading work).
- mustHaves (0 to 45): only used when no requirements are listed. 45 = all of the must-haves, 22 = half, 0 = none; a partial match counts as half.

Plain American English. No dashes. Quote the knowledge base as written; never add years, numbers, or facts about the candidate that it does not state.`

/**
 * The skills score and the gap plan from one Claude call, with the posting requirements as their
 * final statuses say. The must-have share comes from those statuses in code; stack, seniority, and
 * domain come from the call.
 */
async function scoreSkills(job: JobRow, postingText: string, reqs: Requirement[], entries: KnowledgeEntry[]): Promise<{ skills: SkillsResult; requirements: Requirement[] }> {
  const asked = skillQuestions()
  const out = await aiStructured(SkillsSchema, {
    purpose: MATCH_GAPS_PURPOSE,
    system: 'You judge job fit for a job seeker\'s automated pipeline. You are realistic, you do not inflate scores, you never credit the candidate with a skill the knowledge base does not show, and you are careful about anything that will be said under the candidate\'s name.',
    prompt: skillsPrompt(job, postingText, reqs, entries, asked),
    effort: 'low',
    maxTokens: 10000,
    ref: { type: 'job', id: job.id },
  })
  const part = (value: number, max: number) => Math.max(0, Math.min(max, Math.round(Number(value) || 0)))
  const judged = await applyJudgments(reqs, out.requirements, entries, asked)
  const fromStatuses = judged.mustHaves != null
  const parts = {
    mustHaves: fromStatuses ? judged.mustHaves! : part(out.mustHaves, SKILL_PARTS.mustHaves),
    stack: part(out.stack, SKILL_PARTS.stack),
    seniority: part(out.seniority, SKILL_PARTS.seniority),
    domain: part(out.domain, SKILL_PARTS.domain),
  }
  const gap = reqs.length ? judged.gap : { items: [], demoRecommended: false, summary: 'The posting has no requirements to compare.', analyzedAt: new Date().toISOString() }
  return {
    requirements: judged.requirements,
    skills: {
      score: parts.mustHaves + parts.stack + parts.seniority + parts.domain,
      parts,
      reasoning: out.reasoning.trim(),
      matched: reqs.length ? judged.matched : out.matched.slice(0, 15),
      missing: reqs.length ? judged.missing : out.missing.slice(0, 15),
      gap,
      mustHavesFromStatuses: fromStatuses,
    },
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

/** Enriched jobs with no skills score yet, or whose posting was read again after the last score. Newest posting first. */
export function pendingScoreJobs(): JobRow[] {
  return useDb().select().from(jobs).where(and(
    isNotNull(jobs.enrichedAt),
    or(isNull(jobs.enrichError), sql`${jobs.enrichError} NOT LIKE 'Skipped by prefilter:%'`),
    sql`${jobs.status} != 'expired'`,
    or(isNull(jobs.skillsScore), isNull(jobs.scoredAt), lt(jobs.scoredAt, jobs.enrichedAt)),
  )).all()
    .filter(j => !isPrefilterSkip(j.enrichError))
    .sort((a, b) => (b.postedAt ?? b.foundAt).localeCompare(a.postedAt ?? a.foundAt) || b.id - a.id)
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
    let skills: SkillsResult
    if (reuse) skills = previous!.skills
    else {
      const scored = await scoreSkills(job, text!, parseJson<Requirement[]>(job.requirementsJson, []), ctx.entries)
      skills = scored.skills
      // The final statuses go back on the job, so the card's Matched and Missing chips, the score,
      // and the gap plan read the same statuses.
      if (scored.requirements.length) {
        useDb().update(jobs).set({ requirementsJson: JSON.stringify(scored.requirements) }).where(eq(jobs.id, job.id)).run()
        job = { ...job, requirementsJson: JSON.stringify(scored.requirements) }
      }
    }
    const comp = parseJson<CompensationBreakdown | null>(job.compJson, null)
    const qids = askCompQuestions(ctx.prefs, comp, job.id)
    const breakdown = composeBreakdown(skills, scoreCompensation(comp, ctx.prefs, qids), learnedAdjustment(job))
    writeScore(job, breakdown, job.matchScore == null ? 'initial' : 'rescore')
    if (!reuse && skills.gap) refreshDecideGap(job, skills.gap)
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

/**
 * A job with a Decide card that was scored again: the card's copy of the gap plan follows the new
 * one, with its open questions asked (the job is at the threshold, or its card is hidden anyway).
 */
function refreshDecideGap(job: JobRow, gap: NonNullable<SkillsResult['gap']>) {
  const app = useDb().select({ id: applications.id }).from(applications)
    .where(and(eq(applications.jobId, job.id), eq(applications.status, 'to_decide'))).get()
  if (!app) return
  const before = parseJson<NonNullable<SkillsResult['gap']> | null>(useDb().select({ g: applications.gapAnalysisJson }).from(applications).where(eq(applications.id, app.id)).get()?.g, null)
  const plan = askGapQuestions(gap, { applicationId: app.id, job }, before)
  useDb().update(applications).set({ gapAnalysisJson: JSON.stringify(plan), updatedAt: nowSql() }).where(eq(applications.id, app.id)).run()
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
