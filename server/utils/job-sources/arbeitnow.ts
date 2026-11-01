import type { JobSourceAdapter, NormalizedJob, SearchParams } from './types'
import { isSoftwareRoleTitle, isUsEligible, matchesAnyTerm, titleMatchesKeywords } from './filters'
import { fetchJson } from './http'

// Arbeitnow lists mostly European jobs; only US-eligible remote listings pass the filter.
export const arbeitnowAdapter: JobSourceAdapter = {
  name: 'arbeitnow',

  async search(params: SearchParams): Promise<NormalizedJob[]> {
    const response = await fetchJson<any>(`https://www.arbeitnow.com/api/job-board-api${params.remoteOnly ? '?remote=true' : ''}`)
    const seen = new Set<string>()
    return (response?.data ?? [])
      .filter((job: any) => job.slug && !seen.has(job.slug) && seen.add(job.slug))
      .filter((job: any) => titleMatchesKeywords(job.title ?? '', params.keywords))
      .filter((job: any) => isSoftwareRoleTitle(job.title ?? ''))
      .filter((job: any) => !matchesAnyTerm(job.title ?? '', params.excludedKeywords))
      .filter((job: any) => isUsEligible([job.location]))
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
  },
}
