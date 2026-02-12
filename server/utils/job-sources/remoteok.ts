import type { JobSourceAdapter, NormalizedJob, SearchParams } from './types'

export const remoteokAdapter: JobSourceAdapter = {
  name: 'remoteok',

  async search(params: SearchParams): Promise<NormalizedJob[]> {
    try {
      // RemoteOK returns all jobs in one call, no query params for filtering
      const response = await $fetch<any[]>('https://remoteok.com/api', {
        headers: { 'User-Agent': 'JobHunter/1.0' },
      })

      if (!Array.isArray(response)) return []

      // First element may be legal/TOS info, skip non-job entries
      const jobs = response.filter((item: any) => item.id && item.position)

      const lowerKeywords = params.keywords.map(k => k.toLowerCase())
      const lowerExcluded = (params.excludedKeywords || []).map(k => k.toLowerCase())

      return jobs
        .filter((job: any) => {
          const text = `${job.position} ${job.company} ${(job.tags || []).join(' ')} ${job.description || ''}`.toLowerCase()

          // Must match at least one keyword
          const matchesKeyword = lowerKeywords.some(k => text.includes(k))
          if (!matchesKeyword) return false

          // Must not match any excluded keyword
          if (lowerExcluded.some(k => text.includes(k))) return false

          // Filter by salary if specified
          if (params.salaryMin && job.salary_min && job.salary_min > 0) {
            if (job.salary_min < params.salaryMin) return false
          }

          return true
        })
        .slice(0, 50)
        .map((job: any): NormalizedJob => ({
          source: 'remoteok',
          sourceId: String(job.id),
          title: job.position || 'Unknown',
          company: job.company || 'Unknown',
          location: job.location || 'Remote',
          remoteType: 'remote',
          salaryMin: job.salary_min && job.salary_min > 0 ? job.salary_min : undefined,
          salaryMax: job.salary_max && job.salary_max > 0 ? job.salary_max : undefined,
          salaryCurrency: 'USD',
          description: job.description || '',
          url: job.url || `https://remoteok.com/remote-jobs/${job.slug}`,
          tags: job.tags || [],
        }))
    } catch (error) {
      console.error('RemoteOK API error:', error)
      return []
    }
  },
}
