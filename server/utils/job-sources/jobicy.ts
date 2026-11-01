import type { JobSourceAdapter, NormalizedJob, SearchParams } from './types'
import { isSoftwareRoleTitle, matchesAnyTerm, payBelow, titleMatchesKeywords } from './filters'
import { fetchJson } from './http'

export const jobicyAdapter: JobSourceAdapter = {
  name: 'jobicy',

  async search(params: SearchParams): Promise<NormalizedJob[]> {
    // Jobicy's tag param is case-sensitive and returns 403 for unknown values, so filter in code.
    const response = await fetchJson<any>('https://jobicy.com/api/v2/remote-jobs?count=50&geo=usa&industry=engineering')
    return (response?.jobs ?? [])
      .filter((job: any) => titleMatchesKeywords(job.jobTitle ?? '', params.keywords))
      .filter((job: any) => isSoftwareRoleTitle(job.jobTitle ?? ''))
      .filter((job: any) => !matchesAnyTerm(job.jobTitle ?? '', params.excludedKeywords))
      .map((job: any): NormalizedJob => ({
        source: 'jobicy',
        sourceId: String(job.id),
        title: job.jobTitle || 'Unknown',
        company: job.companyName || 'Unknown',
        location: job.jobGeo || 'Remote',
        remoteType: 'remote',
        salaryMin: job.annualSalaryMin || job.salaryMin || undefined,
        salaryMax: job.annualSalaryMax || job.salaryMax || undefined,
        salaryCurrency: job.salaryCurrency || 'USD',
        description: job.jobDescription || job.jobExcerpt || '',
        url: job.url || `https://jobicy.com/jobs/${job.id}`,
        tags: Array.isArray(job.jobIndustry) ? job.jobIndustry : [],
      }))
      .filter((j: NormalizedJob) => !payBelow(params.salaryMin, j.salaryMin, j.salaryMax))
  },
}
