// POST /api/pipeline/queue/:id/cancel: take a waiting item out of the job queue. For a full run
// under way, its waiting steps are canceled and the step running now finishes. Approvals and
// application preparations are not canceled here.
export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: 'Invalid queue item' })
  const refusal = cancelItem(id)
  if (refusal) throw createError({ statusCode: 409, statusMessage: refusal })
  return { canceled: id }
})
