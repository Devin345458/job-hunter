import { eq } from 'drizzle-orm'
import { applications, jobs, questions } from '~~/server/db/schema'

// One application with its job, its questions, and the ReviewItem view the review dashboard uses
// (form snapshot, answers, screenshot URL, open questions including shared ones, submission).
export default defineEventHandler((event) => {
  const db = useDb()
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: 'Invalid application ID' })

  const row = db.select({ application: applications, job: jobs })
    .from(applications)
    .leftJoin(jobs, eq(applications.jobId, jobs.id))
    .where(eq(applications.id, id))
    .get()
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Application not found' })

  const relatedQuestions = db.select().from(questions).where(eq(questions.applicationId, id)).all()
  return {
    ...row.application,
    job: row.job,
    questions: relatedQuestions,
    review: getReviewItem(id),
  }
})
