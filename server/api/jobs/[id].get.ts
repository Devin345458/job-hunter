import { and, desc, eq, or } from 'drizzle-orm'
import { jobs, questions, scoreHistory } from '~~/server/db/schema'
import type { CompensationBreakdown, Requirement, ScoreBreakdown } from '#shared/types/pipeline'

// One job, with its JSON columns parsed for the detail page, its score history, and the
// questions Devin can answer to complete its score.
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

  const openQuestions = db.select().from(questions)
    .where(and(eq(questions.status, 'pending'), or(eq(questions.jobId, id), eq(questions.kind, 'preference'))))
    .all()
    .map(toQuestionView)

  const meta = parseJson<Record<string, unknown>>(job.atsMeta, {})

  return {
    ...job,
    compensation: parseJson<CompensationBreakdown | null>(job.compJson, null),
    score: parseJson<ScoreBreakdown | null>(job.scoreBreakdown, null),
    requirements: parseJson<Requirement[]>(job.requirementsJson, []),
    postingUrl: typeof meta.postingUrl === 'string' ? meta.postingUrl : job.url,
    enrichNotes: Array.isArray(meta.enrichNotes) ? meta.enrichNotes as string[] : [],
    scoreHistory: history,
    openQuestions,
  }
})
