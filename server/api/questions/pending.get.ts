// GET /api/questions/pending?applicationId=12
export default defineEventHandler((event) => {
  const applicationId = Number(getQuery(event).applicationId)
  return listQuestionItems({
    status: 'pending',
    applicationId: Number.isInteger(applicationId) && applicationId > 0 ? applicationId : undefined,
  })
})
