import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { aiCalls, jobs, pipelineRuns, taskQueue } from '../db/schema'
import { emptyEnrichStats, enrichOne, needsEnrich, pendingEnrichJobs, prefilterContext, prefilterPending, sharedBoardCache, tallyEnrich, type EnrichOneResult, type EnrichStats } from './enrich'
import { emptyMatchStats, MATCH_GAPS_PURPOSE, pendingScoreJobs, rescoreJobs, scoreOne, tallyScore, type MatchStats, type ScoreOneResult } from './scoring'
import { loadCompPreferences } from './compensation'
import { loadKnowledge } from './knowledge'
import type { RunTrigger } from './runs'

// Reading postings and scoring jobs, one queue item per job and no cap per run:
// - jobs:search queues a jobs:enrich-one item for every new job;
// - an enrich-one that read its posting queues the job's jobs:match-one item;
// - the jobs:enrich and jobs:match steps (daily run, or Run in Settings) queue an item for every
//   job still waiting that has none, wait for the items to finish, and record one pipeline_runs
//   row with the counts (read, scored, waiting), so the run log still reads as one run.
// The daily budget is checked before every Claude call on the API key. A job the budget stops stays
// waiting and the next day's run queues it again; nothing is marked failed for it. On Devin's
// subscription, a job that his subscription's limit or this app's own limit on it stops waits in
// the queue for the reset (midnight, or when the 7-day total drops), and the step stops waiting
// for it.

/**
 * True where finished work queues the next step by itself (search queues reading, reading queues
 * scoring). Off where the schedule is off (Orca worktrees), so a laptop copy spends no Claude
 * credit on its own; the steps of a full run still queue everything there.
 */
export function autoFollowOn(): boolean {
  return String(useRuntimeConfig().schedulerEnabled) !== 'false'
}

export function queueEnrichJob(jobId: number, opts: { force?: boolean; trigger?: RunTrigger } = {}) {
  return enqueue(ENRICH_ONE_TASK, { jobId, ...(opts.force ? { force: true } : {}) }, {
    trigger: opts.trigger ?? 'chained',
    existing: () => activeItem(ENRICH_ONE_TASK, 'jobId', jobId),
  })
}

export function queueMatchJob(jobId: number, opts: { fresh?: boolean; trigger?: RunTrigger } = {}) {
  return enqueue(MATCH_ONE_TASK, { jobId, ...(opts.fresh ? { fresh: true } : {}) }, {
    trigger: opts.trigger ?? 'chained',
    existing: () => {
      const item = activeItem(MATCH_ONE_TASK, 'jobId', jobId)
      // A score already running may have read the job before its posting changed: queue another.
      return item?.status === 'queued' ? item : null
    },
  })
}

function itemLog(task: string, jobId: number) {
  return (msg: string) => console.log(`[${task} job ${jobId}] ${msg}`)
}

/** The jobs:enrich-one item: read one posting. Its result is counted by the jobs:enrich step. */
export async function runEnrichOne(payload: Record<string, unknown>): Promise<EnrichOneResult> {
  const jobId = Number(payload.jobId)
  const job = Number.isInteger(jobId) ? useDb().select().from(jobs).where(eq(jobs.id, jobId)).get() : undefined
  if (!job) return { jobId, outcome: 'failed', error: `Job ${payload.jobId} no longer exists` }
  const force = payload.force === true
  // Read already (a resumed item, or two producers): nothing to do.
  if (!force && !needsEnrich(job)) return { jobId, outcome: 'already' }
  const entries = loadKnowledge()
  if (!force) {
    const f = prefilterPending([job], prefilterContext(entries))
    if (f.skipped) return { jobId, outcome: 'skipped', skipReason: Object.keys(f.skipReasons)[0] }
  }
  // Out of budget or credit, or the subscription is at its limit: stop before fetching anything.
  // The job stays waiting (at a subscription limit the worker puts this item back for the reset).
  const stop = aiStopError('enrich')
  if (stop) return { jobId, outcome: 'budget', error: stop.message }
  const r = await enrichOne(job, entries, sharedBoardCache(), itemLog(ENRICH_ONE_TASK, jobId))
  if (r.outcome === 'enriched' && autoFollowOn()) queueMatchJob(jobId)
  return r
}

/** The jobs:match-one item: score one job. Its result is counted by the jobs:match step. */
export async function runMatchOne(payload: Record<string, unknown>): Promise<ScoreOneResult> {
  const jobId = Number(payload.jobId)
  const job = Number.isInteger(jobId) ? useDb().select().from(jobs).where(eq(jobs.id, jobId)).get() : undefined
  if (!job) return { jobId, outcome: 'failed', error: `Job ${payload.jobId} no longer exists` }
  const fresh = payload.fresh === true
  if (!fresh && job.skillsScore != null && job.scoredAt && job.enrichedAt && job.scoredAt >= job.enrichedAt) return { jobId, outcome: 'already' }
  // The budget check happens inside the Claude call, before anything is sent.
  return await scoreOne(job, { entries: loadKnowledge(), prefs: loadCompPreferences(), fresh }, itemLog(MATCH_ONE_TASK, jobId))
}

/**
 * Where the step's counts start: for a step of a full run, when the full run started; otherwise
 * when the step's own pipeline_runs row started (its first attempt, when resumed). A job's score
 * runs as soon as the job is read (claimNext takes scores before reads), so most scores of a full
 * run end while the Read postings step still waits on reads, and reads that search queued end
 * during the search step. Counting from the full run's start keeps them in its counts. Only one
 * full run runs at a time and each step waits for its own items, so no earlier run's items count.
 */
function stepStartedAt(): string {
  const ctx = currentQueueContext()
  const item = ctx ? getItem(ctx.item.id) : null
  const parent = item?.parentId ? getItem(item.parentId) : null
  const runId = parent?.pipelineRunId ?? item?.pipelineRunId
  const run = runId ? useDb().select({ at: pipelineRuns.startedAt }).from(pipelineRuns).where(eq(pipelineRuns.id, runId)).get() : null
  return run?.at ?? sqlTime()
}

/** Waits until no item of these tasks is queued or running, saying how far it got every 30 seconds. */
/**
 * Per-job items of `tasks` still in the queue: running, due (queued, to be waited for), and
 * deferred (put back by a Claude limit until its reset: a later run_after and pauseItem()'s
 * "Paused: ..." note), with the note of one deferred item ("Paused: this app's daily Claude limit
 * is reached, resumes at midnight"). A queued item with a later run_after and no such note counts
 * as due, so a step keeps waiting for it as before.
 */
export function perJobQueueCounts(tasks: readonly string[]): { running: number; due: number; deferred: number; note: string | null } {
  const now = sqlTime()
  const deferred = sql`(${taskQueue.status} = 'queued' and ${taskQueue.runAfter} > ${now} and coalesce(${taskQueue.note}, '') like 'Paused: %')`
  const row = useDb().select({
    running: sql<number>`coalesce(sum(case when ${taskQueue.status} = 'running' then 1 else 0 end), 0)`,
    due: sql<number>`coalesce(sum(case when ${taskQueue.status} = 'queued' and not ${deferred} then 1 else 0 end), 0)`,
    deferred: sql<number>`coalesce(sum(case when ${deferred} then 1 else 0 end), 0)`,
    note: sql<string | null>`max(case when ${deferred} then ${taskQueue.note} end)`,
  }).from(taskQueue).where(and(inArray(taskQueue.task, [...tasks]), inArray(taskQueue.status, ['queued', 'running']))).get()
  return { running: row?.running ?? 0, due: row?.due ?? 0, deferred: row?.deferred ?? 0, note: row?.note ?? null }
}

/**
 * Waits until no item of `tasks` runs or is due. Items a Claude limit put back to run after its
 * reset are not waited for (the step would otherwise hold its slot, and a full run, until
 * midnight); they run on their own later. Returns how many were left that way and their note.
 */
async function waitForTasks(tasks: readonly string[], verb: string, log: (msg: string) => void): Promise<{ deferred: number; note: string | null }> {
  let lastSaid = Date.now()
  for (;;) {
    const c = perJobQueueCounts(tasks)
    if (!c.due && !c.running) {
      if (c.deferred) log(`${c.deferred} left in the queue for later: ${c.note ?? 'waiting for a Claude limit to reset'}`)
      return { deferred: c.deferred, note: c.note }
    }
    if (Date.now() - lastSaid > 30_000) {
      log(`${c.running} ${verb} now, ${c.due} waiting${c.deferred ? `, ${c.deferred} for later` : ''}`)
      lastSaid = Date.now()
    }
    await new Promise(r => setTimeout(r, 2000))
  }
}

/** A step whose per-job items a Claude limit put back reads stopped at the budget, with the limit's note. */
function noteDeferred(stats: { budgetStopped: boolean; errors: string[] }, waited: { deferred: number; note: string | null }) {
  if (!waited.deferred) return
  stats.budgetStopped = true
  if (waited.note && !stats.errors.includes(waited.note)) stats.errors.push(waited.note)
}

/** Results of a per-job task's items that ended since `since`. An item that threw counts as failed. */
function resultsSince<T extends { jobId: number; outcome: string; error?: string }>(task: string, since: string): T[] {
  return useDb().select().from(taskQueue)
    .where(and(eq(taskQueue.task, task), inArray(taskQueue.status, ['done', 'failed', 'interrupted']), gte(taskQueue.finishedAt, since)))
    .all()
    .map((row) => {
      const r = parseJson<T | null>(row.resultJson, null)
      return r && typeof r.outcome === 'string'
        ? r
        : { jobId: Number(parsePayload(row).jobId), outcome: 'failed', error: row.lastError ?? 'The item failed' } as T
    })
}

function costSince(purpose: string | string[], since: string): number {
  const purposes = Array.isArray(purpose) ? purpose : [purpose]
  const row = useDb().select({ total: sql<number>`coalesce(sum(${aiCalls.costUsd}), 0)` }).from(aiCalls)
    .where(and(inArray(aiCalls.purpose, purposes), gte(aiCalls.createdAt, since))).get()
  return Math.round((row?.total ?? 0) * 10000) / 10000
}

function jobIdsOf(payload: Record<string, unknown>): number[] {
  return Array.isArray(payload.jobIds) ? payload.jobIds.map(Number).filter(n => Number.isInteger(n) && n > 0) : []
}

/**
 * The jobs:enrich step. Queues a jobs:enrich-one item for every job still waiting to be read (no
 * cap, newest posting first) or for the payload's jobIds (read again), waits for every queued
 * read to finish, and returns the counts. `pending` is the jobs still waiting afterward (the budget
 * stopped them, or they arrived meanwhile).
 */
export async function enrichStep(payload: Record<string, unknown>, log: (msg: string) => void): Promise<EnrichStats> {
  const stats = emptyEnrichStats()
  const since = stepStartedAt()
  const ids = jobIdsOf(payload)
  let queued = 0
  if (ids.length) {
    for (const id of ids) if (queueEnrichJob(id, { force: true }).created) queued++
  }
  else {
    const f = prefilterPending(pendingEnrichJobs(), prefilterContext())
    stats.skipped = f.skipped
    stats.skipReasons = f.skipReasons
    const stop = aiStopError('enrich')
    if (stop) {
      stats.budgetStopped = true
      stats.errors.push(stop.message)
      log(`not queuing ${f.ranked.length} jobs: ${stop.message}`)
    }
    else {
      // Newest posting first, so when background work stops at its share of the budget the
      // oldest postings are the ones left for the next day.
      const newest = [...f.ranked].sort((a, b) => (b.job.postedAt ?? b.job.foundAt).localeCompare(a.job.postedAt ?? a.job.foundAt) || b.job.id - a.job.id)
      for (const { job } of newest) if (queueEnrichJob(job.id).created) queued++
    }
  }
  stats.selected = queued
  log(`${queued} ${queued === 1 ? 'job' : 'jobs'} queued to be read, one item each`)
  const waited = await waitForTasks([ENRICH_ONE_TASK], 'being read', log)
  const results = resultsSince<EnrichOneResult>(ENRICH_ONE_TASK, since)
  for (const r of results) tallyEnrich(stats, r)
  noteDeferred(stats, waited)
  // Every job this run handled, including items queued before a restart cut it off.
  stats.selected = Math.max(queued, results.filter(r => r.outcome !== 'already').length)
  stats.pending = pendingEnrichJobs().length
  stats.costUsd = costSince('enrich', since)
  stats.errors = stats.errors.slice(0, 10)
  log(`${stats.enriched} read, ${stats.failed} failed, ${stats.pending} still waiting${stats.budgetStopped ? ' (stopped at the AI budget)' : ''}`)
  return stats
}

/**
 * The jobs:match step. Queues a jobs:match-one item for every read job without a current score (no
 * cap) or for the payload's jobIds, waits for every queued score to finish, then rescores every
 * open job in code so new preferences and learned rules apply everywhere.
 */
export async function matchStep(payload: Record<string, unknown>, log: (msg: string) => void): Promise<MatchStats> {
  const stats = emptyMatchStats()
  const since = stepStartedAt()
  const ids = jobIdsOf(payload)
  let queued = 0
  if (ids.length) {
    for (const id of ids) if (queueMatchJob(id, { fresh: payload.fresh === true }).created) queued++
  }
  else {
    const pending = pendingScoreJobs()
    const stop = aiStopError(MATCH_GAPS_PURPOSE)
    if (stop) {
      stats.budgetStopped = true
      stats.errors.push(stop.message)
      log(`not queuing ${pending.length} jobs: ${stop.message}`)
    }
    else {
      for (const job of pending) if (queueMatchJob(job.id).created) queued++
    }
  }
  log(`${queued} ${queued === 1 ? 'job' : 'jobs'} queued to be scored, one item each`)
  const waited = await waitForTasks([MATCH_ONE_TASK], 'being scored', log)
  for (const r of resultsSince<ScoreOneResult>(MATCH_ONE_TASK, since)) tallyScore(stats, r)
  noteDeferred(stats, waited)
  if (!ids.length) stats.rescored = (await rescoreJobs('open', 'rescore')).rescored
  stats.pending = pendingScoreJobs().length
  stats.costUsd = costSince(['match', 'match_gaps'], since)
  stats.errors = stats.errors.slice(0, 10)
  log(`${stats.scored} scored, ${stats.failed} failed, ${stats.pending} still waiting${stats.budgetStopped ? ' (stopped at the AI budget)' : ''}`)
  return stats
}
