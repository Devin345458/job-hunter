import type { RecordsDraftStatus } from '#shared/types/question-chat'

// GET /api/questions/:id/draft: the records draft running for this question (its step, for the line
// under the spinner) or the one that finished in the last few minutes (its result). Reads memory
// only; starts nothing.
export default defineEventHandler((event): RecordsDraftStatus => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: 'Invalid question ID' })
  return recordsDraftStatus(id)
})
