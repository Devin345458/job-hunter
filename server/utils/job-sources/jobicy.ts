import type { JobSourceAdapter, NormalizedJob, SearchParams } from './types'

export const jobicyAdapter: JobSourceAdapter = {
  name: 'jobicy',

  async search(params: SearchParams): Promise<NormalizedJob[]> {
    try {
      // Fetch jobs without tag filter — Jobicy's tag param is case-sensitive
      // and returns 403 for unrecognized values. Filter client-side instead.
      const response = await $fetch<any>('https://jobicy.com/api/v2/remote-jobs', {
        query: {
          count: 5,
          geo: 'usa',
          industry: 'engineering'
        },
        headers: { 'User-Agent': 'JobHunter/1.0' },
      })

      if (!response?.jobs) return []

      const lowerKeywords = params.keywords.map(k => k.toLowerCase())
      const lowerExcluded = (params.excludedKeywords || []).map(k => k.toLowerCase())

      return response.jobs
        .filter((job: any) => {
          const text = `${job.jobTitle} ${job.companyName} ${job.jobExcerpt || ''} ${(job.jobIndustry || []).join(' ')}`.toLowerCase()

          const matchesKeyword = lowerKeywords.some(k => text.includes(k))
          if (!matchesKeyword) return false

          if (lowerExcluded.some(k => text.includes(k))) return false

          if (params.salaryMin && job.salaryMin) {
            if (job.salaryMin < params.salaryMin) return false
          }

          return true
        })
        .map((job: any): NormalizedJob => ({
          source: 'jobicy',
          sourceId: String(job.id),
          title: job.jobTitle || 'Unknown',
          company: job.companyName || 'Unknown',
          location: job.jobGeo || 'Remote',
          remoteType: 'remote',
          salaryMin: job.salaryMin || undefined,
          salaryMax: job.salaryMax || undefined,
          salaryCurrency: job.salaryCurrency || 'USD',
          description: job.jobDescription || job.jobExcerpt || '',
          url: job.url || `https://jobicy.com/jobs/${job.id}`,
          tags: Array.isArray(job.jobIndustry) ? job.jobIndustry : [],
        }))
    } catch (error) {
      console.error('Jobicy API error:', error)
      return []
    }
  },
}
