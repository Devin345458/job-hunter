import type { JobSourceAdapter, NormalizedJob, SearchParams } from './types'

export const arbeitnowAdapter: JobSourceAdapter = {
  name: 'arbeitnow',

  async search(params: SearchParams): Promise<NormalizedJob[]> {
    try {
      const allJobs: any[] = []

      // Search with each keyword (Arbeitnow supports `search` param)
      const searchTerms = params.keywords.slice(0, 3)

      for (const term of searchTerms) {
        const query: Record<string, any> = {
          search: term,
          page: 1,
        }
        if (params.remoteOnly) query.remote = 'true'

        const response = await $fetch<any>('https://www.arbeitnow.com/api/job-board-api', { query })

        if (response?.data) {
          allJobs.push(...response.data)
        }
      }

      // Deduplicate by slug
      const seenSlugs = new Set<string>()
      const uniqueJobs = allJobs.filter((job: any) => {
        if (seenSlugs.has(job.slug)) return false
        seenSlugs.add(job.slug)
        return true
      })

      const lowerExcluded = (params.excludedKeywords || []).map(k => k.toLowerCase())

      return uniqueJobs
        .filter((job: any) => {
          const text = `${job.title} ${job.company_name} ${(job.tags || []).join(' ')}`.toLowerCase()

          if (lowerExcluded.some(k => text.includes(k))) return false

          return true
        })
        .slice(0, 50)
        .map((job: any): NormalizedJob => ({
          source: 'arbeitnow',
          sourceId: job.slug,
          title: job.title || 'Unknown',
          company: job.company_name || 'Unknown',
          location: job.location || 'Unknown',
          remoteType: job.remote ? 'remote' : 'onsite',
          description: job.description || '',
          url: job.url || `https://www.arbeitnow.com/jobs/${job.slug}`,
          tags: job.tags || [],
        }))
    } catch (error) {
      console.error('Arbeitnow API error:', error)
      return []
    }
  },
}
