import type { JobSourceAdapter, NormalizedJob, SearchParams } from './types'
import { greenhouseApplyUrl } from './ats-boards'
import { searchBoards } from './board-runner'
import { looksRemote } from './filters'
import { fetchJson } from './http'

interface GreenhouseJob {
  id: number
  title: string
  absolute_url: string
  location?: { name?: string | null } | null
  updated_at?: string
  first_published?: string | null
  company_name?: string
}

// Public Greenhouse job board API. The list is fetched without content (some boards hold
// 900 postings); enrichment fetches the full posting and its pay range per matched job.
export const greenhouseAdapter: JobSourceAdapter = {
  name: 'greenhouse',

  search(params: SearchParams): Promise<NormalizedJob[]> {
    return searchBoards('greenhouse', params, async (board) => {
      const data = await fetchJson<{ jobs: GreenhouseJob[] }>(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}/jobs`)
      return (data.jobs ?? []).map((j) => {
        const location = j.location?.name?.trim() || undefined
        const remote = looksRemote(location, j.title)
        return {
          job: {
            source: 'greenhouse',
            sourceId: `${board.token}:${j.id}`,
            title: j.title.trim(),
            company: board.company,
            location,
            remoteType: remote ? 'remote' : undefined,
            url: j.absolute_url,
            applyUrl: greenhouseApplyUrl(board.token, j.id),
            atsType: 'greenhouse',
            atsMeta: { boardToken: board.token, postingId: j.id },
          },
          publishedAt: j.first_published || j.updated_at || null,
          locations: location ? [location] : [],
          remote,
          fullTime: true,
        }
      })
    })
  },
}
