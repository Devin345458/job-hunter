import { cleanLimit, saveSubscriptionLimits } from '~~/server/utils/subscription-budget'

// PUT /api/settings/subscription-limits { dailyUsd, weekUsd }
// This app's own limits on Devin's Claude subscription, in estimated dollars: per day and over a
// rolling 7 days (server/utils/subscription-budget.ts). Stored in app_settings, so they apply to
// the next Claude call without a redeploy. Work the old limits put back in the queue is released
// to run now; anything the new limits still stop is put back again at its first Claude call.
// Returns the subscription view Settings > Pipeline shows.
export default defineEventHandler(async (event) => {
  const body = await readBody<{ dailyUsd?: unknown; weekUsd?: unknown }>(event)
  let limits: { dailyUsd: number; weekUsd: number }
  try {
    limits = { dailyUsd: cleanLimit(body?.dailyUsd, 'daily limit'), weekUsd: cleanLimit(body?.weekUsd, '7-day limit') }
  }
  catch (e: any) {
    throw createError({ statusCode: 400, statusMessage: e?.message || 'Enter both limits as dollar amounts' })
  }
  saveSubscriptionLimits(limits)
  const released = releaseAppLimitItems()
  if (released) console.log(`[ai] subscription limits now $${limits.dailyUsd} a day and $${limits.weekUsd} a week; ${released} item(s) the old limits paused run again`)
  return { subscription: subscriptionStatusView(), released }
})
