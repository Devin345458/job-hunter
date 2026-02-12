import type { JobSourceAdapter, NormalizedJob, SearchParams } from './types'

export const jsearchAdapter: JobSourceAdapter = {
  name: 'jsearch',

  async search(params: SearchParams): Promise<NormalizedJob[]> {
    const config = useRuntimeConfig()
    if (!config.jsearchApiKey) {
      console.warn('JSearch API key not configured, skipping')
      return []
    }

    const query = [
      ...params.keywords,
      ...(params.remoteOnly ? ['remote'] : []),
    ].join(' ')

    try {
      const response = await $fetch<any>('https://jsearch.p.rapidapi.com/search', {
        headers: {
          'X-RapidAPI-Key': config.jsearchApiKey,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
        },
        query: {
          query,
          page: '1',
          num_pages: '1',
          date_posted: 'week',
          remote_jobs_only: params.remoteOnly ? 'true' : undefined,
        },
      })

      if (!response?.data) return []

      return response.data.map((job: any): NormalizedJob => ({
        source: 'jsearch',
        sourceId: job.job_id || String(Date.now()),
        title: job.job_title || 'Unknown',
        company: job.employer_name || 'Unknown',
        companyUrl: job.employer_website || undefined,
        location: job.job_city
          ? `${job.job_city}, ${job.job_state}, ${job.job_country}`
          : job.job_country,
        remoteType: job.job_is_remote ? 'remote' : undefined,
        salaryMin: job.job_min_salary || undefined,
        salaryMax: job.job_max_salary || undefined,
        salaryCurrency: job.job_salary_currency || 'USD',
        description: job.job_description || '',
        url: job.job_apply_link || job.job_google_link,
        tags: job.job_required_skills || [],
        expiresAt: job.job_offer_expiration_datetime_utc || undefined,
      }))
    } catch (error) {
      console.error('JSearch API error:', error)
      return []
    }
  },
}
