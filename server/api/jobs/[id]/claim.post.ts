import type { SkillClaimRequest, SkillClaimResult } from '#shared/types/pipeline'

// POST /api/jobs/:id/claim { text, source, applicationId?, answer, example? }
// Devin's answer from the skill panel. It finds or creates the knows or has_done question on the
// subject and answers it with answerQuestion(), the same path as /questions, then sets the job's
// requirement statuses from the answer. Sandbox jobs write nothing ({ written: false }).
// The fresh skills score is a separate call (POST /api/jobs/:id/rescore) so the panel can show it running.
export default defineEventHandler(async (event): Promise<SkillClaimResult> => {
  const id = Number(getRouterParam(event, 'id'))
  const body = await readBody<Partial<SkillClaimRequest>>(event)
  const applicationId = body?.applicationId != null ? Number(body.applicationId) : null
  const ctx = skillClaimContext(id, body?.text, body?.source, Number.isInteger(applicationId) ? applicationId : null)
  return await saveSkillClaim(ctx, body?.answer, body && 'example' in body ? body.example : undefined)
})
