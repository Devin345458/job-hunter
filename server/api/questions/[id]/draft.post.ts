import type { RecordsDraftPending, RecordsDraftRequest, RecordsDraftResponse } from '#shared/types/question-chat'

// POST /api/questions/:id/draft { said?: string[] }
// "Draft from my records": a first-person draft built live from Devin's knowledge base, his own
// GitHub commits, and his past Claude sessions, every sentence with its source. `said` is what he
// typed in the chat about this question. Nothing is saved here: the draft only fills the card's box.
// A press while a draft for this question runs joins it (startRecordsDraft). The request waits up to
// 80 seconds, under the 100 seconds the proxy in front of production allows; a draft still running
// then answers 202 { pending, status }, and the page polls GET /api/questions/:id/draft for it.
const WAIT_MS = 80_000

export default defineEventHandler(async (event): Promise<RecordsDraftResponse | RecordsDraftPending> => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: 'Invalid question ID' })
  const body = await readBody<RecordsDraftRequest | null>(event).catch(() => null)
  const { promise } = startRecordsDraft(id, cleanSaid(body?.said))
  const res = await waitForRecordsDraft(promise, WAIT_MS)
  if (res) return res
  setResponseStatus(event, 202)
  return { pending: true, status: recordsDraftStatus(id) }
})
