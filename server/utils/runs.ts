import { hostname } from 'node:os'
import { eq } from 'drizzle-orm'
import { pipelineRuns } from '../db/schema'

const running = new Set<string>()

export type RunTrigger = 'schedule' | 'manual' | 'chained'

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * Wraps one task run: writes a pipeline_runs row when it starts and when it ends, and
 * refuses to start a second copy of the same task while one is running in this process.
 * The row's host column is os.hostname(), which inside Docker is the container id, so
 * the dashboard can show that a run happened in the deployed container.
 * `lockKey` narrows "the same task": a rebuild of one demo does not block a rebuild of another.
 */
export async function withRun<T extends Record<string, unknown>>(
  task: string,
  trigger: RunTrigger,
  fn: (log: (msg: string) => void) => Promise<T>,
  opts: { lockKey?: string } = {},
): Promise<{ runId: number; status: 'succeeded' | 'failed' | 'skipped'; stats: T | null; error: string | null }> {
  const db = useDb()
  const lock = opts.lockKey ?? task
  // The queue item being run (server/utils/queue.ts). Its first run row is tied to the item, so an
  // attempt resumed after a restart carries the same row on instead of starting a new one.
  const ctx = currentQueueContext()
  const item = ctx && !ctx.bound ? ctx : null
  if (item) item.bound = true
  if (running.has(lock)) {
    const row = db.insert(pipelineRuns).values({ task, trigger, status: 'skipped', finishedAt: now(), host: hostname(), error: 'Another run of this task is still in progress' }).returning().get()
    if (item) linkRunToItem(item.item.id, row.id)
    return { runId: row.id, status: 'skipped', stats: null, error: row.error }
  }
  running.add(lock)
  const resumed = item?.resumed ? item.item.attempts : 0
  const carried = resumed && item?.item.pipelineRunId
    ? db.update(pipelineRuns).set({ status: 'running', finishedAt: null, error: null, host: hostname(), statsJson: JSON.stringify({ resumedAfterRestart: resumed }) })
        .where(eq(pipelineRuns.id, item.item.pipelineRunId)).returning().get()
    : undefined
  const row = carried ?? db.insert(pipelineRuns).values({ task, trigger, status: 'running', host: hostname(), ...(resumed ? { statsJson: JSON.stringify({ resumedAfterRestart: resumed }) } : {}) }).returning().get()
  if (item) linkRunToItem(item.item.id, row.id)
  const log = (msg: string) => console.log(`[${task}#${row.id}] ${msg}`)
  log(resumed ? `resumed after a restart (${trigger})` : `started (${trigger})`)
  try {
    let stats: T
    try {
      stats = await fn(log)
    }
    catch (e) {
      // Devin's subscription reached its limit, or this app's own limit on it: the run is paused,
      // not failed. The queue puts the item back to run after the reset (server/plugins/queue.ts).
      if (!(e instanceof AiSubscriptionLimit) && !(e instanceof AiAppLimitReached)) throw e
      log(e.message)
      stats = { budgetStop: true, errors: [e.message] } as unknown as T
    }
    // A run that stopped early at the AI budget says why: the daily budget, an account problem
    // (out of credit) that no amount of waiting for midnight fixes, the subscription limit, or this
    // app's own limit on the subscription. A step whose per-job items the limit stopped (they stop
    // as background work even when Devin started the step) reads the limit that holds now.
    const s = stats as Record<string, unknown> | null
    if (s && (s.budgetStop === true || s.budgetStopped === true) && !('stopReason' in s)) {
      const ctx = currentQueueContext()
      const pause = ctx?.subscriptionPausedUntil ? null : activeSubscriptionPause()
      const limit = ctx?.subscriptionPausedUntil || pause || !subscriptionTokenSet() ? null : appLimitStopNow(true)
      if (ctx?.subscriptionPausedUntil) Object.assign(s, { stopReason: ctx.subscriptionStopKind ?? 'subscription', pausedUntil: ctx.subscriptionPausedUntil })
      else if (pause) Object.assign(s, { stopReason: 'subscription', pausedUntil: pause.until })
      else if (limit) Object.assign(s, { stopReason: limit.kind, pausedUntil: limit.until })
      else (s as Record<string, unknown>).stopReason = aiAccountProblem()?.kind ?? budgetStopKind()
    }
    const recorded = resumed ? { ...s, resumedAfterRestart: resumed } : stats
    db.update(pipelineRuns).set({ status: 'succeeded', finishedAt: now(), statsJson: JSON.stringify(recorded) }).where(eq(pipelineRuns.id, row.id)).run()
    log(`succeeded ${JSON.stringify(stats)}`)
    return { runId: row.id, status: 'succeeded', stats, error: null }
  }
  catch (e: any) {
    const error = e?.stack || e?.message || String(e)
    db.update(pipelineRuns).set({ status: 'failed', finishedAt: now(), error: error.slice(0, 4000), ...(resumed ? { statsJson: JSON.stringify({ resumedAfterRestart: resumed }) } : {}) }).where(eq(pipelineRuns.id, row.id)).run()
    console.error(`[${task}#${row.id}] failed`, e)
    return { runId: row.id, status: 'failed', stats: null, error }
  }
  finally {
    running.delete(lock)
  }
}

/**
 * False when this server must not act on its cron schedule (NUXT_SCHEDULER_ENABLED=false, which
 * every Orca worktree sets). Manual and chained runs are not affected.
 */
export function scheduleSkipped(payload: Record<string, unknown> | undefined): boolean {
  return triggerOf(payload) === 'schedule' && String(useRuntimeConfig().schedulerEnabled) === 'false'
}

/** Trigger passed through Nitro's runTask payload; scheduled runs have no payload. */
export function triggerOf(payload: Record<string, unknown> | undefined): RunTrigger {
  const t = payload?.trigger
  return t === 'manual' || t === 'chained' ? t : 'schedule'
}
