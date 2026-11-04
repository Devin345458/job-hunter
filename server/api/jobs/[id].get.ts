import { and, desc, eq, ne, or, sql } from 'drizzle-orm'
import { applications, jobs, questions, scoreHistory } from '~~/server/db/schema'
import type { CompensationBreakdown, Requirement, ScoreBreakdown } from '#shared/types/pipeline'
import { HEALTH_SUBJECT, isFullyPaidHealth } from '~~/server/utils/compensation'
import { plainError } from '#shared/utils/plain-text'
import { jobGroupKey, latestApplication, toJobApplication } from '~~/server/utils/job-list'

// One job, with its JSON columns parsed for the detail page, its score history, the questions
// Devin can answer to complete its score, its application if one exists, and the other postings
// of the same role at the same company (the jobs list shows them as one card).
export default defineEventHandler(async (event) => {
  const db = useDb()
  const id = Number(getRouterParam(event, 'id'))
  if (!id || Number.isNaN(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid job ID' })
  }

  const job = db.select().from(jobs).where(eq(jobs.id, id)).get()
  if (!job) {
    throw createError({ statusCode: 404, statusMessage: 'Job not found' })
  }

  const history = db.select({
    score: scoreHistory.score,
    skillsScore: scoreHistory.skillsScore,
    compScore: scoreHistory.compScore,
    learnedAdjustment: scoreHistory.learnedAdjustment,
    reason: scoreHistory.reason,
    computedAt: scoreHistory.computedAt,
  }).from(scoreHistory).where(eq(scoreHistory.jobId, id)).orderBy(desc(scoreHistory.id)).limit(20).all()

  const compensation = parseJson<CompensationBreakdown | null>(job.compJson, null)
  // The health insurance value only matters for postings that say the employer pays all of it.
  const needsHealthValue = !!compensation?.benefits.some(b => isFullyPaidHealth(b) && b.estimatedAnnualValue == null)
  const openQuestions = db.select().from(questions)
    .where(and(eq(questions.status, 'pending'), or(eq(questions.jobId, id), eq(questions.kind, 'preference'))))
    .all()
    .filter(q => q.subject !== HEALTH_SUBJECT || needsHealthValue)
    .map(toQuestionView)

  const meta = parseJson<Record<string, unknown>>(job.atsMeta, {})

  // hasResume: the job page offers the PDF only when a tailored resume was written. A Decide card
  // (to_decide) has an application row and no resume until Apply prepares one.
  const app = db.select({
    id: applications.id,
    status: applications.status,
    formError: applications.formError,
    statusDetail: applications.statusDetail,
    submittedAt: applications.submittedAt,
    hasResume: sql<number>`(${applications.tailoredResumeJson} is not null or ${applications.tailoredResumePdfPath} is not null)`,
  })
    .from(applications).where(eq(applications.jobId, id)).orderBy(desc(applications.id)).limit(1).get()

  const groupKey = jobGroupKey()
  const otherPostings = db.select({
    id: jobs.id,
    location: jobs.location,
    status: jobs.status,
    matchScore: jobs.matchScore,
    foundAt: jobs.foundAt,
    appId: latestApplication('id'),
    appStatus: latestApplication('status'),
    appFormError: latestApplication('form_error'),
  })
    .from(jobs)
    .where(and(ne(jobs.id, id), sql`${groupKey} = lower(trim(${job.company})) || char(31) || lower(trim(${job.title}))`))
    .orderBy(jobs.id)
    .all()
    .map(({ appId, appStatus, appFormError, ...p }) => ({ ...p, application: toJobApplication(appId, appStatus, appFormError) }))

  return {
    ...job,
    compensation,
    score: parseJson<ScoreBreakdown | null>(job.scoreBreakdown, null),
    requirements: parseJson<Requirement[]>(job.requirementsJson, []),
    postingUrl: typeof meta.postingUrl === 'string' ? meta.postingUrl : job.url,
    enrichNotes: Array.isArray(meta.enrichNotes) ? meta.enrichNotes as string[] : [],
    scoreHistory: history,
    openQuestions,
    application: app
      ? {
          ...toJobApplication(app.id, app.status, app.formError)!,
          hasResume: !!app.hasResume,
          statusDetail: app.statusDetail ? plainError(app.statusDetail) : null,
          submittedAt: app.submittedAt,
        }
      : null,
    otherPostings,
  }
})
