import type { JobSourceAdapter, NormalizedJob, SearchParams } from './types'
import { isSoftwareRoleTitle, isUsEligible, matchesAnyTerm, payBelow, titleMatchesKeywords } from './filters'
import { fetchJson } from './http'

export const remoteokAdapter: JobSourceAdapter = {
  name: 'remoteok',

  async search(params: SearchParams): Promise<NormalizedJob[]> {
    // RemoteOK returns every listing in one call; the first element is legal text.
    const response = await fetchJson<any[]>('https://remoteok.com/api')
    if (!Array.isArray(response)) return []

    return response
      .filter((job: any) => job.id && job.position)
      .filter((job: any) => titleMatchesKeywords(job.position, params.keywords))
      .filter((job: any) => isSoftwareRoleTitle(job.position))
      .filter((job: any) => !matchesAnyTerm(job.position, params.excludedKeywords))
      .filter((job: any) => !job.location || isUsEligible([job.location]))
      .slice(0, 50)
      .map((job: any): NormalizedJob => ({
        source: 'remoteok',
        sourceId: String(job.id),
        title: job.position || 'Unknown',
        company: job.company || 'Unknown',
        location: job.location || 'Remote',
        remoteType: 'remote',
        salaryMin: job.salary_min > 0 ? job.salary_min : undefined,
        salaryMax: job.salary_max > 0 ? job.salary_max : undefined,
        salaryCurrency: job.salary_min > 0 ? 'USD' : undefined,
        description: job.description || '',
        url: job.apply_url || job.url || `https://remoteok.com/remote-jobs/${job.slug}`,
        tags: job.tags || [],
      }))
      .filter(j => !payBelow(params.salaryMin, j.salaryMin, j.salaryMax))
  },
}
