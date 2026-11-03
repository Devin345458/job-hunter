import { enrichStep } from '../../utils/queue-jobs'

// Queues one jobs:enrich-one item for every job still waiting to be read (no cap; best candidates
// first), waits for them, and records the counts. Payload: { jobIds?: number[] } reads those again.
export default defineTask({
  meta: {
    name: 'jobs:enrich',
    description: 'Fetch full postings, resolve apply URLs, extract compensation and requirements',
  },
  async run({ payload }) {
    const outcome = await withRun('jobs:enrich', triggerOf(payload), log => enrichStep((payload ?? {}) as Record<string, unknown>, log))
    return { result: outcome }
  },
})
