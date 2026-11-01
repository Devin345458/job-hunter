// Placeholder registered by the foundation unit so the daily chain and the manual trigger
// resolve this name. The owning capability replaces the body of run().
export default defineTask({
  meta: {
    name: 'demos:build',
    description: 'Build demo projects that close requirement gaps',
  },
  async run({ payload }) {
    const outcome = await withRun('demos:build', triggerOf(payload), async () => ({ note: 'not built yet' }))
    return { result: outcome }
  },
})
