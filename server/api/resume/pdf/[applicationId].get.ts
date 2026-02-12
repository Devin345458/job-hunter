import { eq } from 'drizzle-orm'
import { applications, jobs, knowledgeEntries } from '~~/server/db/schema'
import { generateResumePdf } from '~~/server/utils/pdf'
import { existsSync, readFileSync } from 'fs'
import type { TailoredResume } from '~~/server/utils/ai'

export default defineEventHandler(async (event) => {
  const db = useDb()
  const applicationId = Number(getRouterParam(event, 'applicationId'))

  if (!applicationId || isNaN(applicationId)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid application ID',
    })
  }

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

    // If a PDF already exists at the stored path, serve it
    if (application.tailoredResumePdfPath && existsSync(application.tailoredResumePdfPath)) {
      const pdfBuffer = readFileSync(application.tailoredResumePdfPath)
      setResponseHeader(event, 'Content-Type', 'application/pdf')
      setResponseHeader(event, 'Content-Disposition', `inline; filename="resume-${applicationId}.pdf"`)
      return pdfBuffer
    }

    // Otherwise generate from resume JSON
    if (!application.tailoredResumeJson) {
      throw createError({
        statusCode: 400,
        statusMessage: 'No tailored resume available for this application. Generate one first.',
      })
    }

    const resume: TailoredResume = JSON.parse(application.tailoredResumeJson)

    // Get candidate name and contact info from knowledge base
    const entries = await db
      .select()
      .from(knowledgeEntries)

    const kb: Record<string, string> = {}
    for (const entry of entries) {
      kb[`${entry.category}/${entry.key}`] = entry.value
    }

    const candidateName = kb['profile/name'] || kb['profile/full_name'] || 'Candidate'
    const contactInfo = {
      email: kb['profile/email'] || undefined,
      phone: kb['profile/phone'] || undefined,
      location: kb['profile/location'] || undefined,
      linkedin: kb['profile/linkedin'] || undefined,
      github: kb['profile/github'] || undefined,
    }

    const pdfBuffer = await generateResumePdf(resume, candidateName, contactInfo)

    setResponseHeader(event, 'Content-Type', 'application/pdf')
    setResponseHeader(event, 'Content-Disposition', `inline; filename="resume-${applicationId}.pdf"`)
    return pdfBuffer
  } catch (error: any) {
    if (error.statusCode) throw error
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to generate PDF',
    })
  }
})
