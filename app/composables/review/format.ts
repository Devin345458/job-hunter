import type { AnswerSource, ApplicationStatus, FormAnswer, PipelineRunView, ReviewItem } from '#shared/types/pipeline'
import { capitalize, plainKnowledgeRefs, plainQuestionRefs } from '#shared/utils/plain-text'
import { properName } from '#shared/utils/names'

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
  // Not in the review queue; shown on a card whose preparation was started again from it.
  preparing: { label: 'Preparing', color: 'info', icon: 'mdi-progress-clock', group: 'closed' },
}

/** Group names, the same on the review queue and the Applications page. */
export const GROUP_LABEL: Record<ReviewGroup, string> = {
  decide: 'To decide',
  attention: 'Needs you',
  sending: 'Sending',
  sent: 'Submitted',
  closed: 'Closed',
}

/** Every status in one review group, so other views count exactly what the review queue counts. */
export function statusesIn(group: ReviewGroup): ApplicationStatus[] {
  return (Object.entries(REVIEW_STATUS) as Array<[ApplicationStatus, StatusMeta]>).filter(([, m]) => m.group === group).map(([s]) => s)
}

export function statusMeta(status: ApplicationStatus): StatusMeta {
  return REVIEW_STATUS[status] ?? { label: status.replace(/_/g, ' '), color: 'secondary', icon: 'mdi-circle-small', group: 'closed' }
}

/** Preparation threw before anything was written (form_error starts with prepare_failed). */
export function prepareFailed(item: Pick<ReviewItem, 'status' | 'form'>): boolean {
  return item.status === 'needs_manual' && /^prepare_failed/.test(item.form.error ?? '')
}

/** The status a card shows: a needs_manual card whose preparation failed says so, not "Submit by hand". */
export function itemStatusMeta(item: Pick<ReviewItem, 'status' | 'form'>): StatusMeta {
  if (prepareFailed(item)) return { label: 'Preparation failed', color: 'error', icon: 'mdi-alert-octagon-outline', group: 'attention' }
  return statusMeta(item.status)
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

// ── Plain names for internal keys ────────────────────────────

/** "skill/Vue.js" or "profile:Full Name" (a knowledge base key) becomes "Vue.js" or "Full Name". */
export function knowledgeRef(ref: string | null | undefined): string {
  if (!ref) return ''
  return ref.replace(/^(?:profile|skill|skills|experience|preference|preferences|fact|facts|education|project|projects|certification|other)\s*[/:]\s*/i, '').trim()
}

/**
 * A knowledge base pointer in words: a bare key ("skill/PHP") reads as its name ("PHP"); a
 * sentence that cites keys ("initials of profile/Full Name (...)") reads with each in plain words.
 */
export function knowledgeSource(detail: string | null | undefined): string {
  const d = (detail ?? '').trim()
  const bare = knowledgeRef(d)
  return bare !== d && !/[/:]/.test(bare) ? bare : plainKnowledgeRefs(d)
}

const SOURCE_LABEL: Record<AnswerSource, string> = {
  knowledge: 'Knowledge base',
  resume: 'Resume',
  cover_letter: 'Cover letter',
  generated: 'Written by the pipeline',
  question: 'Your answer',
  eeo_decline: 'Self-identification',
  skipped: 'Left blank',
}

/** Where a form answer came from, in words: "Knowledge base: Full Name", "Your answer", "Left blank: Optional". */
export function answerSourceText(a: Pick<FormAnswer, 'source' | 'sourceDetail' | 'needsQuestionId' | 'value'>): string {
  const label = SOURCE_LABEL[a.source] ?? a.source
  const detail = (a.sourceDetail ?? '').trim()
  if (a.source === 'question') return a.needsQuestionId && !answerText(a.value) ? 'Asked you' : label
  if (a.source === 'knowledge') {
    if (!detail) return label
    const found = /^HOW FOUND(?: line)?:?\s*(.*)$/i.exec(detail)
    if (found) return `${label}: how you found the job${found[1] ? ` (${found[1]})` : ''}`
    return `${label}: ${knowledgeSource(detail)}`
  }
  if (a.source === 'skipped' || a.source === 'eeo_decline') return plainKnowledgeRefs(plainQuestionRefs(detail)) || label
  return detail ? `${label}: ${plainKnowledgeRefs(plainQuestionRefs(detail))}` : label
}

/** A form blocker without its internal key: "captcha: Google reCAPTCHA is..." becomes "Google reCAPTCHA is...". */
export function blockerText(b: string): string {
  return capitalize(b.replace(/^[a-z_]+:\s*/, '').trim())
}

/** "1 question", "4 questions". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`
}

/** A job source or ATS id as its product name. The map lives in shared/utils/names.ts so server text uses it too. */
export { properName }

// ── Pipeline runs ────────────────────────────────────────────

export type RunOutcome = NonNullable<PipelineRunView['outcome']>

export const OUTCOME: Record<RunOutcome, { label: string; color: string }> = {
  succeeded: { label: 'succeeded', color: 'success' },
  partial: { label: 'partly failed', color: 'warning' },
  failed: { label: 'failed', color: 'error' },
  running: { label: 'running', color: 'info' },
  skipped: { label: 'skipped', color: 'secondary' },
}

/** The outcome the server derived, or the raw status for a response without one. */
export function outcomeOf(r: PipelineRunView): RunOutcome {
  return r.outcome ?? (r.status as RunOutcome)
}

/** One line for a run's outcome: "succeeded", "38 failed, Claude is out of credit", "3 problems". */
export function outcomeText(r: PipelineRunView): string {
  const o = outcomeOf(r)
  if (o !== 'partial') return OUTCOME[o].label
  const p = r.problems ?? []
  return p.length === 1 ? p[0]! : `${p.length} problems`
}

const STAT_LABEL: Record<string, string> = {
  pending: 'waiting',
  scored: 'scored',
  reusedSkills: 'skill scores reused',
  noText: 'without posting text',
  failed: 'failed',
  rescored: 'rescored',
  costUsd: 'AI cost',
  enriched: 'read',
  selected: 'picked',
  closed: 'closed',
  noPostingText: 'without posting text',
  applyUrlFound: 'apply links found',
  compStated: 'with pay stated',
  configs: 'searches',
  found: 'found',
  new: 'new',
  decisionsUsed: 'decisions used',
  decisionsSkipped: 'decisions skipped',
  rules: 'rules',
  activeRules: 'active rules',
  ruleChanges: 'rule changes',
  notesMapped: 'notes read',
  noteErrors: 'notes not read',
  questionsAsked: 'questions asked',
  threshold: 'match threshold',
  retried: 'retried',
  picked: 'picked',
  proposed: 'ready to decide',
  needsInput: 'waiting on you',
  needsManual: 'submit by hand',
  refreshed: 'refreshed',
  unblocked: 'unblocked',
  candidates: 'candidates',
  analyzed: 'analyzed',
  recommended: 'recommended',
  built: 'built',
  skipped: 'skipped',
  interrupted: 'interrupted',
  pruned: 'old rows removed',
}

const STAT_HIDDEN = new Set(['tz', 'local', 'outcome', 'stopReason'])

/** A run's numbers as "38 failed, 22 without posting text, AI cost $0.00". Booleans, lists, and nested detail are left out. */
export function statsText(stats: Record<string, unknown> | null): string {
  if (!stats) return ''
  return Object.entries(stats)
    .filter(([k, v]) => !STAT_HIDDEN.has(k) && (typeof v === 'number' || (Array.isArray(v) && v.every(x => typeof x === 'number'))))
    .map(([k, v]) => {
      const n = Array.isArray(v) ? v.length : (v as number)
      const label = STAT_LABEL[k] ?? k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase()
      return k === 'costUsd' ? `${label} $${n.toFixed(2)}` : `${n} ${label}`
    })
    .join(', ')
}
