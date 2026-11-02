// PATCH /api/questions/:id
//   { status: 'answered', answer, example? }  writes the knowledge base, refreshes waiting applications, rescores.
//                                             example: Devin's example for a Yes or Some experience answer to a
//                                             skill or experience question (text sets it, null clears it, absent
//                                             keeps the saved one). A yes or no answer may instead carry it on
//                                             the lines after the answer ("Yes\n<example>"), which is how the
//                                             review card sends it.
//   { example }                               adds or changes the example on an answered Yes or Some experience question
//   { status: 'skipped' }                     skips for now
//   { status: 'pending' }                     reopens a skipped question
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: 'Invalid question ID' })
  const body = await readBody<{ status?: string; answer?: unknown; example?: unknown }>(event)
  let example: string | null | undefined
  if (body && 'example' in body && body.example !== undefined) {
    if (body.example !== null && typeof body.example !== 'string') throw createError({ statusCode: 400, statusMessage: 'The example must be text' })
    example = body.example
  }
  if (!body?.status && example !== undefined) return await setQuestionExample(id, example ?? '')
  switch (body?.status) {
    case 'answered':
      return await answerQuestion(id, typeof body.answer === 'string' ? body.answer : String(body.answer ?? ''), example)
    case 'skipped':
      return { question: skipQuestion(id) }
    case 'pending':
      return { question: reopenQuestion(id) }
    default:
      throw createError({ statusCode: 400, statusMessage: 'status must be "answered", "skipped", or "pending"' })
  }
})
