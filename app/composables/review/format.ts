import type { AnswerSource, ApplicationStatus, FormAnswer, PipelineRunView, ReviewItem } from '#shared/types/pipeline'
import { capitalize, plainKnowledgeRefs, plainQuestionRefs } from '#shared/utils/plain-text'
import { properName } from '#shared/utils/names'
import { APP_STATE_LABEL } from '#shared/utils/app-state'
import { payAmount, payRange } from '#shared/utils/pay-format'

// Status vocabulary and formatting shared by every review component. Lives in a nested folder
// so Nuxt does not auto-import these generic names app-wide; import them explicitly.

// ── Status vocabulary shared by every review component ──────

/**
 * decide: stage 1, Apply or Reject before anything is written. preparing: Apply was tapped and the
 * resume, letter, and form are being written. send: stage 2, prepared, Approve or Reject.
 */
export type ReviewGroup = 'decide' | 'preparing' | 'send' | 'attention' | 'sending' | 'sent' | 'closed'

export interface StatusMeta {
  label: string
  color: string
  icon: string
  group: ReviewGroup
}

// Labels come from shared/utils/app-state.ts: one name per state on every screen. Colors are the
// pale pairs: primary and info read neutral in this theme, warning marks what blocks an approval.
const L = APP_STATE_LABEL
export const REVIEW_STATUS: Partial<Record<ApplicationStatus, StatusMeta>> = {
  to_decide: { label: L.to_decide!, color: 'primary', icon: 'mdi-help-rhombus-outline', group: 'decide' },
  preparing: { label: L.preparing!, color: 'info', icon: 'mdi-progress-clock', group: 'preparing' },
  proposed: { label: L.proposed!, color: 'primary', icon: 'mdi-inbox-arrow-down-outline', group: 'send' },
  needs_input: { label: L.needs_input!, color: 'warning', icon: 'mdi-comment-question-outline', group: 'send' },
  approved: { label: L.approved!, color: 'primary', icon: 'mdi-check', group: 'sending' },
  publishing: { label: L.publishing!, color: 'primary', icon: 'mdi-source-branch', group: 'sending' },
  submitting: { label: L.submitting!, color: 'primary', icon: 'mdi-send-outline', group: 'sending' },
  submitted: { label: L.submitted!, color: 'success', icon: 'mdi-check-circle-outline', group: 'sent' },
  submit_failed: { label: L.submit_failed!, color: 'error', icon: 'mdi-alert-octagon-outline', group: 'attention' },
  needs_manual: { label: L.needs_manual!, color: 'warning', icon: 'mdi-hand-pointing-right', group: 'attention' },
  declined: { label: L.declined!, color: 'secondary', icon: 'mdi-close', group: 'closed' },
}

/**
 * Group names on the review queue. The Applications page reuses them, except that it splits the
 * send group into Ready to send (the state's own name) and Needs you.
 */
export const GROUP_LABEL: Record<ReviewGroup, string> = {
  decide: 'To decide',
  preparing: 'Preparing',
  // Ready to send plus the prepared ones waiting on an answer; "Ready to send" is the state's own name.
  send: 'To send',
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

/**
 * Question ids the employer form's fields wait on: a field's needsQuestionId, or an optional field
 * asked without blocking ("Optional: asked you as question #12"). The card's other open questions
 * come from the gap plan (skills and experience to confirm).
 */
export function formQuestionIds(item: Pick<ReviewItem, 'form'>): Set<number> {
  const ids = new Set<number>()
  for (const a of item.form.answers) {
    if (typeof a.needsQuestionId === 'number') ids.add(a.needsQuestionId)
    const m = /^Optional: asked you as question #(\d+)/.exec(a.sourceDetail ?? '')
    if (m) ids.add(Number(m[1]))
  }
  return ids
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
/** Being prepared after Apply (or Prepare again). The review queue polls these until they are ready to send. */
export const PREPARING: ApplicationStatus[] = ['preparing']
/** Stage 1: Apply queues the preparation. Approve is never offered here. */
export const CAN_APPLY: ApplicationStatus[] = ['to_decide']
export const CAN_APPROVE: ApplicationStatus[] = ['proposed', 'submit_failed']
export const CAN_REJECT: ApplicationStatus[] = ['to_decide', 'proposed', 'needs_input', 'submit_failed', 'needs_manual']

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

/** Pay figures print through shared/utils/pay-format.ts so every screen says them the same way. */
export function money(n: number | null | undefined, currency = 'USD'): string {
  return payAmount(n, currency)
}

export function moneyRange(min: number | null | undefined, max: number | null | undefined, currency = 'USD'): string {
  return payRange(min, max, currency)
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
  return ref.replace(/^(?:profile|skill|skills|experience|preference|preferences|fact|facts|education|project|projects|certification|other)\s*[/:]\s*/i, '')
    // An answered experience question's key: "experience/Has done: Failure handling" is Failure handling.
    .replace(/^has done:\s*/i, '')
    .trim()
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
  partial: { label: 'partly failed', color: 'secondary' },
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
  // A run the job queue carried on after the server restarted mid-run says so.
  const resumed = r.stats?.resumedAfterRestart ? ', resumed after a restart' : ''
  if (o !== 'partial') return `${OUTCOME[o].label}${resumed}`
  const p = r.problems ?? []
  return `${p.length === 1 ? p[0]! : `${p.length} problems`}${resumed}`
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

const STAT_HIDDEN = new Set(['tz', 'local', 'outcome', 'stopReason', 'pausedUntil', 'resumedAfterRestart'])

export interface RunDemo { id: number; name: string; state: string }

/**
 * The demos a run built or previewed, by name, with how each ended: "Invoice Three Way Matcher",
 * "built" or "preview failed". Runs recorded before titles were kept show the demo's slug.
 */
export function runDemos(stats: Record<string, unknown> | null): RunDemo[] {
  const raw = stats?.demos
  const list = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : []
  return list.filter(d => typeof d?.id === 'number').map((d) => {
    const preview = typeof d.preview === 'string' ? d.preview : null
    const state = preview
      ? (preview === 'none' ? 'no preview' : `preview ${preview}`)
      : typeof d.status === 'string' ? d.status : ''
    return { id: d.id as number, name: String(d.title || d.slug || `Demo ${d.id}`), state }
  })
}

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
