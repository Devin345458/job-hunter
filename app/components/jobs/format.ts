// Number and label formatting shared by the job components.
import { APP_STATE_LABEL, PREPARE_FAILED_LABEL } from '#shared/utils/app-state'
import { payAmount, payRange } from '#shared/utils/pay-format'

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

// Pay prints through shared/utils/pay-format.ts, the same form on every screen.
export function formatMoney(value: number | null | undefined, currency: string | null = 'USD'): string {
  return payAmount(value, currency)
}

export function formatMoneyShort(value: number | null | undefined): string {
  return payAmount(value)
}

export function formatRange(min: number | null | undefined, max: number | null | undefined, currency: string | null = 'USD'): string {
  return payRange(min, max, currency)
}

/** The match score has one hue on every screen (theme color `score`); a missing score is gray. */
export function scoreColor(score: number | null | undefined): string {
  return score == null ? 'grey' : 'score'
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
const L = APP_STATE_LABEL
const APP_STATUS: Record<string, JobStateMeta> = {
  to_decide: { label: L.to_decide!, color: 'primary' },
  preparing: { label: L.preparing!, color: 'info' },
  needs_input: { label: L.needs_input!, color: 'warning' },
  proposed: { label: L.proposed!, color: 'primary' },
  approved: { label: L.approved!, color: 'primary' },
  publishing: { label: L.publishing!, color: 'primary' },
  submitting: { label: L.submitting!, color: 'primary' },
  submitted: { label: L.submitted!, color: 'success' },
  submit_failed: { label: L.submit_failed!, color: 'error' },
  needs_manual: { label: L.needs_manual!, color: 'warning' },
  declined: { label: L.declined!, color: 'secondary' },
  response_received: { label: L.response_received!, color: 'success' },
  interviewing: { label: L.interviewing!, color: 'success' },
  offer: { label: L.offer!, color: 'success' },
  rejected: { label: L.rejected!, color: 'error' },
  no_response: { label: L.no_response!, color: 'secondary' },
  draft: { label: L.draft!, color: 'secondary' },
  ready: { label: L.ready!, color: 'secondary' },
}

/** What a job card and the job page say about where the job stands: its application's state when it has one, else its own status. */
export function jobStateMeta(status: string | null | undefined, application: { status: string; prepareFailed?: boolean } | null | undefined): JobStateMeta {
  if (application) {
    if (application.status === 'needs_manual' && application.prepareFailed) return { label: PREPARE_FAILED_LABEL, color: 'error' }
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
