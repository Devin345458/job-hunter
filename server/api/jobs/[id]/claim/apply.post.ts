import type { SkillClaimApplyRequest, SkillClaimResult } from '#shared/types/pipeline'

// POST /api/jobs/:id/claim/apply { text, source, applicationId? }
// "Use my answer" in the skill panel: the knowledge base (or an answered question) already answers
// this skill, but the job was scored before that answer. Applies the answer to this job's
// requirement statuses and to the other open jobs that name the skill, without asking again and
// without writing the knowledge base. The fresh skills score is a separate call (POST /api/jobs/:id/rescore).
export default defineEventHandler(async (event): Promise<SkillClaimResult> => {
  const id = Number(getRouterParam(event, 'id'))
  const body = await readBody<Partial<SkillClaimApplyRequest>>(event)
  const applicationId = body?.applicationId != null ? Number(body.applicationId) : null
  const ctx = skillClaimContext(id, body?.text, body?.source, Number.isInteger(applicationId) ? applicationId : null)
  return applyKnownSkillClaim(ctx)
})
