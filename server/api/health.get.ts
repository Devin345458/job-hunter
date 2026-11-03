import { hostname } from 'node:os'

// Public. Says which build is running, which role this process has (NUXT_ROLE), whether the
// database answers, and how many queue items are waiting and running. No user data.
export default defineEventHandler(() => {
  const db = useDb()
  let dbOk = false
  try {
    db.$client.prepare('select 1').get()
    dbOk = true
  }
  catch {}
  let queue: { queued: number; running: number } | null = null
  try {
    queue = queueDepth()
  }
  catch {}
  return {
    ok: dbOk,
    role: serverRole(),
    queue,
    commit: process.env.SOURCE_COMMIT || null,
    host: hostname(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    now: new Date().toISOString(),
  }
})
