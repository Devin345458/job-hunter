import { scoreJobs } from '../../utils/scoring'

export default defineTask({
  meta: {
    name: 'jobs:match',
    description: 'Score enriched jobs on skills and total compensation, then rescore open jobs',
  },
  async run({ payload }) {
    const outcome = await withRun('jobs:match', triggerOf(payload), log => scoreJobs({ log }))
    return { result: outcome }
  },
})
