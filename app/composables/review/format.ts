import type { ApplicationStatus } from '#shared/types/pipeline'

// Status vocabulary and formatting shared by every review component. Lives in a nested folder
// so Nuxt does not auto-import these generic names app-wide; import them explicitly.

// ── Status vocabulary shared by every review component ──────

export type ReviewGroup = 'decide' | 'attention' | 'sending' | 'sent' | 'closed'

export interface StatusMeta {
  label: string
  color: string
  icon: string
  group: ReviewGroup
}

export const REVIEW_STATUS: Partial<Record<ApplicationStatus, StatusMeta>> = {
  proposed: { label: 'Ready to decide', color: 'primary', icon: 'mdi-inbox-arrow-down-outline', group: 'decide' },
  needs_input: { label: 'Needs your answer', color: 'warning', icon: 'mdi-comment-question-outline', group: 'decide' },
  approved: { label: 'Approved', color: 'primary', icon: 'mdi-check', group: 'sending' },
  publishing: { label: 'Publishing demo', color: 'primary', icon: 'mdi-source-branch', group: 'sending' },
  submitting: { label: 'Submitting', color: 'primary', icon: 'mdi-send-outline', group: 'sending' },
  submitted: { label: 'Submitted', color: 'success', icon: 'mdi-check-circle-outline', group: 'sent' },
  submit_failed: { label: 'Submit failed', color: 'error', icon: 'mdi-alert-octagon-outline', group: 'attention' },
  needs_manual: { label: 'Submit by hand', color: 'warning', icon: 'mdi-hand-pointing-right', group: 'attention' },
  declined: { label: 'Rejected', color: 'secondary', icon: 'mdi-close', group: 'closed' },
}

export function statusMeta(status: ApplicationStatus): StatusMeta {
  return REVIEW_STATUS[status] ?? { label: status.replace(/_/g, ' '), color: 'secondary', icon: 'mdi-circle-small', group: 'closed' }
}

/** States the server is still working through after approve. The dashboard polls these. */
export const IN_FLIGHT: ApplicationStatus[] = ['approved', 'publishing', 'submitting']
export const CAN_APPROVE: ApplicationStatus[] = ['proposed', 'submit_failed']
export const CAN_REJECT: ApplicationStatus[] = ['proposed', 'needs_input', 'submit_failed', 'needs_manual']

// ── Formatting ───────────────────────────────────────────────

/** SQLite timestamps ("2026-11-01 14:02:00", UTC) and ISO strings both parse. */
export function parseTime(value: string | null | undefined): Date | null {
  if (!value) return null
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

export function timeAgo(value: string | null | undefined): string {
  const d = parseTime(value)
  if (!d) return ''
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function clockTime(value: string | null | undefined): string {
  const d = parseTime(value)
  if (!d) return ''
  const sameDay = d.toDateString() === new Date().toDateString()
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return sameDay ? `today ${time}` : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`
}

export function money(n: number | null | undefined, currency = 'USD'): string {
  if (n === null || n === undefined) return ''
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : `${currency} `
  if (Math.abs(n) >= 10000) return `${symbol}${Math.round(n / 1000)}k`
  return `${symbol}${Math.round(n).toLocaleString('en-US')}`
}

export function moneyRange(min: number | null | undefined, max: number | null | undefined, currency = 'USD'): string {
  if (min == null && max == null) return ''
  if (min != null && max != null && min !== max) return `${money(min, currency)} to ${money(max, currency)}`
  return money(min ?? max, currency)
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).host.replace(/^www\./, '')
  }
  catch {
    return url
  }
}

export function answerText(value: string | string[] | boolean | null): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return value
}
