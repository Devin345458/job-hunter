import { and, eq } from 'drizzle-orm'
import { decisions } from '~~/server/db/schema'

// The only route that leads to a submission. It records the decision, marks the
// application approved, and adds the approval (publish the demo, submit the form) to the job
// queue as applications:approve. A restart in the middle never runs it again; the application
// then says to check the employer's site (server/utils/approval.ts, markApprovalInterrupted).
// Retrying is allowed after a failed or interrupted submit, and after an approved application
// came back as "submit by hand" (captcha, or real submits switched off), reusing the original
// decision.
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
  if (activeItem([APPROVE_TASK, PREPARE_ONE_TASK, REFILL_TASK], 'applicationId', id)) {
    throw createError({ statusCode: 409, statusMessage: 'This application is already in the queue' })
  }
  const blocking = item.openQuestions.filter(q => q.blocking)
  if (blocking.length > 0) {
    throw createError({ statusCode: 409, statusMessage: `Answer ${blocking.length} open ${blocking.length === 1 ? 'question' : 'questions'} first` })
  }
  if (item.approveEffect.demoBlocked) {
    throw createError({ statusCode: 409, statusMessage: `${item.approveEffect.demoBlocked}. Set it, or discard the demo, then approve.` })
  }
  if (!retry) {
    const decision = recordDecision(id, 'approve', null, null)
    setApplicationStatus(id, 'approved', 'Approved, waiting in the queue to submit', { decidedAt: nowSql() })
    await onDecision(decision.id).catch(e => console.error('[learning] onDecision failed', e))
  }
  else {
    setApplicationStatus(id, 'approved', 'Approved again, waiting in the queue to submit')
  }
  enqueue(APPROVE_TASK, { applicationId: id }, { trigger: 'manual', existing: () => activeItem(APPROVE_TASK, 'applicationId', id) })
  setResponseStatus(event, 202)
  return getReviewItem(id)
})
