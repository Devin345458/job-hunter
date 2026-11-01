import { desc } from 'drizzle-orm'
import { pipelineRuns } from '~~/server/db/schema'
import type { PipelineRunView } from '#shared/types/pipeline'

export default defineEventHandler((event) => {
  const limit = Math.min(Number(getQuery(event).limit) || 50, 200)
  const rows = useDb().select().from(pipelineRuns).orderBy(desc(pipelineRuns.id)).limit(limit).all()
  const runs: PipelineRunView[] = rows.map(r => ({
    id: r.id,
    task: r.task,
    trigger: r.trigger,
    status: r.status as PipelineRunView['status'],
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    stats: parseJson(r.statsJson, null),
    error: r.error,
    host: r.host,
  }))
  return { runs, aiSpentToday: aiSpentToday(), aiBudget: aiBudget() }
})
