import { eq } from 'drizzle-orm'
import { applications } from '../db/schema'
import { runApproval } from './approval'
import { prepareApplication, refillApplicationForm } from './apply/prepare'
import { runDemoRebuild } from './demo/build'
import { runDemoPreview } from './demo/preview'
import { findMyRepos } from './repos/commit-search'
import { refreshRepoList } from './repos/settings'
import { runEnrichOne, runMatchOne } from './queue-jobs'
import type { ItemOutcome, QueueRow } from './queue'
import type { RunTrigger } from './runs'

// What the worker does with each kind of queue item. Pipeline tasks (server/tasks) run through
// Nitro's runTask exactly as the schedule ran them before the queue; the one-off jobs that routes
// used to start in the background (approve, prepare again, refill, demo rebuild and preview, the
// commit search) run here, each recorded in pipeline_runs by withRun.

type RunResult = { runId: number; status: 'succeeded' | 'failed' | 'skipped'; error: string | null }

function fromRun(r: RunResult): ItemOutcome {
  return { status: r.status === 'failed' ? 'failed' : 'done', error: r.status === 'failed' ? r.error : null, result: { runId: r.runId, status: r.status } }
}

function appId(payload: Record<string, unknown>): number {
  const id = Number(payload.applicationId)
  if (!Number.isInteger(id) || id <= 0) throw new Error('The queue item names no application')
  return id
}

function appRow(id: number) {
  const app = useDb().select().from(applications).where(eq(applications.id, id)).get()
  if (!app) throw new Error(`Application ${id} no longer exists`)
  return app
}

/** Runs one claimed item. 'waiting' means a daily run queued its steps and finishes with the last one. */
export async function runQueueItem(item: QueueRow, owner: string): Promise<ItemOutcome | 'waiting'> {
  const payload = parsePayload(item)
  const trigger = item.trigger as RunTrigger
  switch (item.task) {
    case DAILY_TASK:
      startDailyChain(item, owner)
      return 'waiting'

    case APPROVE_TASK: {
      const id = appId(payload)
      return fromRun(await withRun(APPROVE_TASK, trigger, async (log) => {
        log(`application ${id}: publish and submit`)
        await runApproval(id)
        const app = appRow(id)
        log(`application ${id}: ${app.status}`)
        return { applicationId: id, status: app.status, ...(app.status === 'submit_failed' ? { failed: 1 } : {}) }
      }, { lockKey: `${APPROVE_TASK}#${id}` }))
    }

    case PREPARE_ONE_TASK: {
      const id = appId(payload)
      return fromRun(await withRun(PREPARE_ONE_TASK, trigger, async (log) => {
        const app = appRow(id)
        try {
          const out = await prepareApplication(app.jobId, app, log)
          return { applicationId: id, status: out.status, ...(out.error ? { failed: 1, errors: [out.error] } : {}) }
        }
        catch (e) {
          // Out of budget or credit: the application waits in preparing and the next run continues it.
          if (e instanceof AiBudgetExceeded) return { applicationId: id, status: 'preparing', budgetStop: true }
          throw e
        }
      }, { lockKey: `prepare#${id}` }))
    }

    case REFILL_TASK: {
      const id = appId(payload)
      return fromRun(await withRun(REFILL_TASK, trigger, async (log) => {
        log(`application ${id}: form dry run again`)
        const out = await refillApplicationForm(id)
        return { applicationId: id, status: out.status }
      }, { lockKey: `prepare#${id}` }))
    }

    case REBUILD_TASK:
      return fromRun(await runDemoRebuild(Number(payload.demoId)))

    case PREVIEW_TASK:
      return fromRun(await runDemoPreview(Number(payload.demoId)))

    // One job each, no pipeline_runs row: the jobs:enrich and jobs:match steps count the results.
    case ENRICH_ONE_TASK:
      return { status: 'done', result: await runEnrichOne(payload) }

    case MATCH_ONE_TASK:
      return { status: 'done', result: await runMatchOne(payload) }

    case FIND_TASK:
      return fromRun(await withRun(FIND_TASK, trigger, async (log) => {
        // List first, so repos the search finds that no token lists are told apart from listed ones.
        const listed = await refreshRepoList()
        const f = await findMyRepos(log, listed.accounts)
        return {
          repos: Object.keys(f.byRepo).length,
          owners: new Set(Object.keys(f.byRepo).map(n => n.split('/')[0]!.toLowerCase())).size,
          commits: f.commits,
          requests: f.requests,
          seconds: f.seconds,
          ...(f.notes.length ? { notes: f.notes } : {}),
        }
      }))

    default: {
      // A pipeline task (server/tasks): the same code the schedule used to run in-process.
      const res = await runTask(item.task, { payload: { ...payload, trigger } }) as { result?: any }
      const r = res?.result
      if (r && typeof r === 'object' && 'runId' in r && 'status' in r) return fromRun(r as RunResult)
      return { status: 'done', result: r ?? null }
    }
  }
}
