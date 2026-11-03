import type { JobSourceAdapter, NormalizedJob, PullContext, PullResult, PullScopeResult, RawListing, SearchParams } from './types'
import { listingRejection } from './filters'
import { MAX_AGE_DAYS } from './pull-state'

// Paging shared by the aggregator sources. A pull reads pages until the source runs out, or the
// listings are older than the window: 14 days back on a full pull, the watermark (less the
// source's overlap) on an incremental one.

/** Where an aggregator pull starts for one scope: the watermark, never further back than the cutoff. */
export function windowStart(ctx: PullContext, scope: string): Date {
  const since = ctx.since(scope)
  return since && since > ctx.cutoff ? since : ctx.cutoff
}

export function toTime(value: string | number | null | undefined): number {
  if (value == null || value === '') return Number.NaN
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value
  // Remotive writes "2026-10-29T18:22:41" with no zone; it is UTC.
  const iso = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value) ? `${value}Z` : value
  return Date.parse(iso)
}

export function toIso(value: string | number | null | undefined): string | null {
  const t = toTime(value)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

export interface Page<T> {
  items: T[]
  /** Cursor or page token for the next page; null or undefined ends the pull. Ignored when numbered. */
  next?: string | null
  /** True when the source says there is nothing after this page. */
  last?: boolean
}

export interface PagedPullOptions<T> {
  scope: string
  start: Date
  /** Safety stop so a source that ignores its page parameter cannot loop forever. Reaching it marks the pull incomplete. */
  maxPages: number
  /** Numbered pages start here (1 for Adzuna, 0 for offset-style sources). Leave out for cursor paging. */
  firstPage?: number
  fetchPage: (page: number, cursor: string | null) => Promise<Page<T>>
  timeOf: (item: T) => number
  idOf: (item: T) => string
  /**
   * When to stop going back: 'last-older' when the oldest listing on a page is before the start
   * (sources sorted strictly newest first), 'all-older' when every listing on a page is (sources
   * whose order is only roughly by date).
   */
  stop: 'last-older' | 'all-older'
}

/** Reads pages for one scope. Throws only when the first page fails; a later failure ends the pull incomplete. */
export async function pagedPull<T>(o: PagedPullOptions<T>): Promise<{ items: T[]; result: PullScopeResult }> {
  const result: PullScopeResult = { scope: o.scope, ok: true, found: 0, requests: 0, complete: true }
  const items: T[] = []
  const seen = new Set<string>()
  const start = o.start.getTime()
  let cursor: string | null = null
  let page = o.firstPage ?? 0
  for (let n = 0; ; n++) {
    if (n >= o.maxPages) {
      result.complete = false
      result.error = `stopped after ${o.maxPages} pages`
      break
    }
    let data: Page<T>
    try {
      data = await o.fetchPage(page, cursor)
      result.requests++
    }
    catch (e: any) {
      if (n === 0) throw e
      result.requests++
      result.complete = false
      result.error = `page ${n + 1} failed: ${String(e?.message || e).slice(0, 200)}`
      break
    }
    if (!data.items.length) break
    let newOnPage = 0
    let olderOnPage = 0
    for (const item of data.items) {
      const t = o.timeOf(item)
      const id = o.idOf(item)
      if (!Number.isNaN(t) && t < start) {
        olderOnPage++
        continue
      }
      if (seen.has(id)) continue
      seen.add(id)
      newOnPage++
      items.push(item)
    }
    const lastTime = o.timeOf(data.items[data.items.length - 1]!)
    if (o.stop === 'last-older' && !Number.isNaN(lastTime) && lastTime < start) break
    if (o.stop === 'all-older' && olderOnPage === data.items.length) break
    if (data.last) break
    if (o.firstPage == null) {
      if (!data.next) break
      cursor = data.next
    }
    else {
      page++
    }
    // A page with nothing unseen and nothing older means the source repeats itself; stop.
    if (!newOnPage && !olderOnPage) break
  }
  result.found = items.length
  return { items, result }
}

/** A pull context covering the whole window, for the search() wrapper. */
export function fullContext(): PullContext {
  return { cutoff: new Date(Date.now() - MAX_AGE_DAYS * 86400000), since: () => null, log: () => {} }
}

/** Builds an adapter from a pull function: search() is a full pull with the shared filters applied. */
export function aggregator(def: {
  name: string
  minIntervalMinutes?: number
  overlapHours?: number
  pull: (params: SearchParams, ctx: PullContext) => Promise<PullResult>
}): JobSourceAdapter {
  return {
    ...def,
    async search(params: SearchParams): Promise<NormalizedJob[]> {
      const result = await def.pull(params, fullContext())
      const failed = result.scopes.filter(s => !s.ok)
      if (result.scopes.length && failed.length === result.scopes.length) throw new Error(failed[0]!.error || `${def.name} failed`)
      return result.listings.filter(l => !listingRejection(l, params)).map(l => l.job)
    },
  }
}

/** One scope's listings tagged with the scope, for a PullResult. */
export function tag(scope: string, listings: RawListing[]): Array<RawListing & { scope: string }> {
  return listings.map(l => ({ ...l, scope }))
}

/** Runs one scope and turns a thrown error into a failed scope, so other scopes still count. */
export async function scoped(scope: string, fn: () => Promise<{ listings: RawListing[]; result: PullScopeResult }>): Promise<PullResult> {
  try {
    const { listings, result } = await fn()
    return { listings: tag(scope, listings), scopes: [result] }
  }
  catch (e: any) {
    if (e?.name === 'SourceUnavailable') throw e
    return { listings: [], scopes: [{ scope, ok: false, error: String(e?.message || e).slice(0, 300), found: 0, requests: 1, complete: false }] }
  }
}

export function mergeResults(results: PullResult[]): PullResult {
  return { listings: results.flatMap(r => r.listings), scopes: results.flatMap(r => r.scopes) }
}
