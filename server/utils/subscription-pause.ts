import { eq } from 'drizzle-orm'
import { appSettings } from '../db/schema'
import { PIPELINE_TIME_ZONE } from '#shared/utils/schedule'
import { subscriptionPauseText } from '#shared/utils/subscription'

// The pause after Devin's Claude subscription reports a usage or rate limit. Stored in
// app_settings (no schema change), so a web process and a worker process sharing the database
// both see it. While it holds:
// - every call that would run on the subscription fails fast with AiSubscriptionLimit (no process
//   is started), and a queue item that hit it goes back in the queue to run after the reset;
// - the worker claims no item that calls Claude (claimNext's aiPaused);
// - for PRIORITY_WINDOW_MS after the reset only items Devin started are claimed, so his chat,
//   drafts, and Apply preparation go before the backlog.
// The SDK reports the reset time (rate_limit_event resetsAt). When it reports none, the pause
// is a backoff: 15 minutes, doubling with each limit in a row, at most 2 hours.

export const SUBSCRIPTION_PAUSE_KEY = 'subscription_pause'
export const PRIORITY_WINDOW_MS = 60_000
const BACKOFF_MS = 15 * 60_000
const MAX_BACKOFF_MS = 2 * 3600_000
/** Started this long after the reported reset, so the first call does not land a second early. */
const RESET_MARGIN_MS = 30_000

export interface SubscriptionPauseState {
  /** ISO time the pause ends. */
  until: string
  /** ISO time the first limit of this pause was reported. */
  since: string
  /** The SDK reported the reset time (false: a backoff guess). */
  reported: boolean
  /** Limits in a row without a reported reset; the backoff doubles with each. */
  strikes: number
  /** The limit the SDK named (five_hour, seven_day, ...), when it named one. */
  kind?: string | null
}

export function subscriptionPauseState(): SubscriptionPauseState | null {
  const row = useDb().select().from(appSettings).where(eq(appSettings.key, SUBSCRIPTION_PAUSE_KEY)).get()
  if (!row) return null
  try {
    const v = JSON.parse(row.valueJson) as SubscriptionPauseState
    return v && typeof v.until === 'string' ? v : null
  }
  catch {
    return null
  }
}

/** The pause, while it holds (its end is still ahead). */
export function activeSubscriptionPause(now = Date.now()): SubscriptionPauseState | null {
  const s = subscriptionPauseState()
  return s && Date.parse(s.until) > now ? s : null
}

/** Where the worker is: paused (no Claude items), the priority window after it, or free. */
export function subscriptionClaimMode(now = Date.now()): 'paused' | 'foreground' | 'free' {
  const s = subscriptionPauseState()
  if (!s) return 'free'
  const until = Date.parse(s.until)
  if (now < until) return 'paused'
  if (now < until + PRIORITY_WINDOW_MS) return 'foreground'
  return 'free'
}

function save(state: SubscriptionPauseState) {
  const valueJson = JSON.stringify(state)
  const updatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19)
  useDb().insert(appSettings).values({ key: SUBSCRIPTION_PAUSE_KEY, valueJson, updatedAt })
    .onConflictDoUpdate({ target: appSettings.key, set: { valueJson, updatedAt } }).run()
}

/**
 * Records a limit the subscription reported and returns the pause. `resetsAtMs` is the SDK's
 * reset time (null when it gave none: a backoff). A pause already running to a later time is
 * kept, so one call's shorter window never cuts another's longer one.
 */
export function recordSubscriptionLimit(resetsAtMs: number | null, kind?: string | null, now = Date.now()): SubscriptionPauseState {
  const prev = subscriptionPauseState()
  const prevUntil = prev ? Date.parse(prev.until) : 0
  // A limit within an hour of the last pause's end continues it; an older pause is history.
  const continues = !!prev && prevUntil + 3600_000 > now
  let until: number
  let strikes = 0
  const reported = resetsAtMs != null && Number.isFinite(resetsAtMs) && resetsAtMs > now
  if (reported) {
    until = resetsAtMs! + RESET_MARGIN_MS
  }
  else {
    strikes = continues && prev && !prev.reported ? prev.strikes + 1 : 1
    until = now + Math.min(BACKOFF_MS * 2 ** (strikes - 1), MAX_BACKOFF_MS)
  }
  if (continues && prevUntil > until && prevUntil > now) {
    until = prevUntil
  }
  const state: SubscriptionPauseState = {
    until: new Date(until).toISOString(),
    since: continues && prev ? prev.since : new Date(now).toISOString(),
    reported,
    strikes,
    kind: kind ?? (continues ? prev?.kind ?? null : null),
  }
  save(state)
  console.warn(`[ai] Claude subscription limit${state.kind ? ` (${state.kind})` : ''}: calls on it pause until ${state.until}${reported ? '' : ' (no reset time reported, backoff)'}`)
  return state
}

/** A call on the subscription worked: the pause and its backoff are over. */
export function clearSubscriptionPause() {
  if (!subscriptionPauseState()) return
  useDb().delete(appSettings).where(eq(appSettings.key, SUBSCRIPTION_PAUSE_KEY)).run()
  console.log('[ai] Claude subscription calls work again; the pause is cleared')
}

/** The message stored with paused work, in the server's time zone. */
export function subscriptionPauseMessage(state: Pick<SubscriptionPauseState, 'until'>): string {
  return subscriptionPauseText(state.until, { timeZone: PIPELINE_TIME_ZONE })
}

/** What the dashboard shows while the pause holds: its end, and the sentence in the server's time zone. */
export function subscriptionPauseView(): { until: string; since: string; reported: boolean; message: string } | null {
  const s = activeSubscriptionPause()
  return s ? { until: s.until, since: s.since, reported: s.reported, message: subscriptionPauseMessage(s) } : null
}
