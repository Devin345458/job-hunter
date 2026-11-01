// PATCH /api/questions/:id
//   { status: 'answered', answer }  writes the knowledge base, refreshes waiting applications, rescores
//   { status: 'skipped' }           skips for now
//   { status: 'pending' }           reopens a skipped question
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: 'Invalid question ID' })
  const body = await readBody<{ status?: string; answer?: unknown }>(event)
  switch (body?.status) {
    case 'answered':
      return await answerQuestion(id, typeof body.answer === 'string' ? body.answer : String(body.answer ?? ''))
    case 'skipped':
      return { question: skipQuestion(id) }
    case 'pending':
      return { question: reopenQuestion(id) }
    default:
      throw createError({ statusCode: 400, statusMessage: 'status must be "answered", "skipped", or "pending"' })
  }
})
