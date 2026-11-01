// The only route that leads to a submission. It records the decision, marks the
// application approved, and starts the approval run in the background.
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  const item = Number.isInteger(id) ? getReviewItem(id) : null
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Application not found' })
  const retry = item.status === 'submit_failed'
  if (item.status !== 'proposed' && !retry) {
    throw createError({ statusCode: 409, statusMessage: `Only proposed applications can be approved (this one is ${item.status})` })
  }
  const blocking = item.openQuestions.filter(q => q.blocking)
  if (blocking.length > 0) {
    throw createError({ statusCode: 409, statusMessage: `Answer ${blocking.length} open question(s) first` })
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
