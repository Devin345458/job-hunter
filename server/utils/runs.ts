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
 */
export async function withRun<T extends Record<string, unknown>>(
  task: string,
  trigger: RunTrigger,
  fn: (log: (msg: string) => void) => Promise<T>,
): Promise<{ runId: number; status: 'succeeded' | 'failed' | 'skipped'; stats: T | null; error: string | null }> {
  const db = useDb()
  if (running.has(task)) {
    const row = db.insert(pipelineRuns).values({ task, trigger, status: 'skipped', finishedAt: now(), host: hostname(), error: 'Another run of this task is still in progress' }).returning().get()
    return { runId: row.id, status: 'skipped', stats: null, error: row.error }
  }
  running.add(task)
  const row = db.insert(pipelineRuns).values({ task, trigger, status: 'running', host: hostname() }).returning().get()
  const log = (msg: string) => console.log(`[${task}#${row.id}] ${msg}`)
  log(`started (${trigger})`)
  try {
    const stats = await fn(log)
    // A run that stopped early at the AI budget says why: the daily budget, or an account
    // problem (out of credit) that no amount of waiting for midnight fixes.
    const s = stats as Record<string, unknown> | null
    if (s && (s.budgetStop === true || s.budgetStopped === true) && !('stopReason' in s)) {
      (s as Record<string, unknown>).stopReason = aiAccountProblem()?.kind ?? 'budget'
    }
    db.update(pipelineRuns).set({ status: 'succeeded', finishedAt: now(), statsJson: JSON.stringify(stats) }).where(eq(pipelineRuns.id, row.id)).run()
    log(`succeeded ${JSON.stringify(stats)}`)
    return { runId: row.id, status: 'succeeded', stats, error: null }
  }
  catch (e: any) {
    const error = e?.stack || e?.message || String(e)
    db.update(pipelineRuns).set({ status: 'failed', finishedAt: now(), error: error.slice(0, 4000) }).where(eq(pipelineRuns.id, row.id)).run()
    console.error(`[${task}#${row.id}] failed`, e)
    return { runId: row.id, status: 'failed', stats: null, error }
  }
  finally {
    running.delete(task)
  }
}

/** Trigger passed through Nitro's runTask payload; scheduled runs have no payload. */
export function triggerOf(payload: Record<string, unknown> | undefined): RunTrigger {
  const t = payload?.trigger
  return t === 'manual' || t === 'chained' ? t : 'schedule'
}
