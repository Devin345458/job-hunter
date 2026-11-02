/**
 * When the full pipeline runs. nuxt.config.ts schedules pipeline:daily with the cron below, in the
 * container's time zone (TZ=America/Chicago); every screen that mentions the schedule reads this.
 */
export const PIPELINE_CRON = '0 6-21/3 * * *'
export const PIPELINE_HOURS = [6, 9, 12, 15, 18, 21] as const
export const PIPELINE_TIME_ZONE = 'America/Chicago'
export const PIPELINE_SCHEDULE_TEXT = 'every 3 hours from 6 AM to 9 PM Central'

/** The next scheduled run after `now`, as "3:00 PM" (today) or "tomorrow 6:00 AM", in Central time. */
export function nextPipelineRunText(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: PIPELINE_TIME_ZONE, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now)
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 0)
  const next = PIPELINE_HOURS.find(h => h > hour)
  const label = (h: number) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'AM' : 'PM'}`
  return next != null ? label(next) : `tomorrow ${label(PIPELINE_HOURS[0])}`
}
