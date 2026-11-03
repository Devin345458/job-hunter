import type { AiStageCosts, PipelineRunView, QueueSnapshot } from '#shared/types/pipeline'

export interface StatsResponse {
  review: { toDecide: number; toSend: number; preparing: number; blocked: number; sending: number; needsYou: number; submittedToday: number; submittedTotal: number }
  questions: { pending: number; blocking: number }
  newJobsToday: number
  totalJobs: number
  totalApplications: number
}

export interface RunsResponse {
  /** Recent runs, newest first, without scheduler heartbeats. */
  runs: PipelineRunView[]
  /** The latest pipeline:daily run, however far back it is in the list. */
  lastDaily?: PipelineRunView | null
  /** The latest scheduler heartbeat (fires every 15 minutes). */
  lastHeartbeat?: PipelineRunView | null
  aiSpentToday: number
  aiBudget: number
  /** AI spend by stage of the decide-first flow, today and over the last 7 days. */
  aiStages?: AiStageCosts
  /** Set when the Anthropic account cannot serve requests (out of credit, or the key was rejected). The message is a plain sentence. */
  aiProblem?: { kind: 'credit' | 'key'; message: string; since: string } | null
  /** The job queue: running, waiting, daily runs under way, and the last day's notable items. */
  queue?: QueueSnapshot
}

/**
 * Shared, app-wide pipeline health: counts from /api/stats and recent runs plus today's AI
 * spend from /api/pipeline/runs. The shell reads it for nav badges, the review page for the
 * health strip, and Settings for the Pipeline panel.
 */
export function usePipelineHealth() {
  const stats = useState<StatsResponse | null>('health-stats', () => null)
  const runs = useState<RunsResponse | null>('health-runs', () => null)
  const loading = useState<boolean>('health-loading', () => false)
  const error = useState<string | null>('health-error', () => null)

  async function refresh(limit = 20) {
    loading.value = true
    try {
      const [s, r] = await Promise.all([
        $fetch<StatsResponse>('/api/stats'),
        $fetch<RunsResponse>('/api/pipeline/runs', { query: { limit } }),
      ])
      stats.value = s
      runs.value = r
      error.value = null
    }
    catch (e: any) {
      error.value = e?.data?.statusMessage || e?.message || 'Could not load pipeline health'
    }
    finally {
      loading.value = false
    }
  }

  /** The most recent run of the daily chain, or of anything when the chain never ran. */
  const lastRun = computed<PipelineRunView | null>(() => {
    const list = (runs.value?.runs ?? []).filter(r => r.task !== 'system:heartbeat')
    return runs.value?.lastDaily ?? list.find(r => r.task === 'pipeline:daily') ?? list[0] ?? null
  })

  /** True while anything is waiting in or running from the job queue. */
  const queueBusy = computed(() => {
    const q = runs.value?.queue
    return !!q && (q.running.length > 0 || q.waiting.length > 0 || q.runs.length > 0 || (q.bulk?.length ?? 0) > 0)
  })

  const watchers = useState<number>('health-queue-watchers', () => 0)
  const polling = useState<boolean>('health-queue-polling', () => false)

  /**
   * Keeps the health state fresh while the job queue is busy, so a run reads queued, running, then
   * done without a reload. One poll loop for the whole app; it stops when the queue is empty or the
   * last component that asked stops watching. Returns the function that stops watching.
   */
  function watchQueue(): () => void {
    watchers.value++
    void (async () => {
      if (polling.value) return
      polling.value = true
      try {
        while (watchers.value > 0) {
          await new Promise(r => setTimeout(r, 4000))
          if (watchers.value <= 0) break
          if (!queueBusy.value && !(runs.value?.runs ?? []).some(r => r.status === 'running')) {
            // Look again now and then: a scheduled run or another tab may have queued something.
            await new Promise(r => setTimeout(r, 26_000))
            if (watchers.value <= 0) break
          }
          await refresh()
        }
      }
      finally {
        polling.value = false
      }
    })()
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      watchers.value = Math.max(0, watchers.value - 1)
    }
  }

  return { stats, runs, loading, error, refresh, lastRun, queueBusy, watchQueue }
}
