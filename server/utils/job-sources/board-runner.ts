import type { NormalizedJob, SearchParams } from './types'
import { type AtsBoard, type BoardAts, boardsFor, MAX_PER_BOARD } from './ats-boards'
import { isSoftwareRoleTitle, isUsEligible, matchesAnyTerm, payBelow, titleMatchesKeywords, usEligibility } from './filters'
import { mapPool, sourceWarnings, warn } from './http'

/** One posting from a board, with the facts the shared filters need. */
export interface BoardPosting {
  job: NormalizedJob
  publishedAt: string | null
  locations: string[]
  remote: boolean
  /** False for internships, part-time, and temporary roles. */
  fullTime: boolean
}

/**
 * Fetches every curated board for one ATS and applies the search config the same way for all:
 * full-time, title matches a keyword and is a software role (not sales, support, services, or
 * hardware), no excluded term in the title, remote when the config is
 * remote-only, a US-eligible location, stated pay not entirely below the config's minimum.
 * Keeps the newest MAX_PER_BOARD per board. One board failing is a warning; all failing throws.
 */
export async function searchBoards(
  ats: BoardAts,
  params: SearchParams,
  fetchBoard: (board: AtsBoard) => Promise<BoardPosting[]>,
): Promise<NormalizedJob[]> {
  sourceWarnings.delete(ats)
  const boards = boardsFor(ats)
  let failures = 0
  const perBoard = await mapPool(boards, 8, async (board) => {
    try {
      const postings = await fetchBoard(board)
      return postings
        .filter(p => p.fullTime)
        .filter(p => titleMatchesKeywords(p.job.title, params.keywords))
        .filter(p => isSoftwareRoleTitle(p.job.title))
        .filter(p => !matchesAnyTerm(p.job.title, params.excludedKeywords))
        .filter(p => !params.remoteOnly || p.remote)
        .filter(p => isUsEligible(p.locations) || (p.remote && usEligibility(p.locations) === 'unknown'))
        .filter(p => !payBelow(params.salaryMin, p.job.salaryMin, p.job.salaryMax))
        .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
        .slice(0, MAX_PER_BOARD)
        .map(p => p.job)
    }
    catch (e: any) {
      failures++
      warn(ats, `${board.token}: ${e?.message || e}`)
      return []
    }
  })
  if (boards.length && failures === boards.length) {
    throw new Error(`Every ${ats} board failed: ${(sourceWarnings.get(ats) ?? []).slice(0, 3).join(' | ')}`)
  }
  return perBoard.flat()
}
