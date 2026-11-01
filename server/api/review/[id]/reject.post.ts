import { eq } from 'drizzle-orm'
import { jobs } from '~~/server/db/schema'
import { REJECT_REASONS } from '#shared/types/pipeline'

const CODES = new Set<string>(REJECT_REASONS.map(r => r.code))

// Reject never submits anything. It records the reason for learning.
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  const item = Number.isInteger(id) ? getReviewItem(id) : null
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Application not found' })
  if (!['proposed', 'needs_input', 'submit_failed', 'needs_manual'].includes(item.status)) {
    throw createError({ statusCode: 409, statusMessage: `This application is ${item.status} and can no longer be rejected` })
  }
  const body = await readBody<{ reasonCode?: string; reasonText?: string }>(event)
  const reasonCode = body?.reasonCode && CODES.has(body.reasonCode) ? body.reasonCode : null
  if (!reasonCode) throw createError({ statusCode: 400, statusMessage: 'Pick a reason' })
  const reasonText = typeof body?.reasonText === 'string' && body.reasonText.trim() ? body.reasonText.trim().slice(0, 2000) : null
  if (reasonCode === 'other' && !reasonText) throw createError({ statusCode: 400, statusMessage: 'Say what the reason is' })

  const decision = recordDecision(id, 'reject', reasonCode, reasonText)
  setApplicationStatus(id, 'declined', `Rejected: ${REJECT_REASONS.find(r => r.code === reasonCode)!.label}`, { decidedAt: nowSql() })
  useDb().update(jobs).set({ status: 'rejected' }).where(eq(jobs.id, item.job.id)).run()
  await onDecision(decision.id).catch(e => console.error('[learning] onDecision failed', e))
  return getReviewItem(id)
})
