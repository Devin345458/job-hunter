import { eq, sql, and, isNull } from 'drizzle-orm'
import { jobs, knowledgeEntries } from '~~/server/db/schema'
import { scoreJobMatch } from '~~/server/utils/ai'

export default defineEventHandler(async (event) => {
  const db = useDb()
  const body = await readBody(event)

  try {
    // Build knowledge base from all entries
    const entries = await db
      .select()
      .from(knowledgeEntries)

    if (entries.length === 0) {
      throw createError({
        statusCode: 400,
        statusMessage: 'No knowledge base entries found. Add your profile information first.',
      })
    }

    const knowledgeBase: Record<string, string> = {}
    for (const entry of entries) {
      knowledgeBase[`${entry.category}/${entry.key}`] = entry.value
    }

    // Get jobs to score
    let jobsToScore
    if (body.jobIds && Array.isArray(body.jobIds) && body.jobIds.length > 0) {
      jobsToScore = await db
        .select()
        .from(jobs)
        .where(sql`${jobs.id} IN (${sql.join(body.jobIds.map((id: number) => sql`${id}`), sql`, `)})`)
    } else {
      // Score all unscored jobs, limit 10
      jobsToScore = await db
        .select()
        .from(jobs)
        .where(isNull(jobs.matchScore))
        .limit(10)
    }

    if (jobsToScore.length === 0) {
      return { scored: 0 }
    }

    let scoredCount = 0
    for (const job of jobsToScore) {
      try {
        const result = await scoreJobMatch(
          job.description || `${job.title} at ${job.company}`,
          knowledgeBase,
        )

        await db
          .update(jobs)
          .set({
            matchScore: result.score,
            matchReasoning: result.reasoning,
          })
          .where(eq(jobs.id, job.id))

        scoredCount++
      } catch (err) {
        console.error(`Failed to score job ${job.id}:`, err)
        // Continue with next job
      }
    }

    return { scored: scoredCount }
  } catch (error: any) {
    if (error.statusCode) throw error
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to score jobs',
    })
  }
})
