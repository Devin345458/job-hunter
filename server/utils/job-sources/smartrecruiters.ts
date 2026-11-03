import type { JobSourceAdapter, NormalizedJob, PullContext, PullResult, SearchParams } from './types'
import type { Board } from './board-discovery'
import { type BoardPosting, countRequest, pullBoards, searchBoards } from './board-runner'
import { looksRemote } from './filters'
import { fetchJson } from './http'

// SmartRecruiters public posting API (no key needed for reads): api.smartrecruiters.com/v1/companies/<id>/postings,
// 100 per page by offset. The company identifier is case-sensitive. No curated list; boards come
// from apply links (jobs.smartrecruiters.com/<id>/<posting>). The list has no description; the
// posting page is server-rendered, so enrichment reads it there. releasedDate is the change time.

interface SrPosting {
  id: string
  name: string
  company?: { identifier?: string; name?: string }
  releasedDate?: string
  location?: { city?: string; region?: string; country?: string; remote?: boolean; hybrid?: boolean; fullLocation?: string }
  department?: { label?: string }
  typeOfEmployment?: { label?: string }
}

const PER_PAGE = 100

async function fetchBoard(board: Board): Promise<BoardPosting[]> {
  const all: SrPosting[] = []
  for (let offset = 0; offset < 5000; offset += PER_PAGE) {
    countRequest(board)
    const data = await fetchJson<{ totalFound?: number; content?: SrPosting[] }>(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board.token)}/postings?limit=${PER_PAGE}&offset=${offset}`,
      { cache: true, minIntervalMs: 300 },
    )
    const page = data.content ?? []
    all.push(...page)
    if (page.length < PER_PAGE || offset + PER_PAGE >= (data.totalFound ?? 0)) break
  }
  return all.filter(p => p.id && p.name).map((p) => {
    const loc = p.location ?? {}
    const place = loc.fullLocation || [loc.city, loc.region, loc.country?.toUpperCase()].filter(Boolean).join(', ')
    const remote = loc.remote === true || looksRemote(p.name, place)
    const id = p.company?.identifier || board.token
    return {
      job: {
        source: 'smartrecruiters',
        sourceId: `${board.token}:${p.id}`,
        title: p.name.trim(),
        company: p.company?.name?.trim() || board.company,
        location: place || undefined,
        remoteType: remote ? 'remote' : loc.hybrid ? 'hybrid' : undefined,
        url: `https://jobs.smartrecruiters.com/${encodeURIComponent(id)}/${p.id}`,
        tags: p.department?.label ? [p.department.label] : [],
        atsType: 'smartrecruiters',
        atsMeta: { board: board.token, postingId: p.id },
      },
      publishedAt: p.releasedDate ?? null,
      changedAt: p.releasedDate ?? null,
      locations: [place, loc.country?.toLowerCase() === 'us' ? 'United States' : ''].filter(Boolean),
      remote,
      fullTime: !/part|intern|temporary|contract/i.test(p.typeOfEmployment?.label ?? ''),
    }
  })
}

export const smartrecruitersAdapter: JobSourceAdapter = {
  name: 'smartrecruiters',
  overlapHours: 2,
  search: (params: SearchParams): Promise<NormalizedJob[]> => searchBoards('smartrecruiters', params, fetchBoard),
  pull: (_params: SearchParams, ctx: PullContext): Promise<PullResult> => pullBoards('smartrecruiters', ctx, fetchBoard),
}
