import type { JobSourceAdapter, NormalizedJob, SearchParams } from './types'
import { SourceUnavailable } from './types'
import { fetchJson, HttpError } from './http'

// JSearch on RapidAPI. On 2026-11-01 the configured key answered 403
// {"message":"You are not subscribed to this API."}: the key has no active JSearch
// subscription. The run records the source as unavailable instead of failing.
export const jsearchAdapter: JobSourceAdapter = {
  name: 'jsearch',

  async search(params: SearchParams): Promise<NormalizedJob[]> {
    const config = useRuntimeConfig()
    if (!config.jsearchApiKey) {
      throw new SourceUnavailable('jsearch', 'JSearch API key is not configured (NUXT_JSEARCH_API_KEY)')
    }

    const query = new URLSearchParams({
      query: [...params.keywords.slice(0, 3), ...(params.remoteOnly ? ['remote'] : [])].join(' '),
      page: '1',
      num_pages: '1',
      date_posted: 'week',
      ...(params.remoteOnly ? { remote_jobs_only: 'true' } : {}),
    })

    let response: any
    try {
      response = await fetchJson(`https://jsearch.p.rapidapi.com/search?${query}`, {
        headers: { 'X-RapidAPI-Key': config.jsearchApiKey, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' },
      })
    }
    catch (e) {
      if (e instanceof HttpError && e.status === 403) {
        throw new SourceUnavailable('jsearch', `The RapidAPI key has no active JSearch subscription (HTTP 403: ${e.body.slice(0, 80)})`)
      }
      if (e instanceof HttpError && e.status === 401) {
        throw new SourceUnavailable('jsearch', 'RapidAPI rejected the JSearch key (HTTP 401)')
      }
      throw e
    }

    return (response?.data ?? []).filter((job: any) => job.job_id).map((job: any): NormalizedJob => ({
      source: 'jsearch',
      sourceId: String(job.job_id),
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
  },
}
