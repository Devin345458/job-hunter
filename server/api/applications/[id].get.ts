import { eq } from 'drizzle-orm'
import { applications, jobs, questions } from '~~/server/db/schema'

export default defineEventHandler(async (event) => {
  const db = useDb()
  const id = Number(getRouterParam(event, 'id'))

  if (!id || isNaN(id)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid application ID',
    })
  }

  try {
    const resultArray = await db
      .select({
        application: applications,
        job: jobs,
      })
      .from(applications)
      .leftJoin(jobs, eq(applications.jobId, jobs.id))
      .where(eq(applications.id, id))

    const result = resultArray?.[0]
    if (!result) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Application not found',
      })
    }

    // Fetch related questions
    const relatedQuestions = await db
      .select()
      .from(questions)
      .where(eq(questions.applicationId, id))

    return {
      ...result.application,
      job: result.job,
      questions: relatedQuestions,
    }
  } catch (error: any) {
    if (error.statusCode) throw error
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to fetch application',
    })
  }
})
