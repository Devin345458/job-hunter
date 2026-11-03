import type { NormalizedJob, PullContext, PullResult, PullScopeResult, RawListing, SearchParams } from './types'
import { type AnyBoardAts, type Board, boardsToPull, markBoardGone } from './board-discovery'
import { listingRejection } from './filters'
import { HttpError, mapPool, sourceWarnings, warn } from './http'

/** One posting from a board, with the facts the shared filters need. */
export interface BoardPosting {
  job: NormalizedJob
  /** First published date, for display and ordering. */
  publishedAt: string | null
  /**
   * Last change the board reports (Greenhouse updated_at, Ashby publishedAt). Null when the board
   * has no reliable time (Lever only has createdAt, set when the draft was made), and then every
   * posting is read on every pull and dedupe decides what is new.
   */
  changedAt: string | null
  locations: string[]
  remote: boolean
  /** False for internships, part-time, and temporary roles. */
  fullTime: boolean
}

const TIME = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN)

/** Requests a paged board fetch made, counted by countRequest() for the per-board stats. */
const requestCount = new WeakMap<Board, number>()

export function countRequest(board: Board) {
  requestCount.set(board, (requestCount.get(board) ?? 0) + 1)
}

/**
 * Fetches every board for one system (curated in ats-boards.ts plus the ones found through apply
 * links) and returns every open posting: board APIs list all open postings in one call, so there
 * is no paging and no age cutoff (a posting that is still listed is still open). Each board is its
 * own watermark scope. After a board's first pull, only postings changed since its watermark come
 * back, where the board reports a change time. One board failing is a warning and leaves its
 * watermark alone; a discovered board that answers 404 is marked gone; all boards failing throws.
 */
export async function pullBoards(
  ats: AnyBoardAts,
  ctx: PullContext,
  fetchBoard: (board: Board) => Promise<BoardPosting[]>,
): Promise<PullResult> {
  sourceWarnings.delete(ats)
  const boards = boardsToPull(ats)
  const out: PullResult = { listings: [], scopes: [] }
  let failures = 0
  await mapPool(boards, 8, async (board) => {
    const scope: PullScopeResult = { scope: board.token, ok: true, found: 0, requests: 1, complete: true }
    try {
      const before = requestCount.get(board) ?? 0
      const postings = await fetchBoard(board)
      scope.requests = Math.max(1, (requestCount.get(board) ?? 0) - before)
      const since = ctx.since(board.token)
      for (const p of postings) {
        if (since && p.changedAt && TIME(p.changedAt) < since.getTime()) continue
        const listing: RawListing = { job: p.job, postedAt: p.publishedAt ?? p.changedAt, locations: p.locations, remote: p.remote, fullTime: p.fullTime }
        out.listings.push({ ...listing, scope: board.token })
        scope.found++
      }
    }
    catch (e: any) {
      failures++
      scope.ok = false
      scope.complete = false
      scope.error = String(e?.message || e).slice(0, 300)
      warn(ats, `${board.token}: ${scope.error}`)
      if (board.discovered && e instanceof HttpError && e.status === 404) markBoardGone(ats, board.token, scope.error)
    }
    out.scopes.push(scope)
  })
  if (boards.length && failures === boards.length) {
    throw new Error(`Every ${ats} board failed: ${(sourceWarnings.get(ats) ?? []).slice(0, 3).join(' | ')}`)
  }
  return out
}

/**
 * The old search() contract for board sources: every board, full window, shared filters applied.
 * Kept so JobSourceAdapter.search still works for any caller outside the search run.
 */
export async function searchBoards(
  ats: AnyBoardAts,
  params: SearchParams,
  fetchBoard: (board: Board) => Promise<BoardPosting[]>,
): Promise<NormalizedJob[]> {
  const result = await pullBoards(ats, { cutoff: new Date(0), since: () => null, log: () => {} }, fetchBoard)
  return result.listings.filter(l => !listingRejection(l, params)).map(l => l.job)
}
