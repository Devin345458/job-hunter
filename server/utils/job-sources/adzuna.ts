import type { JobSourceAdapter, NormalizedJob, SearchParams } from './types'

export const adzunaAdapter: JobSourceAdapter = {
  name: 'adzuna',

  async search(params: SearchParams): Promise<NormalizedJob[]> {
    const config = useRuntimeConfig()
    if (!config.adzunaAppId || !config.adzunaApiKey) {
      console.warn('Adzuna API credentials not configured, skipping')
      return []
    }

    // Adzuna uses OR syntax between keyword phrases
    // Wrap multi-word keywords in quotes for phrase matching
    const what = params.keywords
      .map(k => k.includes(' ') ? `"${k}"` : k)
      .join(' OR ')
    const whatExclude = params.excludedKeywords?.join(' ')

    // Search US by default, can expand to other countries
    const country = 'us'

    try {
      const query: Record<string, any> = {
        app_id: config.adzunaAppId,
        app_key: config.adzunaApiKey,
        what,
        full_time: '1',
        results_per_page: '50',
        sort_by: 'date',
      }
      if (whatExclude) query.what_exclude = whatExclude
      if (params.salaryMin) query.salary_min = params.salaryMin

      const response = await $fetch<any>(
        `https://api.adzuna.com/v1/api/jobs/${country}/search/1`,
        { query },
      )

      if (!response?.results) return []

      return response.results.map((job: any): NormalizedJob => ({
        source: 'adzuna',
        sourceId: String(job.id),
        title: job.title || 'Unknown',
        company: job.company?.display_name || 'Unknown',
        companyUrl: undefined,
        location: job.location?.display_name,
        remoteType: detectRemoteType(job.title, job.description),
        salaryMin: job.salary_min || undefined,
        salaryMax: job.salary_max || undefined,
        salaryCurrency: 'USD',
        description: job.description || '',
        url: job.redirect_url,
        tags: job.category?.tag ? [job.category.tag] : [],
      }))
    } catch (error) {
      console.error('Adzuna API error:', error)
      return []
    }
  },
}

function detectRemoteType(title: string, description: string): 'remote' | 'hybrid' | 'onsite' | undefined {
  const text = `${title} ${description}`.toLowerCase()
  if (text.includes('remote')) return 'remote'
  if (text.includes('hybrid')) return 'hybrid'
  return undefined
}
