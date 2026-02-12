import { eq } from 'drizzle-orm'
import { jobs } from '~~/server/db/schema'

export default defineEventHandler(async (event) => {
  const db = useDb()
  const id = Number(getRouterParam(event, 'id'))

  if (!id || isNaN(id)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid job ID',
    })
  }

  try {
    const jobResult = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, id))

    const job = jobResult?.[0]
    if (!job) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Job not found',
      })
    }

    return job
  } catch (error: any) {
    if (error.statusCode) throw error
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to fetch job',
    })
  }
})
