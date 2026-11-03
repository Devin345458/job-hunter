import { runSearch } from '../../utils/job-sources'
import { autoFollowOn, queueEnrichJob } from '../../utils/queue-jobs'

// Searches every active config. Each new job gets a jobs:enrich-one item, so it is read (and then
// scored) without waiting for the next full run; not where the schedule is off (Orca worktrees),
// where the full run's jobs:enrich step reads it instead.
export default defineTask({
  meta: {
    name: 'jobs:search',
    description: 'Search every active config across the aggregators and the employer job boards',
  },
  async run({ payload }) {
    const outcome = await withRun('jobs:search', triggerOf(payload), async (log) => {
      let queuedToRead = 0
      const follow = autoFollowOn()
      const stats = await runSearch(log, {
        onNewJob: (id) => {
          if (follow && queueEnrichJob(id).created) queuedToRead++
        },
      })
      return { ...stats, ...(follow ? { queuedToRead } : {}) }
    })
    return { result: outcome }
  },
})
