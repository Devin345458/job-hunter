// Wording for the Claude subscription pause (server/utils/subscription-pause.ts), shared so the
// server's messages and the dashboard read the same.

/**
 * When a pause ends, as a clock time ("6:34 PM"), with the weekday when it is not today
 * ("Tue 6:34 PM"). `timeZone` is the server's for stored messages; the browser passes none.
 */
export function resumeClock(until: string | Date, opts: { now?: Date; timeZone?: string } = {}): string {
  const at = typeof until === 'string' ? new Date(until) : until
  const now = opts.now ?? new Date()
  const tz = opts.timeZone ? { timeZone: opts.timeZone } : {}
  const day = (d: Date) => new Intl.DateTimeFormat('en-US', { ...tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  const clock = new Intl.DateTimeFormat('en-US', { ...tz, hour: 'numeric', minute: '2-digit' }).format(at)
  if (day(at) === day(now)) return clock
  const weekday = new Intl.DateTimeFormat('en-US', { ...tz, weekday: 'short' }).format(at)
  return `${weekday} ${clock}`
}

/** The amber line on the Review and Settings run boxes while the subscription limit holds. */
export function subscriptionPauseText(until: string | Date, opts: { now?: Date; timeZone?: string } = {}): string {
  return `Paused: your Claude subscription limit is reached, resumes at ${resumeClock(until, opts)}`
}

// ── This app's own limit on the subscription (server/utils/subscription-budget.ts) ──

/**
 * Which of this app's limits stops Claude calls on Devin's subscription: the daily limit, the
 * background share of it (only scheduled steps and per-job read and score items stop), or the
 * rolling 7-day limit. Also the run's stopReason (shared/utils/run-outcome.ts).
 */
export type AppLimitKind = 'app_daily' | 'app_background' | 'app_week'

export const APP_LIMIT_KINDS: readonly AppLimitKind[] = ['app_daily', 'app_background', 'app_week']

export function isAppLimitKind(v: unknown): v is AppLimitKind {
  return typeof v === 'string' && (APP_LIMIT_KINDS as readonly string[]).includes(v)
}

/**
 * The amber line on the Review and Settings boxes, and the note on queue items it put back:
 * "Paused: this app's daily Claude limit is reached, resumes at midnight". `sharePct` is the
 * background share in percent (70).
 */
export function appLimitPauseText(kind: AppLimitKind, until: string | Date, opts: { now?: Date; timeZone?: string; sharePct?: number } = {}): string {
  if (kind === 'app_week') return `Paused: this app's 7-day Claude limit is reached, resumes at ${resumeClock(until, opts)}`
  if (kind === 'app_background') return `Paused: background work is at ${opts.sharePct ?? 70}% of this app's daily Claude limit, resumes at midnight`
  return 'Paused: this app\'s daily Claude limit is reached, resumes at midnight'
}
