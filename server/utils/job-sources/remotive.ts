import type { JobSourceAdapter, NormalizedJob, SearchParams } from './types'

export const remotiveAdapter: JobSourceAdapter = {
  name: 'remotive',

  async search(params: SearchParams): Promise<NormalizedJob[]> {
    try {
      // Extract individual search terms from keywords (Remotive doesn't handle multi-word well)
      const searchTerms = [...new Set(
        params.keywords
          .flatMap(k => k.split(/\s+/))
          .filter(w => w.length > 3)
          .slice(0, 3),
      )]

      const allJobs: any[] = []
      const seenIds = new Set<string>()

      for (const term of searchTerms) {
        const response = await $fetch<any>('https://remotive.com/api/remote-jobs', {
          query: {
            search: term,
            limit: 25,
          },
        })

        if (response?.jobs) {
          for (const job of response.jobs) {
            const id = String(job.id)
            if (!seenIds.has(id)) {
              seenIds.add(id)
              allJobs.push(job)
            }
          }
        }
      }

      return allJobs
        .filter((job: any) => {
          // Filter by salary if specified
          if (params.salaryMin && job.salary) {
            const salaryNum = parseSalaryString(job.salary)
            if (salaryNum && salaryNum < params.salaryMin) return false
          }
          return true
        })
        .map((job: any): NormalizedJob => {
          const salary = parseSalaryRange(job.salary)
          return {
            source: 'remotive',
            sourceId: String(job.id),
            title: job.title || 'Unknown',
            company: job.company_name || 'Unknown',
            companyUrl: job.company_logo_url ? undefined : undefined,
            location: job.candidate_required_location || 'Worldwide',
            remoteType: 'remote',
            salaryMin: salary?.min,
            salaryMax: salary?.max,
            salaryCurrency: 'USD',
            description: job.description || '',
            url: job.url,
            tags: job.tags || [],
          }
        })
    } catch (error) {
      console.error('Remotive API error:', error)
      return []
    }
  },
}

function parseSalaryString(salary: string): number | null {
  if (!salary) return null
  const match = salary.match(/[\d,]+/)
  if (!match) return null
  return parseInt(match[0].replace(/,/g, ''))
}

function parseSalaryRange(salary: string): { min?: number, max?: number } | null {
  if (!salary) return null
  const numbers = salary.match(/[\d,]+/g)
  if (!numbers) return null
  const parsed = numbers.map(n => parseInt(n.replace(/,/g, '')))
  return {
    min: parsed[0] || undefined,
    max: parsed[1] || parsed[0] || undefined,
  }
}
