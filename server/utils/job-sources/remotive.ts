import type { PullContext, PullResult, RawListing, SearchParams } from './types'
import { fetchJson } from './http'
import { aggregator, toIso, toTime, windowStart } from './paging'

// Remotive public API: https://remotive.com/api/remote-jobs (all listings are remote).
// The employer's apply link sits behind a Remotive login, so enrichment finds the employer
// form through the company's ATS board instead.
//
// Terms (github.com/remotive-com/remote-jobs-api): "we advise max. 4 times a day", more than 2
// requests a minute are blocked, jobs are delayed by 24 hours, and Remotive must be linked and
// named as the source. So: at most one pull every 6 hours, one request per pull (the API has no
// paging), and a 48-hour look back past the watermark for the delay. On 2026-11-03 the free API
// returned the same 10 jobs whatever the parameters said.

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

function toListing(j: RemotiveJob): RawListing {
  const salary = parseListedSalary(j.salary)
  return {
    job: {
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
    },
    postedAt: toIso(j.publication_date),
    locations: j.candidate_required_location ? [j.candidate_required_location] : [],
    remote: true,
    fullTime: !/intern|part[\s_-]?time|freelance/i.test(j.job_type ?? ''),
  }
}

export const remotiveAdapter = aggregator({
  name: 'remotive',
  minIntervalMinutes: 360,
  overlapHours: 48,

  async pull(_params: SearchParams, ctx: PullContext): Promise<PullResult> {
    const start = windowStart(ctx, '').getTime()
    const data = await fetchJson<{ jobs?: RemotiveJob[] }>('https://remotive.com/api/remote-jobs?category=software-dev', { cache: true })
    const listings = (data.jobs ?? [])
      .filter(j => !(toTime(j.publication_date) < start))
      .map(toListing)
    return {
      listings: listings.map(l => ({ ...l, scope: '' })),
      scopes: [{ scope: '', ok: true, found: listings.length, requests: 1, complete: true }],
    }
  },
})
