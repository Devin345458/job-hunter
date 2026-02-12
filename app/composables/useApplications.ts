import type { InferSelectModel } from 'drizzle-orm'
import type { applications, jobs } from '~~/server/db/schema'

export type Application = InferSelectModel<typeof applications>
export type ApplicationWithJob = Application & { job: InferSelectModel<typeof jobs> }

export type ApplicationStatus =
  | 'draft'
  | 'ready'
  | 'submitted'
  | 'response_received'
  | 'interviewing'
  | 'rejected'
  | 'offer'

export interface ApplicationFilters {
  status?: ApplicationStatus | ApplicationStatus[]
  search?: string
  page?: number
  limit?: number
}

export interface ApplicationsResponse {
  applications: ApplicationWithJob[]
  total: number
  page: number
  limit: number
}

export function useApplications() {
  const applications = ref<ApplicationWithJob[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchApplications(filters?: ApplicationFilters): Promise<ApplicationsResponse> {
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
      if (filters?.page) params.page = filters.page
      if (filters?.limit) params.limit = filters.limit

      const data = await $fetch<ApplicationsResponse>('/api/applications', { params })
      applications.value = data.applications
      return data
    }
    catch (e: any) {
      error.value = e.data?.message || e.message || 'Failed to fetch applications'
      throw e
    }
    finally {
      loading.value = false
    }
  }

  async function getApplication(id: number): Promise<ApplicationWithJob> {
    loading.value = true
    error.value = null

    try {
      return await $fetch<ApplicationWithJob>(`/api/applications/${id}`)
    }
    catch (e: any) {
      error.value = e.data?.message || e.message || 'Failed to fetch application'
      throw e
    }
    finally {
      loading.value = false
    }
  }

  async function createApplication(jobId: number): Promise<ApplicationWithJob> {
    error.value = null

    try {
      const created = await $fetch<ApplicationWithJob>(`/api/applications/${jobId}`, {
        method: 'POST',
      })
      applications.value.unshift(created)
      return created
    }
    catch (e: any) {
      error.value = e.data?.message || e.message || 'Failed to create application'
      throw e
    }
  }

  async function updateApplication(
    id: number,
    data: Partial<Pick<Application, 'status' | 'coverLetter' | 'notes' | 'tailoredResumeJson' | 'tailoringNotes'>>,
  ): Promise<ApplicationWithJob> {
    error.value = null

    try {
      const updated = await $fetch<ApplicationWithJob>(`/api/applications/${id}`, {
        method: 'PATCH',
        body: data,
      })

      const idx = applications.value.findIndex(a => a.id === id)
      if (idx !== -1) {
        applications.value[idx] = updated
      }

      return updated
    }
    catch (e: any) {
      error.value = e.data?.message || e.message || 'Failed to update application'
      throw e
    }
  }

  return {
    applications,
    loading,
    error,
    fetchApplications,
    getApplication,
    createApplication,
    updateApplication,
  }
}
