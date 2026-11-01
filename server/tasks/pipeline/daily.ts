// The daily chain. One scheduled entry runs every step in order, so a slow search
// never races the match step the way two fixed cron times would.
export const DAILY_STEPS = [
  'learn:daily',
  'jobs:search',
  'jobs:enrich',
  'jobs:match',
  'applications:prepare',
  'demos:build',
] as const

export default defineTask({
  meta: {
    name: 'pipeline:daily',
    description: 'Learn from decisions, search, enrich, score, prepare applications, build demos',
  },
  async run({ payload }) {
    const outcome = await withRun('pipeline:daily', triggerOf(payload), async (log) => {
      const steps: Record<string, string> = {}
      for (const step of DAILY_STEPS) {
        log(`running ${step}`)
        const res: any = await runTask(step, { payload: { trigger: 'chained' } })
        steps[step] = res?.result?.status ?? 'unknown'
      }
      return { steps }
    })
    return { result: outcome }
  },
})
