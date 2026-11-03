import { eq } from 'drizzle-orm'
import { applications } from '~~/server/db/schema'

// Stage 1 Apply: Devin wants this job. Records the decision (a positive signal for learning),
// then queues the preparation (applications:prepare-one): the tailored resume and its evidence
// check, the cover letter and its check, the form answers and their check, and a dry run of the
// employer form with a screenshot. Nothing is submitted: the prepared application comes back as a
// Send card, and Approve there is still the only path to a submit.
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  const item = Number.isInteger(id) ? getReviewItem(id) : null
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Application not found' })
  if (item.status !== 'to_decide') {
    throw createError({ statusCode: 409, statusMessage: `Only an application waiting on your decision can be applied to (this one is ${item.status})` })
  }
  if (activeItem([APPROVE_TASK, PREPARE_ONE_TASK, REFILL_TASK], 'applicationId', id)) {
    throw createError({ statusCode: 409, statusMessage: 'This application is already in the queue' })
  }
  const decision = recordDecision(id, 'apply', null, null)
  queuePrepare(id, 'Waiting in the queue to prepare')
  useDb().update(applications).set({ decidedAt: nowSql() }).where(eq(applications.id, id)).run()
  await onDecision(decision.id).catch(e => console.error('[learning] onDecision failed', e))
  setResponseStatus(event, 202)
  return getReviewItem(id)
})
