import { eq, and, desc } from 'drizzle-orm'
import { questions } from '~~/server/db/schema'

export default defineEventHandler(async (event) => {
  const db = useDb()
  const query = getQuery(event)

  const applicationId = query.applicationId ? Number(query.applicationId) : undefined

  try {
    const conditions = [eq(questions.status, 'pending')]

    if (applicationId) {
      conditions.push(eq(questions.applicationId, applicationId))
    }

    return await db
      .select()
      .from(questions)
      .where(and(...conditions))
      .orderBy(desc(questions.askedAt))
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to fetch pending questions',
    })
  }
})
