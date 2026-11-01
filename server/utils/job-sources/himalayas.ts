import type { JobSourceAdapter, NormalizedJob, SearchParams } from './types'
import { isSoftwareRoleTitle, isUsEligible, matchesAnyTerm, payBelow, titleMatchesKeywords } from './filters'
import { fetchJson } from './http'

// Himalayas public API. Since 2026 the response is { jobs, nextCursor, totalCount }
// instead of a bare array, which broke the old adapter. applicationLink points to the
// Himalayas page, not the employer form.

interface HimalayasJob {
  title: string
  excerpt?: string
  companyName?: string
  employmentType?: string
  minSalary?: number | null
  maxSalary?: number | null
  salaryPeriod?: string | null
  currency?: string | null
  locationRestrictions?: string[]
  categories?: string[]
  description?: string
  pubDate?: number | string
  applicationLink?: string
  guid?: string
}

export const himalayasAdapter: JobSourceAdapter = {
  name: 'himalayas',

  async search(params: SearchParams): Promise<NormalizedJob[]> {
    const all: HimalayasJob[] = []
    for (let page = 0; page < 3; page++) {
      const data = await fetchJson<{ jobs?: HimalayasJob[] }>(`https://himalayas.app/jobs/api?limit=20&offset=${page * 20}`)
      if (!data.jobs?.length) break
      all.push(...data.jobs)
    }
    return all
      .filter(j => titleMatchesKeywords(j.title, params.keywords))
      .filter(j => isSoftwareRoleTitle(j.title))
      .filter(j => !matchesAnyTerm(j.title, params.excludedKeywords))
      .filter(j => !j.locationRestrictions?.length || isUsEligible(j.locationRestrictions))
      .filter(j => !/intern|part/i.test(j.employmentType ?? ''))
      .map((j): NormalizedJob => {
        const yearly = !j.salaryPeriod || /year|annual/i.test(j.salaryPeriod)
        return {
          source: 'himalayas',
          sourceId: j.guid || j.applicationLink || j.title,
          title: j.title || 'Unknown',
          company: j.companyName || 'Unknown',
          location: (j.locationRestrictions ?? []).length > 6 ? 'Remote (many countries, including the United States)' : (j.locationRestrictions ?? []).join(', ') || 'Remote',
          remoteType: 'remote',
          salaryMin: yearly ? j.minSalary || undefined : undefined,
          salaryMax: yearly ? j.maxSalary || undefined : undefined,
          salaryCurrency: j.currency || 'USD',
          description: j.description || j.excerpt || '',
          url: j.applicationLink || j.guid,
          tags: j.categories || [],
        }
      })
      .filter(j => !payBelow(params.salaryMin, j.salaryMin, j.salaryMax))
  },
}
