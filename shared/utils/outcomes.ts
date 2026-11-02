import type { ApplicationStatus, OutcomeStatus } from '../types/pipeline'

// What happened after an application went out, shared by the PATCH route, the outcome control,
// the Applications list, and the Learning rates. Pipeline statuses are set only by their own code.

export interface OutcomeMeta {
  status: OutcomeStatus
  /** The button and history wording. */
  label: string
  /** The Applications filter chip. */
  filterLabel: string
  color: string
  icon: string
}

export const OUTCOMES: readonly OutcomeMeta[] = [
  { status: 'response_received', label: 'Heard back', filterLabel: 'Heard back', color: 'success', icon: 'mdi-email-open-outline' },
  { status: 'interviewing', label: 'Interviewing', filterLabel: 'Interviewing', color: 'success', icon: 'mdi-account-voice' },
  { status: 'rejected', label: 'Rejected by employer', filterLabel: 'Rejected by employer', color: 'error', icon: 'mdi-close-circle-outline' },
  { status: 'offer', label: 'Offer', filterLabel: 'Offers', color: 'success', icon: 'mdi-trophy-outline' },
  { status: 'no_response', label: 'No response', filterLabel: 'No response', color: 'secondary', icon: 'mdi-email-off-outline' },
]

export const OUTCOME_STATUSES: readonly OutcomeStatus[] = OUTCOMES.map(o => o.status)

/** Every status of an application that went out: submitted, then any employer outcome. */
export const SENT_STATUSES: readonly ApplicationStatus[] = ['submitted', ...OUTCOME_STATUSES]

/** The employer replied in some way. A rejection counts; no response does not. */
export const HEARD_BACK_STATUSES: readonly OutcomeStatus[] = ['response_received', 'interviewing', 'rejected', 'offer']

/** Statuses "I submitted it" moves from: approved and waiting for a submit by hand. */
export const HAND_SUBMIT_FROM: readonly ApplicationStatus[] = ['approved', 'needs_manual']

export function isOutcome(status: string | null | undefined): status is OutcomeStatus {
  return OUTCOME_STATUSES.includes(status as OutcomeStatus)
}

export function outcomeMeta(status: string | null | undefined): OutcomeMeta | null {
  return OUTCOMES.find(o => o.status === status) ?? null
}

/** The label of a history line: an outcome, or "I submitted it". */
export function outcomeLabel(status: string): string {
  return status === 'submitted' ? 'Submitted by hand' : outcomeMeta(status)?.label ?? status.replace(/_/g, ' ')
}

/**
 * Why PATCH refuses a status change, or null when it is allowed: an employer outcome from submitted
 * or another outcome (the same one again adds a line, say a second interview), or submitted from
 * approved or needs_manual ("I submitted it").
 */
export function statusChangeRefusal(from: string, to: string): string | null {
  if (isOutcome(to)) {
    return from === 'submitted' || isOutcome(from)
      ? null
      : `An employer outcome can only be recorded once the application is submitted (this one is ${from.replace(/_/g, ' ')})`
  }
  if (to === 'submitted') {
    return HAND_SUBMIT_FROM.includes(from as ApplicationStatus)
      ? null
      : `Only an approved application waiting for a submit by hand can be marked submitted (this one is ${from.replace(/_/g, ' ')})`
  }
  return `Status ${to.replace(/_/g, ' ')} is set by the pipeline, not by hand. Here you can record an employer outcome or that you submitted it.`
}

// ── Dates: an outcome's day is stored as YYYY-MM-DD and never goes through a time zone ──

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** Today on this device, as YYYY-MM-DD (not the UTC date). */
export function localToday(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

export function isValidDay(day: string | null | undefined): day is string {
  const m = DAY.exec(day ?? '')
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

/** "Nov 2", or "Nov 2, 2025" outside the current year. */
export function formatDay(day: string | null | undefined): string {
  const m = DAY.exec(day ?? '')
  if (!m) return ''
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}
