import { runOutcome, runProblems } from '#shared/utils/run-outcome'

// The daily chain. One scheduled entry runs every step in order, so a slow search
// never races the match step the way two fixed cron times would. repos:index runs first so the
// day's questions can be checked against fresh commits. repos:suggest runs last so the questions
// learn:daily and applications:prepare asked in this run get a suggestion too.
export const DAILY_STEPS = [
  'repos:index',
  'learn:daily',
  'jobs:search',
  'jobs:enrich',
  'jobs:match',
  'applications:prepare',
  'demos:build',
  'repos:suggest',
] as const

/**
 * What one chained step reported back to the daily run: its status and, when it finished, the
 * problems its stats show (failed items, a budget or credit stop). A step that "succeeded" while
 * every Claude call failed is how the daily run used to look green over a dead pipeline.
 */
export function stepSummary(step: string, result: { status?: string; stats?: Record<string, unknown> | null; error?: string | null } | null | undefined) {
  const status = result?.status ?? 'unknown'
  const problems = runProblems({ task: step, status, stats: result?.stats ?? null })
  return { status, problems }
}

export default defineTask({
  meta: {
    name: 'pipeline:daily',
    description: 'Index GitHub commits, learn from decisions, search, enrich, score, prepare applications, build demos, suggest answers from GitHub',
  },
  async run({ payload }) {
    if (scheduleSkipped(payload as Record<string, unknown> | undefined)) return { result: { skipped: 'the schedule is off on this server (NUXT_SCHEDULER_ENABLED=false)' } }
    const outcome = await withRun('pipeline:daily', triggerOf(payload), async (log) => {
      const steps: Record<string, string> = {}
      const problems: Record<string, string[]> = {}
      for (const step of DAILY_STEPS) {
        log(`running ${step}`)
        const res: any = await runTask(step, { payload: { trigger: 'chained' } })
        const summary = stepSummary(step, res?.result)
        steps[step] = summary.status
        if (summary.problems.length) problems[step] = summary.problems
      }
      const stats = { steps, problems }
      return { ...stats, outcome: runOutcome({ task: 'pipeline:daily', status: 'succeeded', stats }, runProblems({ task: 'pipeline:daily', status: 'succeeded', stats })) }
    })
    return { result: outcome }
  },
})
