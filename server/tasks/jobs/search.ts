import { runSearch } from '../../utils/job-sources'

export default defineTask({
  meta: {
    name: 'jobs:search',
    description: 'Search every active config across the aggregators and the employer job boards',
  },
  async run({ payload }) {
    const outcome = await withRun('jobs:search', triggerOf(payload), log => runSearch(log))
    return { result: outcome }
  },
})
