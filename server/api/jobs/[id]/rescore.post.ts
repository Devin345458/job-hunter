import type { JobRescoreResult } from '#shared/types/pipeline'

// POST /api/jobs/:id/rescore: Claude scores this job's skills again from the knowledge base as it
// is now (one call), then the score is composed as jobs:match does. Waits for the result.
export default defineEventHandler(async (event): Promise<JobRescoreResult> => {
  const id = Number(getRouterParam(event, 'id'))
  return await rescoreJobSkills(id)
})
