import { askDailyQuestions } from '../../utils/questions'
import { matchStep } from '../../utils/queue-jobs'

// Queues one jobs:match-one item for every read job without a current score (no cap), waits for
// them, rescores every open job in code, and records the counts.
// Payload: { jobIds?: number[], fresh?: boolean } scores those only.
export default defineTask({
  meta: {
    name: 'jobs:match',
    description: 'Score enriched jobs on skills and total compensation, then rescore open jobs',
  },
  async run({ payload }) {
    const outcome = await withRun('jobs:match', triggerOf(payload), async (log) => {
      const stats = await matchStep((payload ?? {}) as Record<string, unknown>, log)
      // Ask about skills the newly read and scored jobs need now, not at tomorrow's learning step.
      const asked = askDailyQuestions()
      if (asked.length) log(`asked ${asked.length} new skill ${asked.length === 1 ? 'question' : 'questions'}`)
      return { ...stats, skillQuestionsAsked: asked.length }
    })
    return { result: outcome }
  },
})
