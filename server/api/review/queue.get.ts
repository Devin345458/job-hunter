import type { ApplicationStatus } from '#shared/types/pipeline'

const DEFAULT: ApplicationStatus[] = ['to_decide', 'proposed', 'needs_input']
const ALLOWED = new Set<ApplicationStatus>(['to_decide', 'preparing', 'needs_input', 'proposed', 'approved', 'publishing', 'submitting', 'submitted', 'submit_failed', 'needs_manual', 'declined'])

// GET /api/review/queue?status=to_decide,proposed,needs_input
//   &ids=82,91   only these applications (the cards an answered question was on, read again)
export default defineEventHandler((event) => {
  const query = getQuery(event)
  const raw = String(query.status || '')
  const statuses = raw
    ? raw.split(',').filter((s): s is ApplicationStatus => ALLOWED.has(s as ApplicationStatus))
    : DEFAULT
  const ids = query.ids === undefined
    ? undefined
    : [...new Set(String(query.ids).split(',').map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 500)
  return { items: listReviewItems(statuses.length ? statuses : DEFAULT, ids) }
})
