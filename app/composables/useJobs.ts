import type { InferSelectModel } from 'drizzle-orm'
import type { jobs } from '~~/server/db/schema'

export type Job = InferSelectModel<typeof jobs>

/** A job's newest application, as GET /api/jobs and GET /api/jobs/:id return it (server/utils/job-list.ts). */
export interface JobApplicationRef {
  id: number
  status: string
  prepareFailed: boolean
}

/** The columns GET /api/jobs returns for each card (server/api/jobs/index.get.ts). The detail page loads the rest. */
export type JobListItem = Pick<Job,
  | 'id' | 'source' | 'title' | 'company' | 'location' | 'remoteType' | 'salaryMin' | 'salaryMax' | 'salaryCurrency'
  | 'totalCompEstimate' | 'matchScore' | 'status' | 'tags' | 'applyUrl' | 'atsType' | 'isSandbox' | 'foundAt'> & {
  application?: JobApplicationRef | null
  /** How many postings of this company and title the card stands for (1 for most). */
  postingCount?: number
  /** Every posting the card stands for, this one first. Empty when it stands for one. */
  postings?: Array<{ id: number; location: string | null }>
}

/** A job's own status, plus in_review: a filter for jobs whose application is under way. */
export type JobStatus = 'new' | 'reviewed' | 'applied' | 'rejected' | 'expired' | 'in_review'
export type RemoteType = 'remote' | 'hybrid' | 'onsite'

export interface JobFilters {
  status?: JobStatus | JobStatus[]
  search?: string
  remoteType?: RemoteType
  minScore?: number
  maxScore?: number
  /** score (default): best match first, unscored last. date: newest first. */
  sort?: JobSort
  page?: number
  limit?: number
}

export type JobSort = 'score' | 'date'

export interface JobsResponse {
  jobs: JobListItem[]
  total: number
  /** Postings behind the cards; more than total when one card stands for several postings. */
  totalPostings?: number
  page: number
  limit: number
}

/** Result of POST /api/jobs/search: the jobs:search run it recorded in pipeline_runs. */
export interface JobSearchResult {
  runId: number | null
  status: 'succeeded' | 'failed' | 'skipped' | 'queued'
  /** True when the search still waits in the job queue (or still runs) after a minute; message says so. */
  queued?: boolean
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

/** How long a list request may take before the page gives up and offers a retry. */
const LIST_TIMEOUT_MS = 20000

export function useJobs() {
  const jobs = ref<JobListItem[]>([])
  const total = ref(0)
  const totalPostings = ref(0)
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
    let timedOut = false

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
      if (filters?.sort) params.sortBy = filters.sort

      // A request that never finishes would leave the progress bar up for good; give up after
      // 20 seconds and show the error with a retry instead. ofetch ignores its timeout option
      // when a signal is passed, so the timeout aborts the same controller.
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, LIST_TIMEOUT_MS)
      let data: JobsResponse
      try {
        data = await $fetch<JobsResponse>('/api/jobs', { params, signal: controller.signal })
      }
      finally {
        clearTimeout(timer)
      }
      if (requestId !== latestRequest) throw new SupersededRequest()

      jobs.value = options.append ? [...jobs.value, ...data.jobs] : data.jobs
      total.value = data.total
      totalPostings.value = data.totalPostings ?? data.total
      page.value = data.page
      return data
    }
    catch (e: any) {
      if (requestId !== latestRequest || e instanceof SupersededRequest) throw new SupersededRequest()
      error.value = timedOut
        ? 'The job list took more than 20 seconds to load. Try again.'
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

  /** Queues the jobs:search task and waits for it (POST /api/jobs/search). Throws with the server's message on failure. */
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
    totalPostings,
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
