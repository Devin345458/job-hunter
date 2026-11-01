// GET /api/questions?status=pending&applicationId=12
// applicationId returns the questions that application asked plus the ones its form answers
// or gap analysis wait on (one question can serve several applications).
export default defineEventHandler((event) => {
  const query = getQuery(event)
  const applicationId = Number(query.applicationId)
  const status = typeof query.status === 'string' && query.status ? query.status : undefined
  return {
    questions: listQuestionItems({
      status,
      applicationId: Number.isInteger(applicationId) && applicationId > 0 ? applicationId : undefined,
    }),
  }
})
