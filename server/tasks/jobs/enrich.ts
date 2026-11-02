import { enrichJobs } from '../../utils/enrich'

export default defineTask({
  meta: {
    name: 'jobs:enrich',
    description: 'Fetch full postings, resolve apply URLs, extract compensation and requirements',
  },
  async run({ payload }) {
    const outcome = await withRun('jobs:enrich', triggerOf(payload), log => enrichJobs({ log, jobIds: payloadJobIds(payload) }))
    return { result: outcome }
  },
})

/** Job ids from a manual run's payload ({ jobIds: [1, 2] }); undefined runs the normal selection. */
function payloadJobIds(payload: unknown): number[] | undefined {
  const ids = (payload as { jobIds?: unknown } | undefined)?.jobIds
  if (!Array.isArray(ids)) return undefined
  const clean = ids.map(Number).filter(Number.isInteger)
  return clean.length ? clean : undefined
}
