import { eq } from 'drizzle-orm'
import { pipelineRuns } from '../db/schema'

// One server process runs the tasks, so at startup any pipeline_runs row still marked running
// belongs to a process that died (a deploy or crash mid-run). Close it so the dashboard does not
// show a run that will never finish.
export default defineNitroPlugin(() => {
  try {
    const closed = useDb().update(pipelineRuns)
      .set({ status: 'failed', finishedAt: new Date().toISOString().replace('T', ' ').slice(0, 19), error: 'The server restarted before this run finished' })
      .where(eq(pipelineRuns.status, 'running'))
      .run().changes
    if (closed) console.log(`[runs] closed ${closed} run(s) left running by a previous server process`)
  }
  catch (e) {
    console.error('[runs] could not close stale runs', e)
  }
})
