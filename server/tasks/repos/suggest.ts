import { runRepoSuggest } from '~~/server/utils/repos/suggest'

// Last step of the daily chain, and queued within a minute of a new skill or experience question
// (server/utils/repos/suggest-store.ts). Suggests a level and an example for pending knows and
// has_done questions from Devin's own commits. Nothing is answered until he taps Use this and Save.
// Payload: { questionIds?: number[], force?: boolean } (force re-expands terms and re-judges).
export default defineTask({
  meta: {
    name: 'repos:suggest',
    description: 'Suggest answers to skill and experience questions from your own commits',
  },
  async run({ payload }) {
    if (scheduleSkipped(payload as Record<string, unknown> | undefined)) return { result: { skipped: 'the schedule is off on this server (NUXT_SCHEDULER_ENABLED=false)' } }
    const p = (payload ?? {}) as Record<string, unknown>
    const questionIds = Array.isArray(p.questionIds) ? p.questionIds.map(Number).filter(n => Number.isInteger(n) && n > 0) : undefined
    const outcome = await withRun('repos:suggest', triggerOf(payload), log => runRepoSuggest({ questionIds, force: p.force === true }, log))
    return { result: outcome }
  },
})
