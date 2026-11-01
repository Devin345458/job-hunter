// Placeholder registered by the foundation unit so the daily chain and the manual trigger
// resolve this name. The owning capability replaces the body of run().
export default defineTask({
  meta: {
    name: 'jobs:enrich',
    description: 'Fetch full postings, resolve apply URLs, extract compensation',
  },
  async run({ payload }) {
    const outcome = await withRun('jobs:enrich', triggerOf(payload), async () => ({ note: 'not built yet' }))
    return { result: outcome }
  },
})
