import { eq } from 'drizzle-orm'
import { applications, jobs, knowledgeEntries } from '~~/server/db/schema'
import { tailorResume } from '~~/server/utils/ai'

export default defineEventHandler(async (event) => {
  const db = useDb()
  const body = await readBody(event)

  if (!body.applicationId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'applicationId is required',
    })
  }

  const applicationId = Number(body.applicationId)

  try {
    // Fetch the application
    const applicationResult = await db
      .select()
      .from(applications)
      .where(eq(applications.id, applicationId))

    const application = applicationResult?.[0]
    if (!application) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Application not found',
      })
    }

    // Fetch the associated job
    const jobResult = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, application.jobId))

    const job = jobResult?.[0]
    if (!job) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Associated job not found',
      })
    }

    // Fetch all knowledge entries and format as key-value map
    const entries = await db
      .select()
      .from(knowledgeEntries)

    const knowledgeBase: Record<string, string> = {}
    for (const entry of entries) {
      knowledgeBase[`${entry.category}/${entry.key}`] = entry.value
    }

    // Generate tailored resume
    const tailored = await tailorResume(
      job.description || `${job.title} at ${job.company}`,
      knowledgeBase,
    )

    // Update the application with the new resume JSON
    await db
      .update(applications)
      .set({
        tailoredResumeJson: JSON.stringify(tailored),
        tailoringNotes: tailored.tailoringNotes,
        updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
      })
      .where(eq(applications.id, applicationId))

    return tailored
  } catch (error: any) {
    if (error.statusCode) throw error
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to generate resume',
    })
  }
})
