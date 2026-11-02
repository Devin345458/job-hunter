import { and, desc, eq, gt, inArray, lt, ne } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { pipelineRuns } from '~~/server/db/schema'
import { DAILY_STEPS } from '~~/server/tasks/pipeline/daily'
import type { PipelineRunView } from '#shared/types/pipeline'
import { runOutcome, runProblems } from '#shared/utils/run-outcome'

type RunRow = InferSelectModel<typeof pipelineRuns>

const HEARTBEAT = 'system:heartbeat'

function view(r: RunRow): PipelineRunView {
  return {
    id: r.id,
    task: r.task,
    trigger: r.trigger,
    status: r.status as PipelineRunView['status'],
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    stats: parseJson(r.statsJson, null),
    error: r.error,
    host: r.host,
  }
}

/**
 * The steps a pipeline:daily run chained: the chained rows written after it and before the next
 * daily run. Daily runs recorded before they kept their steps' problems are judged from these.
 */
function chainedSteps(daily: RunRow): PipelineRunView[] {
  const db = useDb()
  const next = db.select({ id: pipelineRuns.id }).from(pipelineRuns)
    .where(and(eq(pipelineRuns.task, 'pipeline:daily'), gt(pipelineRuns.id, daily.id)))
    .orderBy(pipelineRuns.id).limit(1).get()
  return db.select().from(pipelineRuns)
    .where(and(
      gt(pipelineRuns.id, daily.id),
      next ? lt(pipelineRuns.id, next.id) : undefined,
      eq(pipelineRuns.trigger, 'chained'),
      inArray(pipelineRuns.task, [...DAILY_STEPS]),
    ))
    .orderBy(pipelineRuns.id)
    .all().map(view)
}

function describe(r: RunRow): PipelineRunView {
  const v = view(r)
  const needsSteps = r.task === 'pipeline:daily' && !(v.stats && 'problems' in v.stats)
  const problems = runProblems(v, needsSteps ? chainedSteps(r) : [])
  return { ...v, problems, outcome: runOutcome(v, problems) }
}

// GET /api/pipeline/runs: recent runs, newest first, each with a derived outcome. Scheduler
// heartbeats fire every 15 minutes, so they are left out of the list (?heartbeats=1 keeps them)
// and the latest one is returned on its own. The latest daily run is returned on its own too, so
// the health line never depends on how many rows fit in the list.
export default defineEventHandler((event) => {
  const query = getQuery(event)
  const limit = Math.min(Number(query.limit) || 50, 200)
  const withHeartbeats = query.heartbeats === '1' || query.heartbeats === 'true'
  const db = useDb()
  const rows = db.select().from(pipelineRuns)
    .where(withHeartbeats ? undefined : ne(pipelineRuns.task, HEARTBEAT))
    .orderBy(desc(pipelineRuns.id)).limit(limit).all()
  const lastDailyRow = db.select().from(pipelineRuns).where(eq(pipelineRuns.task, 'pipeline:daily')).orderBy(desc(pipelineRuns.id)).limit(1).get()
  const lastHeartbeatRow = db.select().from(pipelineRuns).where(eq(pipelineRuns.task, HEARTBEAT)).orderBy(desc(pipelineRuns.id)).limit(1).get()
  return {
    runs: rows.map(describe),
    lastDaily: lastDailyRow ? describe(lastDailyRow) : null,
    lastHeartbeat: lastHeartbeatRow ? view(lastHeartbeatRow) : null,
    aiSpentToday: aiSpentToday(),
    aiBudget: aiBudget(),
    aiProblem: aiAccountProblem(),
  }
})
