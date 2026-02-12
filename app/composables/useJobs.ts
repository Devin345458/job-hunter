import type { InferSelectModel } from 'drizzle-orm'
import type { jobs } from '~~/server/db/schema'

export type Job = InferSelectModel<typeof jobs>

export type JobStatus = 'new' | 'reviewed' | 'applied' | 'rejected' | 'expired'
export type RemoteType = 'remote' | 'hybrid' | 'onsite'

export interface JobFilters {
  status?: JobStatus | JobStatus[]
  search?: string
  remoteType?: RemoteType
  minScore?: number
  page?: number
  limit?: number
}

export interface JobsResponse {
  jobs: Job[]
  total: number
  page: number
  limit: number
}

export function useJobs() {
  const jobs = ref<Job[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchJobs(filters?: JobFilters): Promise<JobsResponse> {
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
      if (filters?.page) params.page = filters.page
      if (filters?.limit) params.limit = filters.limit

      const data = await $fetch<JobsResponse>('/api/jobs', { params })
      jobs.value = data.jobs
      return data
    }
    catch (e: any) {
      error.value = e.data?.message || e.message || 'Failed to fetch jobs'
      throw e
    }
    finally {
      loading.value = false
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

  async function triggerSearch(): Promise<{ message: string; jobsFound: number }> {
    loading.value = true
    error.value = null

    try {
      return await $fetch<{ message: string; jobsFound: number }>('/api/jobs/search', {
        method: 'POST',
      })
    }
    catch (e: any) {
      error.value = e.data?.message || e.message || 'Failed to trigger search'
      throw e
    }
    finally {
      loading.value = false
    }
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
    loading,
    error,
    fetchJobs,
    getJob,
    updateJobStatus,
    triggerSearch,
    scoreJobs,
  }
}
