import { eq } from 'drizzle-orm'
import { jobs } from '~~/server/db/schema'

export default defineEventHandler(async (event) => {
  const db = useDb()
  const id = Number(getRouterParam(event, 'id'))
  const body = await readBody(event)

  if (!id || isNaN(id)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid job ID',
    })
  }

  if (!body.status) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Status is required',
    })
  }

  const validStatuses = ['new', 'reviewed', 'applied', 'rejected', 'expired']
  if (!validStatuses.includes(body.status)) {
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
    })
  }

  try {
    const [existing] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, id))

    if (!existing) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Job not found',
      })
    }

    await db
      .update(jobs)
      .set({ status: body.status })
      .where(eq(jobs.id, id))

    const [updated] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, id))

    return updated
  } catch (error: any) {
    if (error.statusCode) throw error
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to update job',
    })
  }
})
