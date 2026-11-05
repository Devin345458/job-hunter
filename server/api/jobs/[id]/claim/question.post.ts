import type { QuestionView } from '#shared/types/pipeline'

// POST /api/jobs/:id/claim/question { text, source, applicationId? }
// The question "Ask about this" chats about: the existing one on the subject, or a new pending one
// tied to this job and application. Sandbox jobs answer 409: they never create questions.
export default defineEventHandler(async (event): Promise<QuestionView> => {
  const id = Number(getRouterParam(event, 'id'))
  const body = await readBody<{ text?: unknown; source?: unknown; applicationId?: unknown }>(event)
  const applicationId = body?.applicationId != null ? Number(body.applicationId) : null
  const ctx = skillClaimContext(id, body?.text, body?.source, Number.isInteger(applicationId) ? applicationId : null)
  return toQuestionView(await ensureSkillClaimQuestion(ctx))
})
