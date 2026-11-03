import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { Cron } from 'croner'
import { PIPELINE_CRON, PIPELINE_TIME_ZONE } from '#shared/utils/schedule'
import { NO_RETRY_TASKS, currentQueueContext, pauseItem, type ItemOutcome, type QueueRow } from '../utils/queue'
import { isBackgroundWork } from '../utils/ai'
import { runQueueItem } from '../utils/queue-run'
import { subscriptionClaimMode } from '../utils/subscription-pause'

// Starts this process's part of the job queue, by role (server/utils/role.ts):
// - all and worker: the worker (claims and runs queue items) and, unless NUXT_SCHEDULER_ENABLED is
//   false, the schedule (adds pipeline:daily and the heartbeat to the queue on their cron times)
// - web: nothing; its routes only add items to the queue
// On SIGTERM (Nitro's close hook) the worker stops claiming, gives the running item up to 25
// seconds, and otherwise ends its lease so the next start resumes it.

/** The heartbeat's cron. Keep in step with the dashboard text ("every 15 minutes"). */
const HEARTBEAT_CRON = '*/15 * * * *'
const GRACE_MS = 25_000
const TICK_MS = 2_000
const PRUNE_EVERY_MS = 3600_000

export default defineNitroPlugin((nitroApp) => {
  if (import.meta.prerender) return
  const role = serverRole()
  const worker = runsWorker()
  const schedule = runsSchedule()
  console.log(`[queue] role ${role}: ${worker ? 'runs the worker' : 'adds work to the queue only'}${schedule ? ', keeps the schedule' : worker ? ', schedule off' : ''}`)
  if (!worker) return

  try {
    const closed = closeOrphanRuns()
    if (closed) console.log(`[runs] closed ${closed} run(s) left running by a previous server process`)
  }
  catch (e) {
    console.error('[runs] could not close stale runs', e)
  }

  const w = createWorker()
  w.start()

  const crons: Cron[] = []
  if (schedule) {
    const config = useRuntimeConfig()
    const daily = String(config.pipelineCron || PIPELINE_CRON)
    const heartbeat = String(config.heartbeatCron || HEARTBEAT_CRON)
    const guard = (what: string, fn: () => void) => () => {
      try {
        fn()
      }
      catch (e) {
        console.error(`[queue] could not queue the scheduled ${what}`, e)
      }
    }
    crons.push(new Cron(daily, { timezone: PIPELINE_TIME_ZONE, protect: true }, guard(DAILY_TASK, () => enqueueDaily('schedule'))))
    crons.push(new Cron(heartbeat, { timezone: PIPELINE_TIME_ZONE, protect: true }, guard(HEARTBEAT_TASK, () => {
      enqueue(HEARTBEAT_TASK, {}, { trigger: 'schedule', existing: () => activeItem(HEARTBEAT_TASK) })
    })))
    console.log(`[queue] schedule: ${DAILY_TASK} at "${daily}", heartbeat at "${heartbeat}" (${PIPELINE_TIME_ZONE})`)
  }

  nitroApp.hooks.hook('close', async () => {
    for (const c of crons) c.stop()
    await w.stop(GRACE_MS)
  })
})

/**
 * Lanes, each with its own slots:
 * - main: everything else, NUXT_WORKER_CONCURRENCY at once (default 1)
 * - bulk: one item per job (read a posting, score a job), NUXT_BULK_CONCURRENCY at once (default 4)
 * - coord: the jobs:enrich and jobs:match steps, which queue per-job items and wait for them
 * - light: the heartbeat, only while the main lane is full
 */
type Lane = 'main' | 'bulk' | 'coord' | 'light'

interface Running {
  promise: Promise<void>
  lane: Lane
  renew: ReturnType<typeof setInterval>
}

function createWorker() {
  const owner = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`
  const config = useRuntimeConfig()
  const slots = Math.max(1, Math.min(4, Number(config.workerConcurrency) || 1))
  const bulkSlots = Math.max(1, Math.min(8, Number(config.bulkConcurrency) || 4))
  const coordSlots = 2
  const mainExcept = [...BULK_TASKS, ...COORD_TASKS]
  const running = new Map<number, Running>()
  let stopping = false
  let ticking = false
  let timer: ReturnType<typeof setInterval> | null = null
  let pruner: ReturnType<typeof setInterval> | null = null
  const prune = () => {
    try {
      const n = pruneQueue()
      if (n) console.log(`[queue] pruned ${n} finished item(s)`)
    }
    catch (e) {
      console.warn('[queue] could not prune finished items', e)
    }
  }
  const busy = (lane: Lane) => [...running.values()].filter(r => r.lane === lane).length
  const wake = () => setImmediate(tick)

  function launch(item: QueueRow, lane: Lane) {
    console.log(`[queue] running #${item.id} ${item.task}${item.attempts ? ` (resumed after a restart, attempt ${item.attempts + 1} of ${item.maxAttempts})` : ''}`)
    const renew = setInterval(() => {
      try {
        if (!renewLease(item.id, owner)) clearInterval(renew)
      }
      catch (e) {
        console.warn(`[queue] could not renew the lease on #${item.id}`, e)
      }
    }, RENEW_EVERY_MS)
    // A call in the item met Devin's subscription limit: the item goes back in the queue to run
    // after the reset instead of ending (never for an approval, which may have submitted).
    const run = () => runQueueItem(item, owner)
      .catch((e): ItemOutcome => {
        console.error(`[queue] #${item.id} ${item.task} failed`, e)
        return { status: 'failed', error: e?.message || String(e) }
      })
      .then((outcome) => {
        const ctx = currentQueueContext()
        const until = ctx?.subscriptionPausedUntil
        const retry = !!until && outcome !== 'waiting' && !(NO_RETRY_TASKS as readonly string[]).includes(item.task)
        return { outcome, pause: retry ? { until: until!, background: isBackgroundWork() } : null }
      })
    const promise = runInQueueContext(item, run)
      .then(({ outcome, pause }) => {
        if (pause) pauseItem(item.id, owner, pause.until, { background: pause.background })
        else if (outcome !== 'waiting') completeItem(item.id, owner, outcome)
      })
      .catch((e) => {
        console.error(`[queue] #${item.id} ${item.task} failed`, e)
        try {
          completeItem(item.id, owner, { status: 'failed', error: e?.message || String(e) })
        }
        catch (e2) {
          console.error(`[queue] could not record #${item.id} as failed`, e2)
        }
      })
      .finally(() => {
        clearInterval(renew)
        running.delete(item.id)
        if (!stopping) wake()
      })
    running.set(item.id, { promise, lane, renew })
  }

  function tick() {
    if (stopping || ticking) return
    ticking = true
    try {
      recoverExpired(owner, new Set(running.keys()))
      // Devin's Claude subscription at its limit: only items that never call Claude, then for a
      // minute after the reset only items he started (server/utils/subscription-pause.ts).
      const ai = subscriptionClaimMode()
      const fill = (lane: Lane, max: number, pick: { only?: readonly string[]; except?: readonly string[] }) => {
        while (!stopping && busy(lane) < max) {
          const item = claimNext(owner, { ...pick, ai })
          if (!item) break
          launch(item, lane)
        }
      }
      fill('main', slots, { except: mainExcept })
      fill('coord', coordSlots, { only: COORD_TASKS })
      fill('bulk', bulkSlots, { only: BULK_TASKS })
      // The heartbeat does not wait behind a 25 minute demo build.
      if (busy('main') >= slots) fill('light', 1, { only: LIGHT_TASKS })
    }
    catch (e) {
      console.error('[queue] worker tick failed', e)
    }
    finally {
      ticking = false
    }
  }

  return {
    start() {
      try {
        const n = recoverExpired(owner, new Set())
        if (n) console.log(`[queue] ${n} item(s) interrupted by the last restart were recovered`)
        advanceStuckChains()
      }
      catch (e) {
        console.error('[queue] recovery at start failed', e)
      }
      prune()
      queueEvents.on('enqueued', wake)
      timer = setInterval(tick, TICK_MS)
      pruner = setInterval(prune, PRUNE_EVERY_MS)
      console.log(`[queue] worker ${owner} started: ${slots} at a time, ${bulkSlots} per-job items at a time`)
      wake()
    },

    async stop(graceMs: number) {
      stopping = true
      if (timer) clearInterval(timer)
      if (pruner) clearInterval(pruner)
      queueEvents.off('enqueued', wake)
      if (!running.size) return
      const ids = [...running.keys()]
      console.log(`[queue] stopping: giving ${ids.map(id => `#${id}`).join(', ')} up to ${graceMs / 1000}s to finish`)
      const finished = await Promise.race([
        Promise.allSettled([...running.values()].map(r => r.promise)).then(() => true),
        new Promise<boolean>(r => setTimeout(() => r(false), graceMs)),
      ])
      if (finished) {
        console.log('[queue] stopped cleanly')
        return
      }
      for (const [id, r] of running) {
        clearInterval(r.renew)
        releaseLease(id, owner)
        console.log(`[queue] #${id} did not finish in time; its lease is released so the next start resumes it`)
      }
    },
  }
}
