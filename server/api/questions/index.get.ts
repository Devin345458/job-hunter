import { desc } from 'drizzle-orm'
import { questions } from '~~/server/db/schema'

export default defineEventHandler(async () => {
  const db = useDb()

  try {
    const allQuestions = await db
      .select()
      .from(questions)
      .orderBy(desc(questions.askedAt))

    return { questions: allQuestions }
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to fetch questions',
    })
  }
})
