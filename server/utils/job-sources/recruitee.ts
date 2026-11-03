import type { JobSourceAdapter, NormalizedJob, PullContext, PullResult, SearchParams } from './types'
import type { Board } from './board-discovery'
import { type BoardPosting, pullBoards, searchBoards } from './board-runner'
import { sanitizeHtml } from './filters'
import { fetchJson } from './http'

// Recruitee careers site API (no key): <token>.recruitee.com/api/offers/. No curated list; boards
// come from apply links (<token>.recruitee.com/o/<slug>). updated_at is the change time.

interface RecruiteeOffer {
  id: number
  title: string
  status?: string
  company_name?: string
  location?: string
  country?: string
  country_code?: string
  remote?: boolean
  hybrid?: boolean
  on_site?: boolean
  careers_url?: string
  careers_apply_url?: string
  published_at?: string
  updated_at?: string
  employment_type_code?: string
  description?: string
  requirements?: string
  salary?: { min?: number | string | null; max?: number | string | null; period?: string | null; currency?: string | null }
  department?: string
}

/** "2026-11-02 10:18:50 UTC" as ISO. */
function utc(value: string | undefined): string | null {
  if (!value) return null
  const t = Date.parse(value.replace(' UTC', 'Z').replace(' ', 'T'))
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

async function fetchBoard(board: Board): Promise<BoardPosting[]> {
  const data = await fetchJson<{ offers?: RecruiteeOffer[] }>(`https://${encodeURIComponent(board.token)}.recruitee.com/api/offers/`, { cache: true })
  return (data.offers ?? []).filter(o => o.id && o.title && (!o.status || o.status === 'published')).map((o) => {
    const yearly = /year|annual/i.test(o.salary?.period ?? '')
    const num = (v: number | string | null | undefined) => (v == null || v === '' ? undefined : Number(v) || undefined)
    return {
      job: {
        source: 'recruitee',
        sourceId: `${board.token}:${o.id}`,
        title: o.title.trim(),
        company: o.company_name?.trim() || board.company,
        location: o.location || undefined,
        remoteType: o.remote ? 'remote' : o.hybrid ? 'hybrid' : o.on_site ? 'onsite' : undefined,
        salaryMin: yearly ? num(o.salary?.min) : undefined,
        salaryMax: yearly ? num(o.salary?.max) : undefined,
        salaryCurrency: yearly ? o.salary?.currency ?? undefined : undefined,
        description: sanitizeHtml([o.description, o.requirements].filter(Boolean).join('\n')),
        url: o.careers_url,
        applyUrl: o.careers_apply_url,
        tags: o.department ? [o.department] : [],
        atsType: 'recruitee',
        atsMeta: { board: board.token, postingId: o.id },
      },
      publishedAt: utc(o.published_at),
      changedAt: utc(o.updated_at) ?? utc(o.published_at),
      locations: [o.location ?? '', o.country_code === 'US' ? 'United States' : o.country ?? ''].filter(Boolean),
      remote: !!o.remote,
      fullTime: !/part|intern|temporary|freelance/i.test(o.employment_type_code ?? ''),
    }
  })
}

export const recruiteeAdapter: JobSourceAdapter = {
  name: 'recruitee',
  overlapHours: 2,
  search: (params: SearchParams): Promise<NormalizedJob[]> => searchBoards('recruitee', params, fetchBoard),
  pull: (_params: SearchParams, ctx: PullContext): Promise<PullResult> => pullBoards('recruitee', ctx, fetchBoard),
}
