import type { JobSourceAdapter, NormalizedJob, SearchParams } from './types'

export const himalayasAdapter: JobSourceAdapter = {
  name: 'himalayas',

  async search(params: SearchParams): Promise<NormalizedJob[]> {
    try {
      const allJobs: any[] = []
      const maxPages = 3 // 20 per page, 60 max

      for (let page = 0; page < maxPages; page++) {
        const response = await $fetch<any[]>('https://himalayas.app/jobs/api', {
          query: {
            limit: 20,
            offset: page * 20,
          },
        })

        if (!Array.isArray(response) || response.length === 0) break
        allJobs.push(...response)
      }

      const lowerKeywords = params.keywords.map(k => k.toLowerCase())
      const lowerExcluded = (params.excludedKeywords || []).map(k => k.toLowerCase())

      return allJobs
        .filter((job: any) => {
          const text = `${job.title} ${job.companyName} ${(job.skills || []).join(' ')} ${job.excerpt || ''}`.toLowerCase()

          const matchesKeyword = lowerKeywords.some(k => text.includes(k))
          if (!matchesKeyword) return false

          if (lowerExcluded.some(k => text.includes(k))) return false

          // Filter by salary
          if (params.salaryMin && job.minSalary) {
            if (job.minSalary < params.salaryMin) return false
          }

          return true
        })
        .map((job: any): NormalizedJob => ({
          source: 'himalayas',
          sourceId: job.slug || job.title,
          title: job.title || 'Unknown',
          company: job.companyName || 'Unknown',
          location: (job.locationRestrictions || []).join(', ') || 'Remote',
          remoteType: 'remote',
          salaryMin: job.minSalary || undefined,
          salaryMax: job.maxSalary || undefined,
          salaryCurrency: job.currency || 'USD',
          description: job.excerpt || '',
          url: job.applicationLink || `https://himalayas.app/jobs/${job.slug}`,
          tags: job.skills || [],
        }))
    } catch (error) {
      console.error('Himalayas API error:', error)
      return []
    }
  },
}
