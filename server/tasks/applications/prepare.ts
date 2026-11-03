import { stoppedPreparations } from '~~/server/utils/apply/decide'

// Before decide-first, the scheduled run prepared the five strongest matches on its own. It no
// longer does: an application is prepared only after Devin taps Apply (applications:prepare-one,
// queued by POST /api/review/:id/apply). This task stays so a run queued before the change, or
// one started by hand, still ends cleanly: it continues stopped preparations Devin already chose
// and never picks a job itself. applications:read-forms does the same in the scheduled run.
export default defineTask({
  meta: {
    name: 'applications:prepare',
    description: 'Continue preparations you chose that stopped; never picks jobs on its own',
  },
  async run({ payload }) {
    const outcome = await withRun('applications:prepare', triggerOf(payload), async (log) => {
      const continued: number[] = []
      for (const app of stoppedPreparations()) {
        queuePrepare(app.id, 'Waiting in the queue to continue preparing')
        continued.push(app.id)
      }
      log(`queued ${continued.length} stopped ${continued.length === 1 ? 'preparation' : 'preparations'} again; new jobs are prepared only after you tap Apply`)
      return { preparationsContinued: continued.length, note: 'Applications are prepared only after you tap Apply.' }
    })
    return { result: outcome }
  },
})
