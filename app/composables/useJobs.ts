import type { InferSelectModel } from 'drizzle-orm'
import type { jobs } from '~~/server/db/schema'

export type Job = InferSelectModel<typeof jobs>

/** The columns GET /api/jobs returns for each card (server/api/jobs/index.get.ts). The detail page loads the rest. */
export type JobListItem = Pick<Job,
  | 'id' | 'source' | 'title' | 'company' | 'location' | 'remoteType' | 'salaryMin' | 'salaryMax' | 'salaryCurrency'
  | 'totalCompEstimate' | 'matchScore' | 'status' | 'tags' | 'applyUrl' | 'atsType' | 'isSandbox' | 'foundAt'>

export type JobStatus = 'new' | 'reviewed' | 'applied' | 'rejected' | 'expired'
export type RemoteType = 'remote' | 'hybrid' | 'onsite'

export interface JobFilters {
  status?: JobStatus | JobStatus[]
  search?: string
  remoteType?: RemoteType
  minScore?: number
  maxScore?: number
  page?: number
  limit?: number
}

export interface JobsResponse {
  jobs: JobListItem[]
  total: number
  page: number
  limit: number
}

/** Result of POST /api/jobs/search: the jobs:search run it recorded in pipeline_runs. */
export interface JobSearchResult {
  runId: number
  status: 'succeeded' | 'failed' | 'skipped'
  message: string
  jobsFound: number
  found: number
}

/** A list request that a newer one replaced. Callers ignore it. */
export class SupersededRequest extends Error {
  constructor() {
    super('superseded')
    this.name = 'SupersededRequest'
  }
}

export function useJobs() {
  const jobs = ref<JobListItem[]>([])
  const total = ref(0)
  const page = ref(1)
  const loading = ref(false)
  const error = ref<string | null>(null)

  // Only the newest list request may write to the list. Filter changes can fire requests
  // faster than they answer; an older answer arriving last used to overwrite the newer one.
  let latestRequest = 0
  let inFlight: AbortController | null = null

  /**
   * Loads one page of jobs. With append, the page is added to the end of the list ("Load more");
   * otherwise it replaces the list. Throws SupersededRequest when a newer call replaced this one.
   */
  async function fetchJobs(filters?: JobFilters, options: { append?: boolean } = {}): Promise<JobsResponse> {
    const requestId = ++latestRequest
    inFlight?.abort()
    const controller = new AbortController()
    inFlight = controller

    loading.value = true
    error.value = null

    try {
      const params: Record<string, string | number> = {}

      if (filters?.status) {
        params.status = Array.isArray(filters.status)
          ? filters.status.join(',')
          : filters.status
      }
      if (filters?.search) params.search = filters.search
      if (filters?.remoteType) params.remoteType = filters.remoteType
      if (filters?.minScore !== undefined) params.minScore = filters.minScore
      if (filters?.maxScore !== undefined) params.maxScore = filters.maxScore
      if (filters?.page) params.page = filters.page
      if (filters?.limit) params.limit = filters.limit

      // A request that never finishes would leave the progress bar up for good; give up after
      // 20 seconds and show the error with a retry instead.
      const data = await $fetch<JobsResponse>('/api/jobs', { params, signal: controller.signal, timeout: 20000 })
      if (requestId !== latestRequest) throw new SupersededRequest()

      jobs.value = options.append ? [...jobs.value, ...data.jobs] : data.jobs
      total.value = data.total
      page.value = data.page
      return data
    }
    catch (e: any) {
      if (requestId !== latestRequest || e instanceof SupersededRequest) throw new SupersededRequest()
      error.value = e?.name === 'TimeoutError' || /timeout/i.test(e?.message || '')
        ? 'The job list took too long to load.'
        : e?.data?.statusMessage || e?.data?.message || e?.message || 'Failed to fetch jobs'
      throw e
    }
    finally {
      if (requestId === latestRequest) {
        loading.value = false
        inFlight = null
      }
    }
  }

  async function getJob(id: number): Promise<Job> {
    loading.value = true
    error.value = null

    try {
      return await $fetch<Job>(`/api/jobs/${id}`)
    }
    catch (e: any) {
      error.value = e.data?.message || e.message || 'Failed to fetch job'
      throw e
    }
    finally {
      loading.value = false
    }
  }

  async function updateJobStatus(id: number, status: JobStatus): Promise<Job> {
    error.value = null

    try {
      const updated = await $fetch<Job>(`/api/jobs/${id}`, {
        method: 'PATCH',
        body: { status },
      })

      const idx = jobs.value.findIndex(j => j.id === id)
      if (idx !== -1) {
        jobs.value[idx] = updated
      }

      return updated
    }
    catch (e: any) {
      error.value = e.data?.message || e.message || 'Failed to update job status'
      throw e
    }
  }

  /** Runs the jobs:search task now (POST /api/jobs/search). Throws with the server's message on failure. */
  async function triggerSearch(): Promise<JobSearchResult> {
    return await $fetch<JobSearchResult>('/api/jobs/search', { method: 'POST' })
  }

  async function scoreJobs(jobIds: number[]): Promise<Job[]> {
    loading.value = true
    error.value = null

    try {
      const scored = await $fetch<Job[]>('/api/jobs/match', {
        method: 'POST',
        body: { jobIds },
      })

      for (const scoredJob of scored) {
        const idx = jobs.value.findIndex(j => j.id === scoredJob.id)
        if (idx !== -1) {
          jobs.value[idx] = scoredJob
        }
      }

      return scored
    }
    catch (e: any) {
      error.value = e.data?.message || e.message || 'Failed to score jobs'
      throw e
    }
    finally {
      loading.value = false
    }
  }

  return {
    jobs,
    total,
    page,
    loading,
    error,
    fetchJobs,
    getJob,
    updateJobStatus,
    triggerSearch,
    scoreJobs,
  }
}
