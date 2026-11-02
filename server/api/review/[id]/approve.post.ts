import { and, eq } from 'drizzle-orm'
import { decisions } from '~~/server/db/schema'

// The only route that leads to a submission. It records the decision, marks the
// application approved, and starts the approval run in the background.
// Retrying is allowed after a failed submit, and after an approved application came back as
// "submit by hand" (captcha, or real submits switched off), reusing the original decision.
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  const item = Number.isInteger(id) ? getReviewItem(id) : null
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Application not found' })
  const approvedBefore = !!useDb().select({ id: decisions.id }).from(decisions)
    .where(and(eq(decisions.applicationId, id), eq(decisions.decision, 'approve'))).get()
  const retry = item.status === 'submit_failed' || (item.status === 'needs_manual' && approvedBefore)
  if (item.status !== 'proposed' && !retry) {
    throw createError({ statusCode: 409, statusMessage: `Only proposed applications can be approved (this one is ${item.status})` })
  }
  const blocking = item.openQuestions.filter(q => q.blocking)
  if (blocking.length > 0) {
    throw createError({ statusCode: 409, statusMessage: `Answer ${blocking.length} open ${blocking.length === 1 ? 'question' : 'questions'} first` })
  }
  if (!retry) {
    const decision = recordDecision(id, 'approve', null, null)
    setApplicationStatus(id, 'approved', 'Approved, starting', { decidedAt: nowSql() })
    await onDecision(decision.id).catch(e => console.error('[learning] onDecision failed', e))
  }
  void runApproval(id)
  setResponseStatus(event, 202)
  return getReviewItem(id)
})
