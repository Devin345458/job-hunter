// Number and label formatting shared by the job components.

/**
 * A job's stored tags (a JSON array) with repeats removed, case and spacing ignored, first
 * spelling kept. Some boards list a category twice ("Software Engineering", "software engineering").
 */
export function uniqueTags(raw: string | null | undefined): string[] {
  if (!raw) return []
  let list: unknown
  try {
    list = JSON.parse(raw)
  }
  catch {
    return []
  }
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of list) {
    if (typeof t !== 'string') continue
    const tag = t.trim().replace(/\s+/g, ' ')
    const key = tag.toLowerCase()
    if (!tag || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

export function formatMoney(value: number | null | undefined, currency: string | null = 'USD'): string {
  if (value == null) return ''
  const n = Math.round(value).toLocaleString('en-US')
  return !currency || /USD/i.test(currency) ? `$${n}` : `${n} ${currency}`
}

export function formatMoneyShort(value: number | null | undefined): string {
  if (value == null) return ''
  return value >= 1000 ? `$${Math.round(value / 1000)}K` : `$${Math.round(value)}`
}

export function formatRange(min: number | null | undefined, max: number | null | undefined, currency: string | null = 'USD'): string {
  if (min != null && max != null && min !== max) return `${formatMoney(min, currency)} to ${formatMoney(max, currency)}`
  if (min != null || max != null) return formatMoney(min ?? max, currency)
  return ''
}

export function scoreColor(score: number | null | undefined): string {
  if (score == null) return 'grey'
  if (score >= 80) return 'success'
  if (score >= 60) return 'warning'
  return 'error'
}

export const RECOMMENDATION_LABELS: Record<string, string> = {
  strong_match: 'Strong match',
  good_match: 'Good match',
  partial_match: 'Partial match',
  weak_match: 'Weak match',
}

export const ATS_LABELS: Record<string, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workable: 'Workable',
  smartrecruiters: 'SmartRecruiters',
  recruitee: 'Recruitee',
  bamboohr: 'BambooHR',
  jobvite: 'Jobvite',
  workday: 'Workday',
  icims: 'iCIMS',
  taleo: 'Taleo',
  successfactors: 'SuccessFactors',
  sandbox: 'Sandbox',
  other: 'Employer site',
  unknown: 'Unknown',
}

// ── Where a job stands ───────────────────────────────────────

export interface JobStateMeta {
  label: string
  color: string
}

const JOB_STATUS: Record<string, JobStateMeta> = {
  new: { label: 'New', color: 'info' },
  reviewed: { label: 'Reviewed', color: 'primary' },
  applied: { label: 'Applied', color: 'success' },
  rejected: { label: 'Rejected', color: 'secondary' },
  expired: { label: 'Expired', color: 'grey' },
}

// The application's status says more than the job's: a job stays "new" while its application
// waits on the review queue. Labels match the Applications page where they overlap.
const APP_STATUS: Record<string, JobStateMeta> = {
  preparing: { label: 'Preparing', color: 'info' },
  needs_input: { label: 'Needs your answer', color: 'warning' },
  proposed: { label: 'In review', color: 'primary' },
  approved: { label: 'Submitting', color: 'primary' },
  publishing: { label: 'Submitting', color: 'primary' },
  submitting: { label: 'Submitting', color: 'primary' },
  submitted: { label: 'Applied', color: 'success' },
  submit_failed: { label: 'Submit failed', color: 'error' },
  needs_manual: { label: 'Submit by hand', color: 'warning' },
  declined: { label: 'Rejected', color: 'secondary' },
  response_received: { label: 'Heard back', color: 'success' },
  interviewing: { label: 'Interviewing', color: 'success' },
  offer: { label: 'Offer', color: 'success' },
  rejected: { label: 'Rejected by employer', color: 'error' },
  no_response: { label: 'No response', color: 'secondary' },
  draft: { label: 'Draft', color: 'secondary' },
  ready: { label: 'Ready', color: 'secondary' },
}

/** What a job card and the job page say about where the job stands: its application's state when it has one, else its own status. */
export function jobStateMeta(status: string | null | undefined, application: { status: string; prepareFailed?: boolean } | null | undefined): JobStateMeta {
  if (application) {
    if (application.status === 'needs_manual' && application.prepareFailed) return { label: 'Preparation failed', color: 'error' }
    const meta = APP_STATUS[application.status]
    if (meta) return meta
  }
  const s = status ?? ''
  return JOB_STATUS[s] ?? { label: s ? s.charAt(0).toUpperCase() + s.slice(1) : 'New', color: 'grey' }
}

/** A grouped card's locations, each once: "New York, NY" for two postings in the same city. */
export function postingLocations(postings: Array<{ location: string | null }>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of postings) {
    const loc = (p.location ?? '').trim()
    if (!loc || seen.has(loc.toLowerCase())) continue
    seen.add(loc.toLowerCase())
    out.push(loc)
  }
  return out
}
