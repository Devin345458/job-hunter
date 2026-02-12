import { eq } from 'drizzle-orm'
import { applications, jobs, knowledgeEntries, questions } from '~~/server/db/schema'
import { tailorResume } from '~~/server/utils/ai'

export default defineEventHandler(async (event) => {
  const db = useDb()
  const jobId = Number(getRouterParam(event, 'jobId'))

  if (!jobId || isNaN(jobId)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid job ID',
    })
  }

  try {
    // Verify the job exists
    const [job] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, jobId))

    if (!job) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Job not found',
      })
    }

    // Check if an application already exists for this job
    const [existingApp] = await db
      .select()
      .from(applications)
      .where(eq(applications.jobId, jobId))

    if (existingApp) {
      throw createError({
        statusCode: 409,
        statusMessage: 'An application already exists for this job',
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

    // Tailor the resume via AI
    const tailored = await tailorResume(
      job.description || `${job.title} at ${job.company}`,
      knowledgeBase,
    )

    // Create the application
    const [newApplication] = await db
      .insert(applications)
      .values({
        jobId,
        tailoredResumeJson: JSON.stringify(tailored),
        tailoringNotes: tailored.tailoringNotes,
        status: 'draft',
      })
      .returning()

    // Create any generated questions
    if (tailored.generatedQuestions && tailored.generatedQuestions.length > 0) {
      await db.insert(questions).values(
        tailored.generatedQuestions.map(q => ({
          question: q.question,
          context: q.context,
          category: q.category,
          applicationId: newApplication.id,
          status: 'pending',
        })),
      )
    }

    // Update job status to applied
    await db
      .update(jobs)
      .set({ status: 'applied' })
      .where(eq(jobs.id, jobId))

    return newApplication
  } catch (error: any) {
    if (error.statusCode) throw error
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to create application',
    })
  }
})
