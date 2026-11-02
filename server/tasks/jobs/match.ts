import { askDailyQuestions } from '../../utils/questions'
import { scoreJobs } from '../../utils/scoring'

export default defineTask({
  meta: {
    name: 'jobs:match',
    description: 'Score enriched jobs on skills and total compensation, then rescore open jobs',
  },
  async run({ payload }) {
    const outcome = await withRun('jobs:match', triggerOf(payload), async (log) => {
      const stats = await scoreJobs({ log, jobIds: payloadJobIds(payload) })
      // Ask about skills the newly read and scored jobs need now, not at tomorrow's learning step.
      const asked = askDailyQuestions()
      if (asked.length) log(`asked ${asked.length} new skill ${asked.length === 1 ? 'question' : 'questions'}`)
      return { ...stats, skillQuestionsAsked: asked.length }
    })
    return { result: outcome }
  },
})

/** Job ids from a manual run's payload ({ jobIds: [1, 2] }); undefined runs the normal selection. */
function payloadJobIds(payload: unknown): number[] | undefined {
  const ids = (payload as { jobIds?: unknown } | undefined)?.jobIds
  if (!Array.isArray(ids)) return undefined
  const clean = ids.map(Number).filter(Number.isInteger)
  return clean.length ? clean : undefined
}
