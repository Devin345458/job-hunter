import { jobs, knowledgeEntries } from '../../db/schema'
import { eq, isNull } from 'drizzle-orm'
import { scoreJobMatch } from '../../utils/ai'

export default defineTask({
  meta: {
    name: 'jobs:match',
    description: 'AI score unscored jobs against the knowledge base',
  },
  async run() {
    const db = useDb()
    console.log('[jobs:match] Starting AI job matching...')

    // Get unscored jobs (limit to 10 per run to manage API costs)
    const unscoredJobs = db
      .select()
      .from(jobs)
      .where(isNull(jobs.matchScore))
      .limit(10)
      .all()

    if (unscoredJobs.length === 0) {
      console.log('[jobs:match] No unscored jobs found')
      return { result: { scored: 0 } }
    }

    // Build knowledge base map
    const entries = db.select().from(knowledgeEntries).all()
    const knowledgeBase: Record<string, string> = {}
    for (const entry of entries) {
      knowledgeBase[`${entry.category}:${entry.key}`] = entry.value
    }

    let scored = 0

    for (const job of unscoredJobs) {
      if (!job.description) {
        console.log(`[jobs:match] Skipping job ${job.id} - no description`)
        continue
      }

      try {
        console.log(`[jobs:match] Scoring: "${job.title}" at ${job.company}`)
        const result = await scoreJobMatch(job.description, knowledgeBase)

        db.update(jobs)
          .set({
            matchScore: result.score,
            matchReasoning: JSON.stringify(result),
          })
          .where(eq(jobs.id, job.id))
          .run()

        scored++
        console.log(`[jobs:match] ${job.title} -> Score: ${result.score} (${result.recommendation})`)
      } catch (e) {
        console.error(`[jobs:match] Error scoring job ${job.id}:`, e)
      }
    }

    console.log(`[jobs:match] Complete. Scored: ${scored}`)
    return { result: { scored } }
  },
})
