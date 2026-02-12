import { eq, sql } from 'drizzle-orm'
import { knowledgeEntries } from '~~/server/db/schema'

export default defineEventHandler(async (event) => {
  const db = useDb()
  const id = Number(getRouterParam(event, 'id'))
  const body = await readBody(event)

  if (!id || isNaN(id)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid knowledge entry ID',
    })
  }

  try {
    const [existing] = await db
      .select()
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.id, id))

    if (!existing) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Knowledge entry not found',
      })
    }

    const allowedFields = ['key', 'value', 'category'] as const
    const updateData: Record<string, any> = {
      updatedAt: sql`(datetime('now'))`,
    }

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updateData[field] = body[field]
      }
    }

    // Validate category if being updated
    if (updateData.category) {
      const validCategories = ['profile', 'experience', 'skill', 'preference', 'project', 'education', 'personal']
      if (!validCategories.includes(updateData.category)) {
        throw createError({
          statusCode: 400,
          statusMessage: `Invalid category. Must be one of: ${validCategories.join(', ')}`,
        })
      }
    }

    await db
      .update(knowledgeEntries)
      .set(updateData)
      .where(eq(knowledgeEntries.id, id))

    const [updated] = await db
      .select()
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.id, id))

    return updated
  } catch (error: any) {
    if (error.statusCode) throw error
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to update knowledge entry',
    })
  }
})
