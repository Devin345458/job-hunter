import type { QuestionChatResponse } from '#shared/types/question-chat'

// POST /api/questions/chat { questionId?, messages: [{ role, content }] }
// Behind the login like every /api route. The server builds the context (question, job, posting,
// knowledge base) from the database; only the question id and the conversation come from the client.
// Budget, credit, key, and refusal stops return { ok: false, message } for the panel to show.
export default defineEventHandler(async (event): Promise<QuestionChatResponse> => {
  const body = await readBody<{ questionId?: unknown; messages?: unknown }>(event)
  let questionId: number | null = null
  if (body?.questionId != null && body.questionId !== '') {
    const id = Number(body.questionId)
    if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: 'Invalid question ID' })
    questionId = id
  }
  const messages = cleanChatMessages(body?.messages)
  return await questionChatReply({ questionId, messages })
})
