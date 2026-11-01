import { eq } from 'drizzle-orm'
import { applications, jobs } from '~~/server/db/schema'
import { tailorResumeForJob } from '~~/server/utils/tailor'
import { saveResumePdf } from '~~/server/utils/pdf'

// POST /api/resume/generate { applicationId } re-tailors the resume for an application with the
// same two-pass flow the pipeline uses (reframe, then the evidence check), and re-renders the PDF.
export default defineEventHandler(async (event) => {
  const db = useDb()
  const body = await readBody<{ applicationId?: number }>(event)
  const applicationId = Number(body?.applicationId)
  if (!Number.isInteger(applicationId) || applicationId <= 0) throw createError({ statusCode: 400, statusMessage: 'applicationId is required' })

  const application = db.select().from(applications).where(eq(applications.id, applicationId)).get()
  if (!application) throw createError({ statusCode: 404, statusMessage: 'Application not found' })
  if (['submitting', 'submitted', 'approved', 'publishing'].includes(application.status)) {
    throw createError({ statusCode: 409, statusMessage: `The application is ${application.status}; its resume can no longer change` })
  }
  const job = db.select().from(jobs).where(eq(jobs.id, application.jobId)).get()
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Associated job not found' })

  const entries = loadKnowledge()
  const tailored = await tailorResumeForJob(job, entries, { type: 'application', id: applicationId })
  const { name, contact } = candidateContact(entries)
  const pdfPath = dataPath('resumes', `resume-${applicationId}.pdf`)
  await saveResumePdf(tailored.resume, name, contact, pdfPath)

  // Keep the cover letter's evidence record, replace the resume's.
  const letterNotes = (application.tailoringNotes || '').split('\n\n').filter(p => p.startsWith('Cover letter evidence check')).join('\n\n')
  db.update(applications).set({
    tailoredResumeJson: JSON.stringify(tailored.resume),
    tailoredResumePdfPath: pdfPath,
    tailoringNotes: [tailored.notes, letterNotes].filter(Boolean).join('\n\n'),
    updatedAt: nowSql(),
  }).where(eq(applications.id, applicationId)).run()
  return tailored.resume
})
