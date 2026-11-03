// Which parts of the app this process runs, from NUXT_ROLE. One image, three roles:
// - all (default): serves the app, keeps the schedule, and runs the queue worker (one container)
// - web: serves the app and adds work to the queue; no schedule, no worker
// - worker: keeps the schedule and runs the queue worker; answers only /api/health
// NUXT_SCHEDULER_ENABLED=false turns the schedule off in any role. Manual runs still go to the
// queue and the worker still runs them.

export type ServerRole = 'all' | 'web' | 'worker'

let warned = false

export function serverRole(): ServerRole {
  const raw = String(useRuntimeConfig().role || 'all').trim().toLowerCase()
  if (raw === 'all' || raw === 'web' || raw === 'worker') return raw
  if (!warned) {
    warned = true
    console.warn(`[role] NUXT_ROLE=${raw} is not all, web, or worker; running as all`)
  }
  return 'all'
}

/** True where this process claims and runs queue items (all, worker). */
export function runsWorker(): boolean {
  return serverRole() !== 'web'
}

/** True where this process adds the scheduled runs to the queue (all, worker, unless the schedule is off). */
export function runsSchedule(): boolean {
  return serverRole() !== 'web' && String(useRuntimeConfig().schedulerEnabled) !== 'false'
}

/** True where this process serves pages and the API (all, web). */
export function servesApp(): boolean {
  return serverRole() !== 'worker'
}
