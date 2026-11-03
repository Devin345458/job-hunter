/**
 * When the full pipeline runs. nuxt.config.ts schedules pipeline:daily with the cron below, in the
 * container's time zone (TZ=America/Chicago); every screen that mentions the schedule reads this.
 */
export const PIPELINE_CRON = '0 6-21/3 * * *'
export const PIPELINE_HOURS = [6, 9, 12, 15, 18, 21] as const
export const PIPELINE_TIME_ZONE = 'America/Chicago'
export const PIPELINE_SCHEDULE_TEXT = 'every 3 hours from 6 AM to 9 PM Central'

/**
 * The steps pipeline:daily runs, in order (server/tasks/pipeline/daily.ts). Settings lists them in
 * this order. repos:index runs first so the day's questions can be checked against fresh commits.
 * repos:suggest and memory:leads run last, so the questions this run asked (match and prepare
 * create them) get suggestions and leads too. memory:leads is best effort: off or unreachable
 * memory records a plain note and the chain carries on.
 */
export const DAILY_STEPS = [
  'repos:index',
  'learn:daily',
  'jobs:search',
  'jobs:enrich',
  'jobs:match',
  'applications:prepare',
  'demos:build',
  'repos:suggest',
  'memory:leads',
] as const

export type DailyStep = (typeof DAILY_STEPS)[number]

/** The next scheduled run after `now`, as "3:00 PM" (today) or "tomorrow 6:00 AM", in Central time. */
export function nextPipelineRunText(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: PIPELINE_TIME_ZONE, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now)
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 0)
  const next = PIPELINE_HOURS.find(h => h > hour)
  const label = (h: number) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'AM' : 'PM'}`
  return next != null ? label(next) : `tomorrow ${label(PIPELINE_HOURS[0])}`
}
