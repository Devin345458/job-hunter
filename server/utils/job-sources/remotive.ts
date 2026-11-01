import type { JobSourceAdapter, NormalizedJob, SearchParams } from './types'
import { isSoftwareRoleTitle, isUsEligible, matchesAnyTerm, payBelow, titleMatchesKeywords } from './filters'
import { fetchJson } from './http'

// Remotive public API: https://remotive.com/api/remote-jobs (all listings are remote).
// The employer's apply link sits behind a Remotive login, so enrichment finds the employer
// form through the company's ATS board instead.

interface RemotiveJob {
  id: number
  url: string
  title: string
  company_name: string
  category?: string
  tags?: string[]
  job_type?: string
  publication_date?: string
  candidate_required_location?: string
  salary?: string
  description?: string
}

/** Yearly USD range from a free-text salary like "$150,000 - $180,000" or "$3.5k-$5k/month" (Remotive also uses an en dash there). Null when unclear. */
export function parseListedSalary(salary: string | undefined | null): { min?: number; max?: number } | null {
  if (!salary || !/\$|usd/i.test(salary)) return null
  const nums = [...salary.matchAll(/(\d+(?:[.,]\d+)*)\s*(k)?/gi)]
    .map(m => Number(m[1]!.replace(/,/g, '')) * (m[2] ? 1000 : 1))
    .filter(n => n > 0)
  if (!nums.length) return null
  const factor = /hour|hr\b/i.test(salary) ? 2080 : /month|mo\b/i.test(salary) ? 12 : 1
  const values = nums.map(n => n * factor)
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (max < 10000) return null
  return { min, max }
}

export const remotiveAdapter: JobSourceAdapter = {
  name: 'remotive',

  async search(params: SearchParams): Promise<NormalizedJob[]> {
    const data = await fetchJson<{ jobs?: RemotiveJob[] }>('https://remotive.com/api/remote-jobs?category=software-dev&limit=150')
    return (data.jobs ?? [])
      .filter(j => titleMatchesKeywords(j.title, params.keywords))
      .filter(j => isSoftwareRoleTitle(j.title))
      .filter(j => !matchesAnyTerm(j.title, params.excludedKeywords))
      .filter(j => isUsEligible([j.candidate_required_location]))
      .filter(j => !/intern|part[\s_-]?time|freelance/i.test(j.job_type ?? ''))
      .map((j): NormalizedJob => {
        const salary = parseListedSalary(j.salary)
        return {
          source: 'remotive',
          sourceId: String(j.id),
          title: j.title || 'Unknown',
          company: j.company_name || 'Unknown',
          location: j.candidate_required_location || 'Worldwide',
          remoteType: 'remote',
          salaryMin: salary?.min,
          salaryMax: salary?.max,
          salaryCurrency: salary ? 'USD' : undefined,
          description: j.description || '',
          url: j.url,
          tags: j.tags || [],
          atsMeta: j.salary ? { listedSalary: j.salary } : undefined,
        }
      })
      .filter(j => !payBelow(params.salaryMin, j.salaryMin, j.salaryMax))
  },
}
