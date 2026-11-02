import type { SkillClaimPreview } from '#shared/types/pipeline'

// GET /api/jobs/:id/claim?text=&source=missing|requirement&applicationId=
// What the skill panel shows before Devin answers: the plain name, why it shows as missing, the
// question the answer goes to, and the knowledge base entry on it today. Reads only.
export default defineEventHandler((event): SkillClaimPreview => {
  const id = Number(getRouterParam(event, 'id'))
  const query = getQuery(event)
  const applicationId = query.applicationId ? Number(query.applicationId) : null
  const ctx = skillClaimContext(id, query.text, query.source, Number.isInteger(applicationId) ? applicationId : null)
  return skillClaimPreview(ctx)
})
