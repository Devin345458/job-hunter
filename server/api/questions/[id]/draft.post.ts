import type { RecordsDraftRequest, RecordsDraftResponse } from '#shared/types/question-chat'

// POST /api/questions/:id/draft { said?: string[] }
// "Draft from my records": a first-person draft built live from Devin's knowledge base, his own
// GitHub commits, and his past Claude sessions, every sentence with its source. `said` is what he
// typed in the chat about this question. Nothing is saved here: the draft only fills the card's box.
export default defineEventHandler(async (event): Promise<RecordsDraftResponse> => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: 'Invalid question ID' })
  const body = await readBody<RecordsDraftRequest | null>(event).catch(() => null)
  return await draftFromRecords(id, cleanSaid(body?.said))
})
