import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import { hostname } from 'node:os'
import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { applications, demoProjects, jobs, pipelineRuns, taskQueue } from '../db/schema'
import type { QueueItemView, QueueSnapshot, QueueStatus } from '#shared/types/pipeline'
import { plainError } from '#shared/utils/plain-text'
import { runOutcome, runProblems, taskLabel } from '#shared/utils/run-outcome'
import { DAILY_STEPS } from '#shared/utils/schedule'
import type { RunTrigger } from './runs'
import { PRIORITY_WINDOW_MS, subscriptionPauseMessage } from './subscription-pause'
import { APP_LIMIT_NOTE_SQL } from './subscription-budget'
import type { AppLimitKind } from '#shared/utils/subscription'

// The durable job queue (table task_queue, migration 0005). Producers call enqueue() instead of
// running work in the request; a worker (server/plugins/queue.ts, roles all and worker) claims the
// oldest due item with a lease, renews the lease while the item runs, and records how it ended.
// A process that dies leaves its item with a lease that runs out; the next worker start puts it
// back in the queue (attempts plus one), except an approval, which may have submitted the form
// and is marked interrupted instead. A daily run is a parent item whose steps are child items,
// run one after another in DAILY_STEPS order.

export type QueueRow = InferSelectModel<typeof taskQueue>

/** Seconds a claimed item stays leased without a renewal. The worker renews every 10 seconds. */
export const LEASE_SECONDS = 30
export const RENEW_EVERY_MS = 10_000

export const APPROVE_TASK = 'applications:approve'
export const PREPARE_ONE_TASK = 'applications:prepare-one'
export const REFILL_TASK = 'applications:refill'
export const REBUILD_TASK = 'demos:rebuild'
export const PREVIEW_TASK = 'demos:preview'
export const FIND_TASK = 'repos:find'
export const DAILY_TASK = 'pipeline:daily'
export const HEARTBEAT_TASK = 'system:heartbeat'
export const ENRICH_ONE_TASK = 'jobs:enrich-one'
export const MATCH_ONE_TASK = 'jobs:match-one'

/** Tasks that drive Chromium for a form or build demos. At most one of them runs at a time, in any process. */
export const HEAVY_TASKS = ['demos:build', REBUILD_TASK, PREVIEW_TASK, 'applications:prepare', 'applications:read-forms', PREPARE_ONE_TASK, REFILL_TASK, APPROVE_TASK] as const
/**
 * One item per job: read one posting, score one job. They run in their own lane, several at once
 * (NUXT_BULK_CONCURRENCY), so a backlog of hundreds never holds up an approval or a demo.
 */
export const BULK_TASKS = [ENRICH_ONE_TASK, MATCH_ONE_TASK] as const
/**
 * The jobs:enrich and jobs:match steps queue the per-job items and wait for them. They run in their
 * own lane too, since most of their time is waiting.
 */
export const COORD_TASKS = ['jobs:enrich', 'jobs:match'] as const
/** Tasks the worker runs beside a long item, so the heartbeat stays on time during a demo build. */
export const LIGHT_TASKS = [HEARTBEAT_TASK] as const
/** Never run twice: an interrupted approval may already have submitted the employer form. */
export const NO_RETRY_TASKS = [APPROVE_TASK] as const
/**
 * Tasks that never call Claude. They keep running while Devin's Claude subscription is paused at
 * its limit (server/utils/subscription-pause.ts); every other item waits for the reset.
 */
export const NO_AI_TASKS = [HEARTBEAT_TASK, DAILY_TASK, 'jobs:search', 'repos:index', FIND_TASK] as const

const ACTIVE: QueueStatus[] = ['queued', 'running']
const TERMINAL: QueueStatus[] = ['done', 'failed', 'canceled', 'interrupted']

export const RESUMED_NOTE = 'Resumed after a restart'

/** Wakes this process's worker as soon as something is queued here. */
export const queueEvents = new EventEmitter()

export function sqlTime(d: Date = new Date()): string {
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

function secondsFromNow(s: number): string {
  return sqlTime(new Date(Date.now() + s * 1000))
}

export function parsePayload(row: Pick<QueueRow, 'payloadJson'>): Record<string, unknown> {
  try {
    const p = JSON.parse(row.payloadJson ?? '{}')
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {}
  }
  catch {
    return {}
  }
}

function sqlite() {
  return useDb().$client
}

export function getItem(id: number): QueueRow | null {
  return useDb().select().from(taskQueue).where(eq(taskQueue.id, id)).get() ?? null
}

export function isTerminal(status: string): boolean {
  return (TERMINAL as string[]).includes(status)
}

// ── Producing ───────────────────────────────────────────────

export interface EnqueueOptions {
  trigger?: RunTrigger
  /** Not before this time (repos:suggest waits 45 seconds to gather new questions). */
  runAfter?: Date
  maxAttempts?: number
  parentId?: number | null
}

function insertItem(task: string, payload: Record<string, unknown>, opts: EnqueueOptions): QueueRow {
  return useDb().insert(taskQueue).values({
    task,
    payloadJson: JSON.stringify(payload ?? {}),
    trigger: opts.trigger ?? 'manual',
    maxAttempts: opts.maxAttempts ?? ((NO_RETRY_TASKS as readonly string[]).includes(task) ? 1 : 3),
    runAfter: sqlTime(opts.runAfter ?? new Date()),
    parentId: opts.parentId ?? null,
  }).returning().get()
}

/**
 * Adds one item to the queue and returns it. With `existing`, the check and the insert happen in
 * one write transaction, so two processes (or a double click) cannot queue the same work twice:
 * when `existing` finds an item, that item is returned with created false.
 */
export function enqueue(task: string, payload: Record<string, unknown> = {}, opts: EnqueueOptions & { existing?: () => QueueRow | null } = {}): { item: QueueRow; created: boolean } {
  const tx = sqlite().transaction(() => {
    const found = opts.existing?.() ?? null
    if (found) return { item: found, created: false }
    return { item: insertItem(task, payload, opts), created: true }
  })
  const out = tx.immediate()
  if (out.created) {
    console.log(`[queue] queued ${task} #${out.item.id} (${out.item.trigger})`)
    queueEvents.emit('enqueued', out.item)
  }
  return out
}

/** The queued or running item of a task, optionally one whose payload field equals a value. */
export function activeItem(task: string | readonly string[], field?: string, value?: number | string): QueueRow | null {
  const tasks = Array.isArray(task) ? [...task] : [task as string]
  return useDb().select().from(taskQueue)
    .where(and(
      inArray(taskQueue.task, tasks),
      inArray(taskQueue.status, ACTIVE),
      field ? sql`json_extract(${taskQueue.payloadJson}, ${`$.${field}`}) = ${value}` : undefined,
    ))
    .orderBy(taskQueue.id).limit(1).get() ?? null
}

/** Ids (payload field) that queued or running items of these tasks hold, e.g. applications being prepared. */
export function activeIds(tasks: readonly string[], field: string): Set<number> {
  const rows = useDb().select({ v: sql<number>`json_extract(${taskQueue.payloadJson}, ${`$.${field}`})` }).from(taskQueue)
    .where(and(inArray(taskQueue.task, [...tasks]), inArray(taskQueue.status, ACTIVE))).all()
  return new Set(rows.map(r => Number(r.v)).filter(Number.isInteger))
}

/**
 * Queues the whole preparation of one application (applications:prepare-one: tailor, cover letter,
 * form dry run, and the gap plan when stage 1 did not make one) and shows it as preparing, in one
 * transaction so the read-forms step never sees it in preparing without its item. Apply, Prepare
 * again, and the read-forms step (for stopped preparations) call this. A second call while one
 * waits returns the waiting item.
 */
export function queuePrepare(applicationId: number, detail = 'Waiting in the queue to prepare'): QueueRow {
  return sqlite().transaction(() => {
    setApplicationStatus(applicationId, 'preparing', detail)
    return enqueue(PREPARE_ONE_TASK, { applicationId }, { trigger: 'manual', existing: () => activeItem(PREPARE_ONE_TASK, 'applicationId', applicationId) }).item
  }).immediate()
}

/** A daily run that is queued or still working through its steps. */
export function dailyInFlight(): QueueRow | null {
  return activeItem(DAILY_TASK)
}

/** Queue the daily run, unless one is already queued or running (then that one is returned). */
export function enqueueDaily(trigger: RunTrigger) {
  return enqueue(DAILY_TASK, {}, { trigger, existing: dailyInFlight })
}

// ── Claiming ────────────────────────────────────────────────

const quoted = (list: readonly string[]) => list.map((t) => {
  if (!/^[a-z0-9:-]+$/.test(t)) throw new Error(`bad task name ${t}`)
  return `'${t}'`
}).join(', ')

/**
 * Claims the oldest due item in one atomic UPDATE ... RETURNING and leases it to `owner`.
 * Skipped: a daily step whose earlier sibling has not finished; a task that is already running
 * (per-job items excepted: several jobs are read at once); a heavy task (form fills, demo builds)
 * while another heavy task runs. `only` and `except` pick the lane's tasks.
 * Per-job items: a job's score comes before more reads. A waiting jobs:match-one item (the job read
 * longest ago first) is taken before any jobs:enrich-one item, so when the budget stops background
 * work, the money went to jobs that were read and scored, not to reads nobody can decide on yet.
 * Reads keep their queue order, which is newest posting first.
 */
export function claimNext(owner: string, lane: { only?: readonly string[]; except?: readonly string[]; ai?: 'paused' | 'foreground' | 'free' } = {}): QueueRow | null {
  const now = sqlTime()
  const heavy = quoted(HEAVY_TASKS)
  const bulk = quoted(BULK_TASKS)
  const score = quoted([MATCH_ONE_TASK])
  const noAi = quoted(NO_AI_TASKS)
  // Devin's subscription at its limit: only tasks that never call Claude. Right after the reset:
  // those plus items Devin started (not per-job items, not a scheduled run's steps).
  const ai = lane.ai === 'paused'
    ? `AND t.task IN (${noAi})`
    : lane.ai === 'foreground'
      ? `AND (t.task IN (${noAi}) OR NOT (t.task IN (${bulk}) OR t.trigger = 'schedule' OR EXISTS (SELECT 1 FROM task_queue p WHERE p.id = t.parent_id AND p.trigger = 'schedule')))`
      : ''
  const only = `${lane.only?.length ? `AND t.task IN (${quoted(lane.only)})` : ''} ${lane.except?.length ? `AND t.task NOT IN (${quoted(lane.except)})` : ''} ${ai}`
  const row = sqlite().prepare(`
    UPDATE task_queue
    SET status = 'running', lease_owner = @owner, lease_expires_at = @lease, started_at = @now
    WHERE status = 'queued' AND id = (
      SELECT t.id FROM task_queue t
      WHERE t.status = 'queued' AND t.run_after <= @now ${only}
        AND NOT EXISTS (SELECT 1 FROM task_queue s WHERE t.parent_id IS NOT NULL AND s.parent_id = t.parent_id AND s.id < t.id AND s.status IN ('queued', 'running'))
        AND (t.task IN (${bulk}) OR NOT EXISTS (SELECT 1 FROM task_queue r WHERE r.status = 'running' AND r.task = t.task))
        AND (t.task NOT IN (${heavy}) OR NOT EXISTS (SELECT 1 FROM task_queue r WHERE r.status = 'running' AND r.task IN (${heavy})))
      ORDER BY
        CASE WHEN t.task IN (${bulk}) AND t.task NOT IN (${score}) THEN 1 ELSE 0 END,
        CASE WHEN t.task IN (${score}) THEN (SELECT j.enriched_at FROM jobs j WHERE j.id = json_extract(t.payload_json, '$.jobId')) END,
        t.run_after, t.id
      LIMIT 1
    )
    RETURNING id`).get({ owner, lease: secondsFromNow(LEASE_SECONDS), now }) as { id: number } | undefined
  return row ? getItem(row.id) : null
}

export function renewLease(id: number, owner: string): boolean {
  return useDb().update(taskQueue).set({ leaseExpiresAt: secondsFromNow(LEASE_SECONDS) })
    .where(and(eq(taskQueue.id, id), eq(taskQueue.status, 'running'), eq(taskQueue.leaseOwner, owner))).run().changes > 0
}

/** Graceful stop ran out of time: end the lease now so the next worker start resumes the item. */
export function releaseLease(id: number, owner: string) {
  useDb().update(taskQueue).set({ leaseExpiresAt: '1970-01-01 00:00:00' })
    .where(and(eq(taskQueue.id, id), eq(taskQueue.leaseOwner, owner))).run()
}

export interface ItemOutcome {
  status: 'done' | 'failed'
  error?: string | null
  result?: unknown
}

/**
 * Whether an item that met Devin's subscription limit (`pausedUntil`, from its queue context) goes
 * back in the queue: only when the limit stopped its work. That is, it threw, a per-job item ended
 * 'budget' (its job still waits), or its run recorded the subscription stop (`stoppedAtLimit`,
 * itemOutcomeFromRun). An item whose task caught the limit and finished anyway (the condense step
 * falls back to whole sentences) is done; running it again would redo finished work. An approval
 * is never put back.
 */
export function pausedByLimit(item: Pick<QueueRow, 'task'>, outcome: ItemOutcome | 'waiting', pausedUntil: string | null | undefined): boolean {
  if (!pausedUntil || outcome === 'waiting') return false
  if ((NO_RETRY_TASKS as readonly string[]).includes(item.task)) return false
  if (outcome.status === 'failed') return true
  const r = outcome.result as Record<string, unknown> | null | undefined
  return r?.outcome === 'budget' || r?.stoppedAtLimit === true
}

/**
 * Puts an item that Devin's subscription limit, or this app's own limit on it, stopped back in the
 * queue, to run after the reset (`until`). Its attempts are not counted (a limit is not a failure).
 * Background items (per-job items, the steps of a scheduled run) wait PRIORITY_WINDOW_MS longer, so
 * what Devin started goes first. `note` says which limit; without it, Anthropic's.
 */
export function pauseItem(id: number, owner: string, until: string, opts: { background: boolean; note?: string }) {
  const runAfter = new Date(Date.parse(until) + (opts.background ? PRIORITY_WINDOW_MS : 0))
  const note = opts.note ?? subscriptionPauseMessage({ until })
  const changed = useDb().update(taskQueue).set({
    status: 'queued',
    runAfter: sqlTime(runAfter),
    leaseOwner: null,
    leaseExpiresAt: null,
    progressJson: null,
    note,
  }).where(and(eq(taskQueue.id, id), eq(taskQueue.status, 'running'), eq(taskQueue.leaseOwner, owner))).run().changes
  if (changed) console.log(`[queue] #${id} paused (${note}); it runs again after ${sqlTime(runAfter)} UTC`)
  else console.warn(`[queue] #${id} stopped at a Claude limit after its lease was taken away`)
}

/**
 * Puts the items this app's own subscription limit put back to the front again, to run now: a
 * raised limit lets them go on today. An item still stopped by the new limit is put back again
 * at its first Claude call. Returns how many.
 */
export function releaseAppLimitItems(): number {
  return useDb().update(taskQueue).set({ runAfter: sqlTime(), note: null })
    .where(and(eq(taskQueue.status, 'queued'), APP_LIMIT_NOTE_SQL)).run().changes
}

/** Records how an item ended and moves its daily run on. Ignored when the lease was taken away. */
export function completeItem(id: number, owner: string, outcome: ItemOutcome) {
  const db = useDb()
  sqlite().transaction(() => {
    const changed = db.update(taskQueue).set({
      status: outcome.status,
      finishedAt: sqlTime(),
      leaseOwner: null,
      leaseExpiresAt: null,
      progressJson: null,
      lastError: outcome.error ? plainError(outcome.error).slice(0, 1000) : null,
      resultJson: outcome.result === undefined ? null : JSON.stringify(outcome.result),
    }).where(and(eq(taskQueue.id, id), eq(taskQueue.status, 'running'), eq(taskQueue.leaseOwner, owner))).run().changes
    if (!changed) {
      console.warn(`[queue] #${id} finished after its lease was taken away; its result was not recorded`)
      return
    }
    const item = getItem(id)
    if (item?.parentId) advanceChain(item.parentId)
  }).immediate()
}

// ── Daily runs: a parent item and one child item per step ──

/**
 * Starts a daily run: writes its pipeline_runs row, queues every step as a child item, and frees
 * the worker (the parent stays running, with no lease, until its last step ends).
 */
export function startDailyChain(item: QueueRow, owner: string): number {
  const db = useDb()
  return sqlite().transaction(() => {
    const run = db.insert(pipelineRuns).values({ task: DAILY_TASK, trigger: item.trigger, status: 'running', host: hostname() }).returning().get()
    for (const step of DAILY_STEPS) insertItem(step, {}, { trigger: 'chained', parentId: item.id })
    db.update(taskQueue).set({ pipelineRunId: run.id, leaseOwner: null, leaseExpiresAt: null })
      .where(and(eq(taskQueue.id, item.id), eq(taskQueue.leaseOwner, owner))).run()
    console.log(`[${DAILY_TASK}#${run.id}] started (${item.trigger}); ${DAILY_STEPS.length} steps queued`)
    return run.id
  }).immediate()
}

/**
 * What one step reported back to the daily run: how it ended and, when it finished, the problems
 * its stats show (failed items, a budget or credit stop). A step that finished with problems is
 * recorded as partial, not succeeded: a step that "succeeded" while every Claude call failed, or
 * that the budget stopped before it read a single posting, is how the daily run used to look
 * green over a dead pipeline.
 */
export function stepSummary(step: string, result: { status?: string; stats?: Record<string, unknown> | null; error?: string | null } | null | undefined) {
  const status = result?.status ?? 'unknown'
  const problems = runProblems({ task: step, status, stats: result?.stats ?? null })
  return { status: status === 'succeeded' && problems.length ? 'partial' : status, problems }
}

function parseStats(json: string | null): Record<string, unknown> | null {
  try {
    return json ? JSON.parse(json) : null
  }
  catch {
    return null
  }
}

/**
 * After a step ends (or is canceled): the next step goes to the front of the queue, so other work
 * queued meanwhile does not wait for the whole run; when no step is left, the daily run's
 * pipeline_runs row is finished with every step's status and problems, as before the queue.
 */
export function advanceChain(parentId: number) {
  const db = useDb()
  const parent = getItem(parentId)
  if (!parent || parent.status !== 'running') return
  const children = db.select().from(taskQueue).where(eq(taskQueue.parentId, parentId)).orderBy(taskQueue.id).all()
  if (children.some(c => c.status === 'running')) return
  const next = children.find(c => c.status === 'queued')
  if (next) {
    db.update(taskQueue).set({ runAfter: sqlTime() }).where(eq(taskQueue.id, next.id)).run()
    return
  }
  const steps: Record<string, string> = {}
  const problems: Record<string, string[]> = {}
  let resumed = 0
  for (const c of children) {
    const run = c.pipelineRunId ? db.select().from(pipelineRuns).where(eq(pipelineRuns.id, c.pipelineRunId)).get() : null
    const status = run && run.status !== 'running' ? run.status : c.status === 'canceled' ? 'canceled' : c.status === 'done' ? 'succeeded' : 'failed'
    const summary = stepSummary(c.task, { status, stats: parseStats(run?.statsJson ?? null) })
    steps[c.task] = summary.status
    if (summary.problems.length) problems[c.task] = summary.problems
    if (c.attempts > 0) resumed++
  }
  const stats: Record<string, unknown> = { steps, problems }
  // The day's counts on the run itself: postings read, jobs scored, and jobs still waiting for either.
  const stepStats = (task: string) => {
    const c = children.find(x => x.task === task)
    const run = c?.pipelineRunId ? db.select({ s: pipelineRuns.statsJson }).from(pipelineRuns).where(eq(pipelineRuns.id, c.pipelineRunId)).get() : null
    return parseStats(run?.s ?? null) ?? {}
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const enrich = stepStats('jobs:enrich')
  const match = stepStats('jobs:match')
  stats.enriched = num(enrich.enriched)
  stats.scored = num(match.scored)
  stats.pending = num(enrich.pending) + num(match.pending)
  if (resumed) stats.resumedAfterRestart = resumed
  const outcome = runOutcome({ task: DAILY_TASK, status: 'succeeded', stats }, runProblems({ task: DAILY_TASK, status: 'succeeded', stats }))
  const finishedAt = sqlTime()
  if (parent.pipelineRunId) {
    db.update(pipelineRuns).set({ status: 'succeeded', finishedAt, statsJson: JSON.stringify({ ...stats, outcome }) })
      .where(eq(pipelineRuns.id, parent.pipelineRunId)).run()
  }
  db.update(taskQueue).set({ status: 'done', finishedAt, resultJson: JSON.stringify({ runId: parent.pipelineRunId, outcome }) })
    .where(eq(taskQueue.id, parentId)).run()
  console.log(`[${DAILY_TASK}#${parent.pipelineRunId}] finished: ${outcome}`)
}

/** A worker died between a step ending and the next starting: move every waiting daily run on. */
export function advanceStuckChains() {
  const parents = useDb().select({ id: taskQueue.id }).from(taskQueue)
    .where(and(eq(taskQueue.task, DAILY_TASK), eq(taskQueue.status, 'running'), isNull(taskQueue.leaseOwner))).all()
  for (const p of parents) sqlite().transaction(() => advanceChain(p.id)).immediate()
}

// ── Resume after a restart ──────────────────────────────────

/**
 * Items whose lease ran out belong to a worker that died or was stopped. Each goes back to the
 * queue with attempts plus one (its pipeline_runs row is carried on by the next attempt), or
 * fails once it has been started max_attempts times. An approval is never started again: it is
 * marked interrupted and the application says to check the employer's site.
 * Items this process is running itself (`mine`) only get their lease renewed.
 */
export function recoverExpired(owner: string, mine: ReadonlySet<number>): number {
  const db = useDb()
  const now = sqlTime()
  const dead = db.select().from(taskQueue)
    .where(and(eq(taskQueue.status, 'running'), sql`${taskQueue.leaseOwner} is not null`, sql`${taskQueue.leaseExpiresAt} < ${now}`)).all()
  let recovered = 0
  for (const item of dead) {
    if (item.leaseOwner === owner && mine.has(item.id)) {
      renewLease(item.id, owner)
      continue
    }
    sqlite().transaction(() => {
      // Still the same dead lease (another worker may have recovered it a moment ago).
      const fresh = getItem(item.id)
      if (!fresh || fresh.status !== 'running' || fresh.leaseOwner !== item.leaseOwner) return
      const attempts = item.attempts + 1
      if ((NO_RETRY_TASKS as readonly string[]).includes(item.task)) {
        const message = interruptApproval(item)
        db.update(taskQueue).set({ status: 'interrupted', attempts, finishedAt: now, leaseOwner: null, leaseExpiresAt: null, progressJson: null, lastError: message })
          .where(eq(taskQueue.id, item.id)).run()
        closeRun(item.pipelineRunId, message)
        console.warn(`[queue] #${item.id} ${item.task} was interrupted by a restart; it is not run again`)
      }
      else if (attempts >= item.maxAttempts) {
        const message = `Stopped after ${attempts} restarts in a row.`
        db.update(taskQueue).set({ status: 'failed', attempts, finishedAt: now, leaseOwner: null, leaseExpiresAt: null, progressJson: null, lastError: message })
          .where(eq(taskQueue.id, item.id)).run()
        closeRun(item.pipelineRunId, message)
        console.warn(`[queue] #${item.id} ${item.task} ${message}`)
      }
      else {
        db.update(taskQueue).set({ status: 'queued', attempts, runAfter: now, leaseOwner: null, leaseExpiresAt: null, progressJson: null, note: RESUMED_NOTE })
          .where(eq(taskQueue.id, item.id)).run()
        console.log(`[queue] #${item.id} ${item.task} goes back in the queue after a restart (attempt ${attempts + 1} of ${item.maxAttempts})`)
      }
      if (item.parentId) advanceChain(item.parentId)
      recovered++
    }).immediate()
  }
  return recovered
}

function closeRun(runId: number | null, message: string) {
  if (!runId) return
  useDb().update(pipelineRuns).set({ status: 'failed', finishedAt: sqlTime(), error: message })
    .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.status, 'running'))).run()
}

/** The message an interrupted approval leaves, from where it stopped. Also puts the application where approve can retry it. */
function interruptApproval(item: QueueRow): string {
  const applicationId = Number(parsePayload(item).applicationId)
  if (!Number.isInteger(applicationId)) return 'Interrupted by a restart.'
  return markApprovalInterrupted(applicationId)
}

/**
 * pipeline_runs rows still marked running that no queued or running item will carry on: their
 * process died before the queue existed, or they were never tied to an item. Closed at worker
 * start, as the server used to close every running row at start.
 */
export function closeOrphanRuns(): number {
  const db = useDb()
  const live = new Set(db.select({ id: taskQueue.pipelineRunId }).from(taskQueue)
    .where(inArray(taskQueue.status, ACTIVE)).all().map(r => r.id).filter((id): id is number => id != null))
  const orphans = db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.status, 'running')).all().filter(r => !live.has(r.id))
  for (const r of orphans) {
    db.update(pipelineRuns).set({ status: 'failed', finishedAt: sqlTime(), error: 'The server restarted before this run finished' }).where(eq(pipelineRuns.id, r.id)).run()
  }
  return orphans.length
}

// ── Canceling ───────────────────────────────────────────────

/** Tasks Settings may cancel while they wait. An approval is Devin's decision and is not canceled here. */
export function cancelable(item: QueueRow): boolean {
  // Prepare again and Refill already moved the application to preparing; canceling would strand it.
  return ![APPROVE_TASK, PREPARE_ONE_TASK, REFILL_TASK].includes(item.task)
}

/**
 * Cancels a waiting item. A daily run that is under way loses its waiting steps; the step running
 * now finishes. Returns the reason when it cannot be canceled.
 */
export function cancelItem(id: number): string | null {
  const db = useDb()
  let refusal: string | null = null
  sqlite().transaction(() => {
    const item = getItem(id)
    if (!item) { refusal = 'Not in the queue'; return }
    if (!cancelable(item)) { refusal = 'This item cannot be canceled'; return }
    const now = sqlTime()
    if (item.status === 'queued') {
      db.update(taskQueue).set({ status: 'canceled', finishedAt: now }).where(eq(taskQueue.id, id)).run()
      if (item.parentId) advanceChain(item.parentId)
      return
    }
    if (item.status === 'running' && item.task === DAILY_TASK && !item.leaseOwner) {
      db.update(taskQueue).set({ status: 'canceled', finishedAt: now })
        .where(and(eq(taskQueue.parentId, id), eq(taskQueue.status, 'queued'))).run()
      advanceChain(id)
      return
    }
    refusal = item.status === 'running' ? 'It is running now; it stops on its own when it finishes' : `It already ended (${item.status})`
  }).immediate()
  return refusal
}

// ── Waiting on an item ──────────────────────────────────────

/** Polls until the item ends or the time runs out; returns the row as it is then. */
export async function waitForItem(id: number, timeoutMs: number): Promise<QueueRow | null> {
  const until = Date.now() + timeoutMs
  let row = getItem(id)
  while (row && !isTerminal(row.status) && Date.now() < until) {
    await new Promise(r => setTimeout(r, 500))
    row = getItem(id)
  }
  return row
}

/**
 * For ?wait=true on the prepare, Prepare again, and Refill routes (scripts and tests): waits up to
 * 15 minutes for the queue item, then answers with the application as it is, as those routes did
 * when they ran the work in the request.
 */
export async function waitForPreparation(applicationId: number, itemId: number) {
  const item = await waitForItem(itemId, 15 * 60_000)
  const app = useDb().select().from(applications).where(eq(applications.id, applicationId)).get()
  return {
    ...app,
    id: applicationId,
    applicationId,
    status: app?.status ?? null,
    ...(item?.status === 'failed' && item.lastError ? { error: item.lastError } : {}),
    queue: item ? { id: item.id, status: item.status } : null,
  }
}

// ── Context of the item being run, and progress shared with the web process ──

export interface QueueContext {
  item: QueueRow
  /** The item was interrupted by a restart before and is being carried on. */
  resumed: boolean
  /** Set once the item's first withRun() has tied its pipeline_runs row to the item. */
  bound: boolean
  progress: Record<string, unknown>
  flushTimer: ReturnType<typeof setTimeout> | null
  lastFlush: number
  /** Set (to the reset time) when a call in this item met Devin's subscription limit or this app's own limit on it. */
  subscriptionPausedUntil?: string
  /** Which limit: 'subscription' (Anthropic's) or one of this app's (app_daily, app_background, app_week). */
  subscriptionStopKind?: 'subscription' | AppLimitKind
  /** The note the item carries back in the queue ("Paused: this app's daily Claude limit is reached, resumes at midnight"). */
  subscriptionStopNote?: string
}

const context = new AsyncLocalStorage<QueueContext>()

export function runInQueueContext<T>(item: QueueRow, fn: () => Promise<T>): Promise<T> {
  return context.run({ item, resumed: item.attempts > 0, bound: false, progress: {}, flushTimer: null, lastFlush: 0 }, fn)
}

export function currentQueueContext(): QueueContext | null {
  return context.getStore() ?? null
}

/** Ties a pipeline_runs row to the item being run, so a resumed attempt carries the same row on. */
export function linkRunToItem(itemId: number, runId: number) {
  useDb().update(taskQueue).set({ pipelineRunId: runId }).where(eq(taskQueue.id, itemId)).run()
}

/**
 * Live progress (a demo build's turn and newest lines, the commit search's counts) written to the
 * running item at most once a second, so a web process that runs no worker can show it.
 * `value` null removes the key.
 */
export function shareProgress(key: string, value: unknown) {
  const ctx = currentQueueContext()
  if (!ctx) return
  if (value == null) delete ctx.progress[key]
  else ctx.progress[key] = value
  if (ctx.flushTimer) return
  const wait = Math.max(0, 1000 - (Date.now() - ctx.lastFlush))
  ctx.flushTimer = setTimeout(() => {
    ctx.flushTimer = null
    ctx.lastFlush = Date.now()
    try {
      useDb().update(taskQueue).set({ progressJson: Object.keys(ctx.progress).length ? JSON.stringify(ctx.progress) : null })
        .where(and(eq(taskQueue.id, ctx.item.id), eq(taskQueue.status, 'running'))).run()
    }
    catch (e) {
      console.warn('[queue] could not share progress', e)
    }
  }, wait)
}

/** Progress a running item shared under `key`, from any process. */
export function sharedProgress<T>(key: string): T | null {
  const rows = useDb().select({ p: taskQueue.progressJson }).from(taskQueue)
    .where(and(eq(taskQueue.status, 'running'), sql`${taskQueue.progressJson} is not null`)).all()
  for (const r of rows) {
    const p = parseStats(r.p)
    if (p && key in p) return p[key] as T
  }
  return null
}

// ── Views for the dashboard ─────────────────────────────────

/** "Prepare an application: Acme", "Rebuild a demo: Invoice OCR", "Score matches". */
export function queueItemLabel(item: QueueRow): string {
  const base = taskLabel(item.task)
  const p = parsePayload(item)
  try {
    if (p.applicationId != null) {
      const row = useDb().select({ company: jobs.company }).from(applications).innerJoin(jobs, eq(applications.jobId, jobs.id))
        .where(eq(applications.id, Number(p.applicationId))).get()
      if (row?.company) return `${base}: ${row.company}`
    }
    if (p.jobId != null) {
      const row = useDb().select({ company: jobs.company }).from(jobs).where(eq(jobs.id, Number(p.jobId))).get()
      if (row?.company) return `${base}: ${row.company}`
    }
    if (p.demoId != null) {
      const row = useDb().select({ title: demoProjects.title }).from(demoProjects).where(eq(demoProjects.id, Number(p.demoId))).get()
      if (row?.title) return `${base}: ${row.title}`
    }
  }
  catch {}
  return base
}

function toView(item: QueueRow, steps?: Map<number, { index: number; total: number }>): QueueItemView {
  return {
    id: item.id,
    task: item.task,
    label: queueItemLabel(item),
    trigger: item.trigger,
    status: item.status as QueueStatus,
    attempts: item.attempts,
    createdAt: item.createdAt,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt,
    runId: item.pipelineRunId,
    parentId: item.parentId,
    step: steps?.get(item.id) ?? null,
    note: item.note,
    error: item.lastError,
    cancelable: (item.status === 'queued' || (item.task === DAILY_TASK && item.status === 'running')) && cancelable(item),
  }
}

/**
 * What the queue holds now: the item running (daily runs show their running step instead of
 * themselves), the items waiting in the order they will run, and the last day's interrupted,
 * failed, canceled, and resumed items.
 */
export function queueSnapshot(): QueueSnapshot {
  const db = useDb()
  const active = db.select().from(taskQueue).where(inArray(taskQueue.status, ACTIVE)).orderBy(taskQueue.runAfter, taskQueue.id).all()
  const steps = new Map<number, { index: number; total: number }>()
  const parents = new Set(active.filter(i => i.task === DAILY_TASK && i.status === 'running' && !i.leaseOwner).map(i => i.id))
  for (const parentId of parents) {
    const children = db.select({ id: taskQueue.id }).from(taskQueue).where(eq(taskQueue.parentId, parentId)).orderBy(taskQueue.id).all()
    children.forEach((c, i) => steps.set(c.id, { index: i + 1, total: children.length }))
  }
  const dayAgo = sqlTime(new Date(Date.now() - 24 * 3600_000))
  const recent = db.select().from(taskQueue)
    .where(and(
      sql`${taskQueue.finishedAt} > ${dayAgo}`,
      sql`(${taskQueue.status} in ('interrupted', 'failed', 'canceled') or (${taskQueue.status} = 'done' and ${taskQueue.attempts} > 0))`,
      sql`${taskQueue.task} != ${HEARTBEAT_TASK}`,
      notInArray(taskQueue.task, [...BULK_TASKS]),
    ))
    .orderBy(desc(taskQueue.finishedAt), desc(taskQueue.id)).limit(8).all()
  const waitingParents = active.filter(i => parents.has(i.id))
  const isBulk = (task: string) => (BULK_TASKS as readonly string[]).includes(task)
  return {
    running: active.filter(i => i.status === 'running' && !parents.has(i.id) && i.task !== HEARTBEAT_TASK && !isBulk(i.task)).map(i => toView(i, steps)),
    waiting: active.filter(i => i.status === 'queued' && i.task !== HEARTBEAT_TASK && !isBulk(i.task)).map(i => toView(i, steps)),
    runs: waitingParents.map(i => toView(i, steps)),
    // Per-job items are counted, not listed: a backlog can be hundreds of jobs.
    bulk: BULK_TASKS.map(task => ({
      task,
      label: taskLabel(task),
      running: active.filter(i => i.task === task && i.status === 'running').length,
      waiting: active.filter(i => i.task === task && i.status === 'queued').length,
    })).filter(b => b.running || b.waiting),
    recent: recent.map(i => toView(i, steps)),
    backlog: {
      toRead: pendingEnrichCount(),
      toScore: pendingScoreCount(),
      budgetStopped: aiSpentToday() >= aiBudget() * backgroundBudgetShare() || (subscriptionTokenSet() && !!appLimitStopNow(true)),
    },
  }
}

/** "Waiting in the queue behind Read postings", or without the name when nothing runs. */
export function waitingText(): string {
  const lanes = [HEARTBEAT_TASK, ...BULK_TASKS, ...COORD_TASKS]
  const running = useDb().select().from(taskQueue)
    .where(and(eq(taskQueue.status, 'running'), sql`${taskQueue.leaseOwner} is not null`, notInArray(taskQueue.task, lanes)))
    .orderBy(taskQueue.id).limit(1).get()
  return running ? `Waiting in the queue behind ${queueItemLabel(running)}` : 'Waiting in the queue'
}

/**
 * Keeps the table small: finished heartbeats after a day, per-job items after two days, every
 * other finished item after 30 days (their pipeline_runs rows stay). Returns how many rows went.
 */
export function pruneQueue(): number {
  const db = useDb()
  const dayAgo = sqlTime(new Date(Date.now() - 24 * 3600_000))
  const monthAgo = sqlTime(new Date(Date.now() - 30 * 24 * 3600_000))
  const heartbeats = db.delete(taskQueue).where(and(eq(taskQueue.task, HEARTBEAT_TASK), inArray(taskQueue.status, TERMINAL), sql`${taskQueue.finishedAt} < ${dayAgo}`)).run().changes
  // Per-job items: their results are counted into the step's pipeline_runs row, which stays.
  const twoDaysAgo = sqlTime(new Date(Date.now() - 2 * 24 * 3600_000))
  const perJob = db.delete(taskQueue).where(and(inArray(taskQueue.task, [...BULK_TASKS]), inArray(taskQueue.status, TERMINAL), sql`${taskQueue.finishedAt} < ${twoDaysAgo}`)).run().changes
  // A daily run's steps go with it, never before it.
  const old = db.delete(taskQueue).where(and(inArray(taskQueue.status, TERMINAL), sql`${taskQueue.finishedAt} < ${monthAgo}`, isNull(taskQueue.parentId))).run().changes
  const orphans = db.delete(taskQueue).where(and(sql`${taskQueue.parentId} is not null`, sql`${taskQueue.parentId} not in (select id from task_queue)`)).run().changes
  return heartbeats + perJob + old + orphans
}

/** Queued and running counts, for /api/health. */
export function queueDepth(): { queued: number; running: number } {
  const rows = useDb().select({ status: taskQueue.status, n: sql<number>`count(*)` }).from(taskQueue)
    .where(inArray(taskQueue.status, ACTIVE)).groupBy(taskQueue.status).all()
  return { queued: rows.find(r => r.status === 'queued')?.n ?? 0, running: rows.find(r => r.status === 'running')?.n ?? 0 }
}
