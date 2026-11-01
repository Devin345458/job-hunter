import type { JobSourceAdapter, NormalizedJob, SearchParams } from './types'
import { searchBoards } from './board-runner'
import { looksRemote, sanitizeHtml } from './filters'
import { fetchJson } from './http'

interface AshbyComponent {
  compensationType: string
  interval: string
  currencyCode: string | null
  minValue: number | null
  maxValue: number | null
}

interface AshbyJob {
  id: string
  title: string
  location?: string | null
  secondaryLocations?: Array<{ location?: string | null }>
  isListed?: boolean
  isRemote?: boolean | null
  workplaceType?: string | null
  employmentType?: string | null
  publishedAt?: string
  jobUrl: string
  applyUrl: string
  descriptionHtml?: string
  department?: string
  team?: string
  address?: { postalAddress?: { addressCountry?: string | null } } | null
  compensation?: {
    compensationTierSummary?: string | null
    scrapeableCompensationSalarySummary?: string | null
    summaryComponents?: AshbyComponent[]
  } | null
}

/** Yearly base salary range from Ashby's structured compensation, when the employer publishes one. */
function yearlySalary(job: AshbyJob) {
  const salary = (job.compensation?.summaryComponents ?? [])
    .filter(c => c.compensationType === 'Salary' && c.interval === '1 YEAR' && (c.minValue != null || c.maxValue != null))
  if (!salary.length) return null
  const mins = salary.map(c => c.minValue).filter((v): v is number => v != null)
  const maxs = salary.map(c => c.maxValue).filter((v): v is number => v != null)
  return {
    min: mins.length ? Math.min(...mins) : undefined,
    max: maxs.length ? Math.max(...maxs) : undefined,
    currency: salary[0]!.currencyCode ?? undefined,
  }
}

// Public Ashby posting API with compensation included.
export const ashbyAdapter: JobSourceAdapter = {
  name: 'ashby',

  search(params: SearchParams): Promise<NormalizedJob[]> {
    return searchBoards('ashby', params, async (board) => {
      const data = await fetchJson<{ jobs: AshbyJob[] }>(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.token)}?includeCompensation=true`)
      return (data.jobs ?? []).filter(j => j.isListed !== false).map((j) => {
        const location = j.location?.trim() || undefined
        const secondary = (j.secondaryLocations ?? []).map(s => s.location).filter((l): l is string => !!l)
        const remote = j.isRemote === true || /remote/i.test(j.workplaceType ?? '') || looksRemote(location, ...secondary)
        const pay = yearlySalary(j)
        const country = j.address?.postalAddress?.addressCountry
        return {
          job: {
            source: 'ashby',
            sourceId: `${board.token}:${j.id}`,
            title: j.title.trim(),
            company: board.company,
            location: [location, ...secondary].filter(Boolean).join('; ') || undefined,
            remoteType: remote ? 'remote' : /hybrid/i.test(j.workplaceType ?? '') ? 'hybrid' : /onsite/i.test(j.workplaceType ?? '') ? 'onsite' : undefined,
            salaryMin: pay?.min,
            salaryMax: pay?.max,
            salaryCurrency: pay?.currency,
            description: sanitizeHtml(j.descriptionHtml ?? ''),
            url: j.jobUrl,
            applyUrl: j.applyUrl,
            tags: [j.department, j.team].filter((t): t is string => !!t),
            atsType: 'ashby',
            atsMeta: {
              board: board.token,
              postingId: j.id,
              compensationSummary: j.compensation?.compensationTierSummary || j.compensation?.scrapeableCompensationSalarySummary || null,
            },
          },
          publishedAt: j.publishedAt ?? null,
          locations: [location, ...secondary, country === 'USA' || country === 'US' || country === 'United States' ? 'United States' : country].filter((l): l is string => !!l),
          remote,
          fullTime: !['Intern', 'PartTime', 'Temporary'].includes(j.employmentType ?? ''),
        }
      })
    })
  },
}
