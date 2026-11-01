import { enrichJobs } from '../../utils/enrich'

export default defineTask({
  meta: {
    name: 'jobs:enrich',
    description: 'Fetch full postings, resolve apply URLs, extract compensation and requirements',
  },
  async run({ payload }) {
    const outcome = await withRun('jobs:enrich', triggerOf(payload), log => enrichJobs({ log }))
    return { result: outcome }
  },
})
