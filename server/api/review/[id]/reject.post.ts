import { eq } from 'drizzle-orm'
import { jobs } from '~~/server/db/schema'
import { REJECT_REASONS } from '#shared/types/pipeline'
import { applyRejectSkillKnowledge, resolveRejectSkills } from '~~/server/utils/reject-skills'

const CODES = new Set<string>(REJECT_REASONS.map(r => r.code))

// Reject never submits anything. It records the reason for learning. It works at stage 1 (Decide,
// before anything is written) and at stage 2 (Send, after Apply prepared the application).
// Body: { reasonCode, reasonText?, skills?, skillsMode? }. skills (Wrong tech stack only) names the
// skills at fault; skillsMode 'lack' also writes them to the knowledge base as a No, 'avoid' does not.
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  const item = Number.isInteger(id) ? getReviewItem(id) : null
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Application not found' })
  if (!['to_decide', 'proposed', 'needs_input', 'submit_failed', 'needs_manual'].includes(item.status)) {
    throw createError({ statusCode: 409, statusMessage: `This application is ${item.status} and can no longer be rejected` })
  }
  const body = await readBody<{ reasonCode?: string; reasonText?: string; skills?: unknown; skillsMode?: unknown }>(event)
  const reasonCode = body?.reasonCode && CODES.has(body.reasonCode) ? body.reasonCode : null
  if (!reasonCode) throw createError({ statusCode: 400, statusMessage: 'Pick a reason' })
  const reasonText = typeof body?.reasonText === 'string' && body.reasonText.trim() ? body.reasonText.trim().slice(0, 2000) : null
  if (reasonCode === 'other' && !reasonText) throw createError({ statusCode: 400, statusMessage: 'Say what the reason is' })
  const job = useDb().select().from(jobs).where(eq(jobs.id, item.job.id)).get()!
  const rejectSkills = resolveRejectSkills(job, reasonCode, body?.skills, body?.skillsMode)

  const decision = recordDecision(id, 'reject', reasonCode, reasonText, rejectSkills ? { rejectSkills } : {})
  setApplicationStatus(id, 'declined', `Rejected: ${REJECT_REASONS.find(r => r.code === reasonCode)!.label}`, { decidedAt: nowSql() })
  useDb().update(jobs).set({ status: 'rejected' }).where(eq(jobs.id, item.job.id)).run()
  await onDecision(decision.id).catch(e => console.error('[learning] onDecision failed', e))
  // After the rules update, so the rescores the question answers trigger use them.
  // Sandbox cards are test data: they make sandbox rules only and never touch the knowledge base.
  if (rejectSkills?.mode === 'lack' && !item.isSandbox) {
    await applyRejectSkillKnowledge(decision.id, rejectSkills, job).catch(e => console.error('[reject-skills] knowledge step failed', e))
  }
  return getReviewItem(id)
})
