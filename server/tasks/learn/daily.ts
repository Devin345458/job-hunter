// Runs first in the daily chain. Rebuilds every learned rule from every approve and reject,
// maps new rejection notes with Claude (once per note), asks the questions the pipeline needs,
// then rescores open jobs so today's queue reflects what Devin taught it yesterday.
export default defineTask({
  meta: {
    name: 'learn:daily',
    description: 'Turn decisions and answers into learned rules and rescore',
  },
  async run({ payload }) {
    const outcome = await withRun('learn:daily', triggerOf(payload), async log => runDailyLearning(log))
    return { result: outcome }
  },
})
