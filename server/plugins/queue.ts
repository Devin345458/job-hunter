import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { Cron } from 'croner'
import { PIPELINE_CRON, PIPELINE_TIME_ZONE } from '#shared/utils/schedule'
import type { QueueRow } from '../utils/queue'
import { runQueueItem } from '../utils/queue-run'

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

interface Running {
  promise: Promise<void>
  lane: 'main' | 'light'
  renew: ReturnType<typeof setInterval>
}

function createWorker() {
  const owner = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`
  const slots = Math.max(1, Math.min(4, Number(useRuntimeConfig().workerConcurrency) || 1))
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
  const busy = (lane: Running['lane']) => [...running.values()].filter(r => r.lane === lane).length
  const wake = () => setImmediate(tick)

  function launch(item: QueueRow, lane: Running['lane']) {
    console.log(`[queue] running #${item.id} ${item.task}${item.attempts ? ` (resumed after a restart, attempt ${item.attempts + 1} of ${item.maxAttempts})` : ''}`)
    const renew = setInterval(() => {
      try {
        if (!renewLease(item.id, owner)) clearInterval(renew)
      }
      catch (e) {
        console.warn(`[queue] could not renew the lease on #${item.id}`, e)
      }
    }, RENEW_EVERY_MS)
    const promise = runInQueueContext(item, () => runQueueItem(item, owner))
      .then((outcome) => {
        if (outcome !== 'waiting') completeItem(item.id, owner, outcome)
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
      while (!stopping && busy('main') < slots) {
        const item = claimNext(owner)
        if (!item) break
        launch(item, 'main')
      }
      // The heartbeat does not wait behind a 25-minute demo build.
      if (!stopping && busy('main') >= slots && busy('light') < 1) {
        const item = claimNext(owner, LIGHT_TASKS)
        if (item) launch(item, 'light')
      }
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
      console.log(`[queue] worker ${owner} started, ${slots} at a time`)
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
