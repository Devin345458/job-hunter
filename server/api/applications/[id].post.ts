import { eq } from 'drizzle-orm'
import { applications, jobs, knowledgeEntries, questions } from '~~/server/db/schema'
import { tailorResume } from '~~/server/utils/ai'
import { saveResumePdf } from '~~/server/utils/pdf'

export default defineEventHandler(async (event) => {
  const db = useDb()
  const jobId = Number(getRouterParam(event, 'id'))

  if (!jobId || isNaN(jobId)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid job ID',
    })
  }

  try {
    // Verify the job exists
    const jobResult = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, jobId))

    const job = jobResult?.[0]
    if (!job) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Job not found',
      })
    }

    // Check if an application already exists for this job
    const existingAppResult = await db
      .select()
      .from(applications)
      .where(eq(applications.jobId, jobId))

    const existingApp = existingAppResult?.[0]
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
    const applicationResult = await db
      .insert(applications)
      .values({
        jobId,
        tailoredResumeJson: JSON.stringify(tailored),
        tailoringNotes: tailored.tailoringNotes,
        status: 'draft',
      })
      .returning()

    const newApplication = applicationResult?.[0]
    if (!newApplication) {
      throw createError({
        statusCode: 500,
        statusMessage: 'Failed to create application record',
      })
    }

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

    // Generate the PDF immediately
    const candidateName = knowledgeBase['profile/Full Name'] || knowledgeBase['profile/name'] || 'Candidate'
    const contactInfo = {
      email: knowledgeBase['profile/Email'] || undefined,
      phone: knowledgeBase['profile/Phone'] || undefined,
      github: knowledgeBase['profile/GitHub'] || undefined,
    }

    const pdfPath = `./data/resumes/resume-${newApplication.id}.pdf`
    await saveResumePdf(tailored, candidateName, contactInfo, pdfPath)

    // Update application with the PDF path
    await db
      .update(applications)
      .set({ tailoredResumePdfPath: pdfPath })
      .where(eq(applications.id, newApplication.id))

    // Update job status to applied
    await db
      .update(jobs)
      .set({ status: 'applied' })
      .where(eq(jobs.id, jobId))

    return { ...newApplication, tailoredResumePdfPath: pdfPath }
  } catch (error: any) {
    if (error.statusCode) throw error
    console.error('Application creation error:', error)
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to create application',
    })
  }
})
