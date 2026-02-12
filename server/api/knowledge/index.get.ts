import { eq } from 'drizzle-orm'
import { knowledgeEntries } from '~~/server/db/schema'

export default defineEventHandler(async (event) => {
  const db = useDb()
  const query = getQuery(event)

  const category = query.category as string | undefined

  try {
    if (category) {
      return await db
        .select()
        .from(knowledgeEntries)
        .where(eq(knowledgeEntries.category, category))
    }

    return await db
      .select()
      .from(knowledgeEntries)
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to fetch knowledge entries',
    })
  }
})
