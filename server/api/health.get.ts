import { hostname } from 'node:os'

// Public. Says which build is running and whether the database answers. No user data.
export default defineEventHandler(() => {
  const db = useDb()
  let dbOk = false
  try {
    db.$client.prepare('select 1').get()
    dbOk = true
  }
  catch {}
  return {
    ok: dbOk,
    commit: process.env.SOURCE_COMMIT || null,
    host: hostname(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    now: new Date().toISOString(),
  }
})
