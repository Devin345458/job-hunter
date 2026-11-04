import { and, asc, eq, gte, sql } from 'drizzle-orm'
import { aiCalls, appSettings } from '../db/schema'
import { PIPELINE_TIME_ZONE } from '#shared/utils/schedule'
import { resumeClock, type AppLimitKind } from '#shared/utils/subscription'

// This app's own limit on Devin's Claude subscription. Anthropic's usage limit (subscription-pause.ts)
// is the account's; this one is Devin's cap on how much of it the app may use, in the Agent SDK's
// estimated dollars (ai_calls.est_cost_usd where backend is 'agent'):
// - a daily limit (default $15), the day starting at local midnight exactly as the API key budget
//   counts it (the server runs in America/Chicago), and
// - a rolling 7-day limit (default $105, seven times the daily one, so one heavy day does not stop
//   the week), over the same window Settings shows as "the last 7 days".
// Background work (scheduled steps, per-job read and score items) stops at the background share of
// the daily limit (NUXT_BACKGROUND_BUDGET_SHARE, default 0.7), so what Devin starts can use the
// rest. At 100% of either limit every call stops. Stopped queue items go back in the queue to run
// after midnight, or when the 7-day total drops under the limit (ai.ts and plugins/queue.ts).
// The limits live in app_settings key `subscription_limits`, so Settings > Pipeline changes them
// without a redeploy; NUXT_SUBSCRIPTION_DAILY_LIMIT_USD and NUXT_SUBSCRIPTION_WEEK_LIMIT_USD are
// only the first defaults.

export const SUBSCRIPTION_LIMITS_KEY = 'subscription_limits'
export const DEFAULT_DAILY_LIMIT_USD = 15
export const DEFAULT_WEEK_LIMIT_USD = 105
/** The most a limit can be set to in Settings. */
export const MAX_LIMIT_USD = 10_000

export interface SubscriptionLimits {
  dailyUsd: number
  weekUsd: number
  /** True when Devin set them in Settings; false while the environment or the defaults apply. */
  fromSettings: boolean
}

export interface SubscriptionSpend {
  today: { estUsd: number; calls: number }
  week: { estUsd: number; calls: number }
}

/** What stops a call right now: the limit, when it lifts (ISO), and the sentence for the error. */
export interface AppLimitStop {
  kind: AppLimitKind
  until: string
  /** The estimated dollars the limit counts and the limit itself. */
  spentUsd: number
  limitUsd: number
  /** The background share in percent, for the app_background wording. */
  sharePct: number
  message: string
}

/** Start of today at local midnight, the same expression aiSpentToday() and aiStageCosts() use. */
const DAY_START = sql`datetime('now', 'localtime', 'start of day', 'utc')`
const WEEK_START = sql`datetime('now', '-7 days')`

const positive = (v: unknown): number | null => {
  const n = typeof v === 'string' && !v.trim() ? Number.NaN : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

const round2 = (n: number) => Math.round(n * 100) / 100
const usd = (n: number) => `$${n.toFixed(2)}`

/** Reads 'YYYY-MM-DD HH:MM:SS' (UTC, as SQLite writes it) as a Date. */
function fromSql(s: string): Date {
  return new Date(`${s.replace(' ', 'T')}Z`)
}

export function subscriptionLimits(): SubscriptionLimits {
  const row = useDb().select().from(appSettings).where(eq(appSettings.key, SUBSCRIPTION_LIMITS_KEY)).get()
  let stored: { dailyUsd?: unknown; weekUsd?: unknown } | null = null
  if (row) {
    try {
      stored = JSON.parse(row.valueJson)
    }
    catch {
      stored = null
    }
  }
  const config = useRuntimeConfig()
  return {
    dailyUsd: positive(stored?.dailyUsd) ?? positive(config.subscriptionDailyLimitUsd) ?? DEFAULT_DAILY_LIMIT_USD,
    weekUsd: positive(stored?.weekUsd) ?? positive(config.subscriptionWeekLimitUsd) ?? DEFAULT_WEEK_LIMIT_USD,
    fromSettings: !!row,
  }
}

/** Checks a limit typed in Settings: a dollar amount above 0 and at most MAX_LIMIT_USD, kept to the cent. */
export function cleanLimit(v: unknown, label: string): number {
  const n = Number(v)
  if (v == null || v === '' || !Number.isFinite(n) || n <= 0) throw new Error(`The ${label} must be a dollar amount above $0`)
  if (n > MAX_LIMIT_USD) throw new Error(`The ${label} can be at most $${MAX_LIMIT_USD.toLocaleString('en-US')}`)
  return Math.max(0.01, round2(n))
}

export function saveSubscriptionLimits(limits: { dailyUsd: number; weekUsd: number }): SubscriptionLimits {
  const valueJson = JSON.stringify({ dailyUsd: limits.dailyUsd, weekUsd: limits.weekUsd })
  const updatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19)
  useDb().insert(appSettings).values({ key: SUBSCRIPTION_LIMITS_KEY, valueJson, updatedAt })
    .onConflictDoUpdate({ target: appSettings.key, set: { valueJson, updatedAt } }).run()
  return subscriptionLimits()
}

function spendSince(since: ReturnType<typeof sql>) {
  const row = useDb().select({
    est: sql<number>`coalesce(sum(${aiCalls.estCostUsd}), 0)`,
    calls: sql<number>`count(*)`,
  }).from(aiCalls).where(and(gte(aiCalls.createdAt, since), eq(aiCalls.backend, 'agent'))).get()
  return { estUsd: row?.est ?? 0, calls: row?.calls ?? 0 }
}

/** Estimated dollars and calls on the subscription today and in the last 7 days (not rounded). */
export function subscriptionSpend(): SubscriptionSpend {
  return { today: spendSince(DAY_START), week: spendSince(WEEK_START) }
}

/** The next local midnight, when the daily limit and its background share start over (ISO). */
export function nextMidnight(): string {
  const row = useDb().get<{ t: string }>(sql`select datetime('now', 'localtime', 'start of day', '+1 day', 'utc') as t`)
  return fromSql(row!.t).toISOString()
}

/**
 * When the 7-day total falls under `limit` again: the calls in the window drop out oldest first,
 * each 7 days after it was made. Null when the total is already under the limit.
 */
export function weekLiftTime(limit: number, total = spendSince(WEEK_START).estUsd): string | null {
  if (total < limit) return null
  const rows = useDb().select({ createdAt: aiCalls.createdAt, est: aiCalls.estCostUsd }).from(aiCalls)
    .where(and(gte(aiCalls.createdAt, WEEK_START), eq(aiCalls.backend, 'agent')))
    .orderBy(asc(aiCalls.createdAt), asc(aiCalls.id)).all()
  let left = total
  for (const r of rows) {
    left -= r.est ?? 0
    if (left < limit) return new Date(fromSql(r.createdAt).getTime() + 7 * 86_400_000).toISOString()
  }
  return new Date(Date.now() + 7 * 86_400_000).toISOString()
}

function stopMessage(kind: AppLimitKind, spent: number, limit: number, until: string, sharePct: number): string {
  if (kind === 'app_week') {
    return `This app's 7-day Claude limit is reached (est. ${usd(spent)} of ${usd(limit)} in the last 7 days). Claude calls resume at ${resumeClock(until, { timeZone: PIPELINE_TIME_ZONE })}. Raise the limit in Settings > Pipeline to keep going sooner.`
  }
  if (kind === 'app_background') {
    return `Background work paused at ${sharePct}% of this app's daily Claude limit (est. ${usd(spent)} of ${usd(limit)} today). The rest is kept for what you start yourself, and the backlog continues after midnight. Raise the limit in Settings > Pipeline to keep it going today.`
  }
  return `This app's daily Claude limit is reached (est. ${usd(spent)} of ${usd(limit)} today). Claude calls resume at midnight. Raise the limit in Settings > Pipeline to keep going today.`
}

/**
 * The limit that stops a call on the subscription right now, or null. `background` applies the
 * background share (`share`, 0 to 1) to the daily limit. When more than one limit holds, the one
 * that lifts last is returned, since the work waits for it.
 */
export function appLimitStop(opts: { background: boolean; share: number }): AppLimitStop | null {
  const limits = subscriptionLimits()
  const spend = subscriptionSpend()
  const sharePct = Math.round(opts.share * 100)
  const stops: AppLimitStop[] = []
  const add = (kind: AppLimitKind, spent: number, limit: number, until: string) =>
    stops.push({ kind, until, spentUsd: round2(spent), limitUsd: limit, sharePct, message: stopMessage(kind, spent, limit, until, sharePct) })
  if (spend.today.estUsd >= limits.dailyUsd) add('app_daily', spend.today.estUsd, limits.dailyUsd, nextMidnight())
  else if (opts.background && spend.today.estUsd >= limits.dailyUsd * opts.share) add('app_background', spend.today.estUsd, limits.dailyUsd, nextMidnight())
  const weekUntil = weekLiftTime(limits.weekUsd, spend.week.estUsd)
  if (weekUntil) add('app_week', spend.week.estUsd, limits.weekUsd, weekUntil)
  if (!stops.length) return null
  return stops.reduce((a, b) => (Date.parse(b.until) > Date.parse(a.until) ? b : a))
}

/** True for the note pauseItem() wrote on an item this app's limit put back (appLimitPauseText). */
export const APP_LIMIT_NOTE_SQL = sql`(note like 'Paused: this app''s %' or note like 'Paused: background work is at %')`
