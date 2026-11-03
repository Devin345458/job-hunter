import type { JobSourceAdapter, NormalizedJob, PullContext, PullResult, SearchParams } from './types'
import type { Board } from './board-discovery'
import { type BoardPosting, countRequest, pullBoards, searchBoards } from './board-runner'
import { looksRemote } from './filters'
import { fetchJson } from './http'

// Rippling ATS public board API (no key): ats.rippling.com/api/v2/board/<slug>/jobs, paged by page
// and pageSize. No curated list; boards come from apply links (ats.rippling.com/<slug>/jobs/<id>).
// The list has no dates, so every pull reads the whole board and dedupe decides what is new; the
// posting page is server-rendered, so enrichment reads the description there.

interface RipplingJob {
  id: string
  name: string
  url?: string
  department?: { name?: string }
  locations?: Array<{ name?: string; country?: string; countryCode?: string; workplaceType?: string }>
}

const PER_PAGE = 100

async function fetchBoard(board: Board): Promise<BoardPosting[]> {
  const all: RipplingJob[] = []
  for (let page = 0; page < 50; page++) {
    countRequest(board)
    const data = await fetchJson<{ items?: RipplingJob[]; totalPages?: number }>(
      `https://ats.rippling.com/api/v2/board/${encodeURIComponent(board.token)}/jobs?page=${page}&pageSize=${PER_PAGE}`,
      { cache: true, minIntervalMs: 300 },
    )
    all.push(...(data.items ?? []))
    if (!data.items?.length || page + 1 >= (data.totalPages ?? 0)) break
  }
  return all.filter(j => j.id && j.name).map((j) => {
    const locations = (j.locations ?? []).map(l => [l.name, l.countryCode === 'US' ? 'United States' : l.country].filter(Boolean).join(', ')).filter(Boolean)
    const remote = (j.locations ?? []).some(l => /remote/i.test(l.workplaceType ?? '')) || looksRemote(j.name, ...locations)
    return {
      job: {
        source: 'rippling',
        sourceId: `${board.token}:${j.id}`,
        title: j.name.trim(),
        company: board.company,
        location: locations.join('; ') || undefined,
        remoteType: remote ? 'remote' : (j.locations ?? []).some(l => /hybrid/i.test(l.workplaceType ?? '')) ? 'hybrid' : undefined,
        url: j.url || `https://ats.rippling.com/${board.token}/jobs/${j.id}`,
        tags: j.department?.name ? [j.department.name] : [],
        atsMeta: { board: board.token, postingId: j.id },
      },
      publishedAt: null,
      changedAt: null,
      locations,
      remote,
      fullTime: true,
    }
  })
}

export const ripplingAdapter: JobSourceAdapter = {
  name: 'rippling',
  search: (params: SearchParams): Promise<NormalizedJob[]> => searchBoards('rippling', params, fetchBoard),
  pull: (_params: SearchParams, ctx: PullContext): Promise<PullResult> => pullBoards('rippling', ctx, fetchBoard),
}
