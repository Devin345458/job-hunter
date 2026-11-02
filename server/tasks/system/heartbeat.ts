import { and, eq, lt, sql } from 'drizzle-orm'
import { pipelineRuns } from '../../db/schema'

// Fires every 15 minutes from Nitro's scheduler. Each run writes a pipeline_runs row whose
// host is the container id, which proves the scheduler is alive inside the deployed container
// between the daily runs. Keeps two days of heartbeat rows.
export default defineTask({
  meta: {
    name: 'system:heartbeat',
    description: 'Prove the scheduler fires in the running container',
  },
  async run({ payload }) {
    if (scheduleSkipped(payload as Record<string, unknown> | undefined)) return { result: { skipped: 'the schedule is off on this server' } }
    const outcome = await withRun('system:heartbeat', triggerOf(payload), async () => {
      const removed = useDb().delete(pipelineRuns)
        .where(and(eq(pipelineRuns.task, 'system:heartbeat'), lt(pipelineRuns.startedAt, sql`datetime('now', '-2 days')`)))
        .run().changes
      return { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, local: new Date().toLocaleString('en-US'), pruned: removed }
    })
    return { result: outcome }
  },
})
