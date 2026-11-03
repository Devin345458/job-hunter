import type { ApplicationStatus } from '#shared/types/pipeline'

const DEFAULT: ApplicationStatus[] = ['to_decide', 'proposed', 'needs_input']
const ALLOWED = new Set<ApplicationStatus>(['to_decide', 'preparing', 'needs_input', 'proposed', 'approved', 'publishing', 'submitting', 'submitted', 'submit_failed', 'needs_manual', 'declined'])

// GET /api/review/queue?status=to_decide,proposed,needs_input
export default defineEventHandler((event) => {
  const raw = String(getQuery(event).status || '')
  const statuses = raw
    ? raw.split(',').filter((s): s is ApplicationStatus => ALLOWED.has(s as ApplicationStatus))
    : DEFAULT
  return { items: listReviewItems(statuses.length ? statuses : DEFAULT) }
})
