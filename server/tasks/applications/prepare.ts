// Placeholder registered by the foundation unit so the daily chain and the manual trigger
// resolve this name. The owning capability replaces the body of run().
export default defineTask({
  meta: {
    name: 'applications:prepare',
    description: 'Tailor, write cover letters, and fill employer forms for top matches',
  },
  async run({ payload }) {
    const outcome = await withRun('applications:prepare', triggerOf(payload), async () => ({ note: 'not built yet' }))
    return { result: outcome }
  },
})
