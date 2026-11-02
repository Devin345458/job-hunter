import type { PipelineRunView } from '#shared/types/pipeline'

export interface StatsResponse {
  review: { toDecide: number; blocked: number; sending: number; needsYou: number; submittedToday: number; submittedTotal: number }
  questions: { pending: number; blocking: number }
  newJobsToday: number
  totalJobs: number
  totalApplications: number
}

export interface RunsResponse {
  runs: PipelineRunView[]
  aiSpentToday: number
  aiBudget: number
  /** Set when the Anthropic account cannot serve requests (out of credit). */
  aiProblem?: { kind: 'credit'; message: string; since: string } | null
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
    const list = runs.value?.runs ?? []
    return list.find(r => r.task === 'pipeline:daily') ?? list[0] ?? null
  })

  return { stats, runs, loading, error, refresh, lastRun }
}
