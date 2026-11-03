import { DAILY_STEPS } from '#shared/utils/schedule'

// The daily chain. One scheduled entry runs every step in order, so a slow search never races
// the match step the way two fixed cron times would. The order lives in shared/utils/schedule.ts
// (DAILY_STEPS) so Settings lists the steps in the order they run; it is re-exported here for the
// API routes that import it from this file.
// The steps run as queue items (server/utils/queue.ts): the worker turns a pipeline:daily item
// into one child item per step and finishes this run's pipeline_runs row after the last one, with
// every step's status and problems (stepSummary). Calling this task directly only queues a run.
export { DAILY_STEPS }

export default defineTask({
  meta: {
    name: 'pipeline:daily',
    description: 'Index GitHub commits, learn from decisions, search, enrich, score, read the forms of strong matches, build demos, suggest answers from GitHub',
  },
  async run({ payload }) {
    if (scheduleSkipped(payload as Record<string, unknown> | undefined)) return { result: { skipped: 'the schedule is off on this server (NUXT_SCHEDULER_ENABLED=false)' } }
    const { item, created } = enqueueDaily(triggerOf(payload))
    return { result: { queued: item.id, created } }
  },
})
