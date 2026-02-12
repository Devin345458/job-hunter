import { eq, sql } from 'drizzle-orm'
import { questions } from '~~/server/db/schema'

export default defineEventHandler(async (event) => {
  const db = useDb()
  const id = Number(getRouterParam(event, 'id'))
  const body = await readBody(event)

  if (!id || isNaN(id)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid question ID',
    })
  }

  if (!body.status || !['answered', 'skipped'].includes(body.status)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'status must be "answered" or "skipped"',
    })
  }

  if (body.status === 'answered' && !body.answer) {
    throw createError({
      statusCode: 400,
      statusMessage: 'answer is required when status is "answered"',
    })
  }

  try {
    const [existing] = await db
      .select()
      .from(questions)
      .where(eq(questions.id, id))

    if (!existing) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Question not found',
      })
    }

    const updateData: Record<string, any> = {
      status: body.status,
    }

    if (body.status === 'answered') {
      updateData.answer = body.answer
      updateData.answeredAt = sql`(datetime('now'))`
    }

    await db
      .update(questions)
      .set(updateData)
      .where(eq(questions.id, id))

    const [updated] = await db
      .select()
      .from(questions)
      .where(eq(questions.id, id))

    return updated
  } catch (error: any) {
    if (error.statusCode) throw error
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to update question',
    })
  }
})
