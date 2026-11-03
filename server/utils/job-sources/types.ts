import type { AtsType } from '#shared/types/pipeline'

export interface NormalizedJob {
  source: string
  sourceId: string
  title: string
  company: string
  companyUrl?: string
  location?: string
  remoteType?: 'remote' | 'hybrid' | 'onsite'
  salaryMin?: number
  salaryMax?: number
  salaryCurrency?: string
  description?: string
  url?: string
  tags?: string[]
  expiresAt?: string
  /** The employer's application form, when the source knows it (ATS boards do). */
  applyUrl?: string
  atsType?: AtsType
  /** Board token, posting id, structured pay, anything enrichment needs from the ATS. Stored as JSON. */
  atsMeta?: Record<string, unknown>
}

export interface SearchParams {
  keywords: string[]
  excludedKeywords?: string[]
  locations?: string[]
  remoteOnly?: boolean
  salaryMin?: number
  salaryCurrency?: string
}

export interface JobSourceAdapter {
  name: string
  /**
   * Returns the listings that match the params. Throws when the source fails, so the
   * search run can record which sources worked. Throw SourceUnavailable for a known,
   * lasting condition (missing key, no subscription) that should not read as an outage.
   */
  search(params: SearchParams): Promise<NormalizedJob[]>
  /**
   * Incremental pull used by the search run: every listing inside the window, before the shared
   * filters, with the facts the filters need. search() is this with a full window, filtered.
   */
  pull?(params: SearchParams, ctx: PullContext): Promise<PullResult>
  /** Shortest time between two pulls, for sources whose terms limit how often we may ask. */
  minIntervalMinutes?: number
  /** How far before the watermark an incremental pull looks again, for sources that publish listings late. */
  overlapHours?: number
}

/** A source that cannot run for a known reason, such as missing credentials or an inactive subscription. */
export class SourceUnavailable extends Error {
  constructor(public readonly source: string, reason: string) {
    super(reason)
    this.name = 'SourceUnavailable'
  }
}

// ── Incremental pulls (data-sources unit) ──

/** One listing as the source returned it, before the shared filters in filters.ts. */
export interface RawListing {
  job: NormalizedJob
  /** When the listing was posted, or last updated where the source says so, as an ISO string. Null when unknown. */
  postedAt: string | null
  /** Every location the listing names, for the US eligibility check. */
  locations: string[]
  remote: boolean
  /** False for internships, part-time, freelance, and temporary roles. */
  fullTime: boolean
  /** True when the query itself only returns US listings (Adzuna's /us/ endpoint, Jobicy with geo=usa). */
  usOnly?: boolean
}

/**
 * The part of a source a watermark covers: '' for a source queried as one feed, the keyword for
 * sources queried per keyword (Adzuna), the board token for employer boards.
 */
export type PullScope = string

export interface PullContext {
  /** Listings posted before this are never pulled from aggregators (14 days ago). */
  cutoff: Date
  /**
   * Start of the incremental window for a scope: the last successful pull minus the source's
   * overlap. Null when the scope has never been pulled, its config changed, or it was reset.
   */
  since(scope: PullScope): Date | null
  log(msg: string): void
}

export interface PullScopeResult {
  scope: PullScope
  ok: boolean
  error?: string
  /** Listings inside the window, before filters. */
  found: number
  requests: number
  /** False when a page cap or rate limit cut the pull short; the watermark then stays put. */
  complete: boolean
}

export interface PullResult {
  listings: Array<RawListing & { scope: PullScope }>
  scopes: PullScopeResult[]
}
