// Settings > Job sources: GET /api/sources and POST /api/sources/reset (data-sources unit).

/** What the last search run recorded for one source. Older runs only have status, found, and new. */
export interface SourceLastRun {
  status: 'ok' | 'partial' | 'unavailable' | 'failed' | 'waiting'
  found: number
  passed?: number
  known?: number
  new: number
  queued?: number
  requests?: number
  mode?: 'full' | 'incremental' | 'mixed'
  scopes?: number
  scopesFailed?: number
  waitUntil?: string
  error?: string
}

export interface SourceStatusRow {
  source: string
  name: string
  kind: 'aggregator' | 'board'
  /** Boards always run. An aggregator runs when an active search config lists it. */
  selected: boolean
  /** Newest and oldest watermark across this source's keywords or boards (ISO, UTC). */
  lastPulledAt: string | null
  oldestPulledAt: string | null
  /** Keywords or boards with a watermark, and how many still wait for their first full pull. */
  scopes: number
  scopesPending: number
  lastAttemptAt: string | null
  /** Set when the source limits how often it may be asked and the next run must wait. */
  waitUntil: string | null
  lastRun: SourceLastRun | null
  /** Boards: curated in code, found through apply links, and found but no longer answering. */
  boards?: { curated: number; discovered: number; gone: number }
}

export interface SourcesStatus {
  lastRunAt: string | null
  lastRunId: number | null
  rows: SourceStatusRow[]
}
