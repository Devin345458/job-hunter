// Placeholder registered by the foundation unit so the daily chain and the manual trigger
// resolve this name. The owning capability replaces the body of run().
export default defineTask({
  meta: {
    name: 'learn:daily',
    description: 'Turn decisions and answers into learned rules and rescore',
  },
  async run({ payload }) {
    const outcome = await withRun('learn:daily', triggerOf(payload), async () => ({ note: 'not built yet' }))
    return { result: outcome }
  },
})
