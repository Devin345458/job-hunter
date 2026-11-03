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
