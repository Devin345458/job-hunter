import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { jobBoards, sourcePulls } from '../../db/schema'
import type { SearchParams } from './types'

// Incremental pull state: one source_pulls row per source, search config, and scope (a keyword
// for sources queried per keyword, a board token for employer boards, '' for one-feed sources).
// The row's last_pulled_at is the watermark: the start time of the last pull of that scope that
// finished completely. A failed or cut-short pull records the attempt and leaves the watermark
// alone. The tables (source_pulls, job_boards) come from migration 0006 in server/db/schema.ts.

export { jobBoards, sourcePulls }

/** The database the pull tables live in. */
export function pullDb() {
  return useDb()
}

export function nowIso() {
  return new Date().toISOString()
}

/** Listings older than this many days are never pulled from aggregators. */
export const MAX_AGE_DAYS = 14

/** Bumped when the shared filters change in a way that should re-read the whole window. */
const FILTER_VERSION = 1

/** Hash of what decides which listings pass, so editing a config re-pulls its 14-day window. */
export function filterHash(params: SearchParams): string {
  const sorted = (list?: string[]) => [...(list ?? [])].map(s => s.trim().toLowerCase()).filter(Boolean).sort()
  const key = JSON.stringify({
    v: FILTER_VERSION,
    keywords: sorted(params.keywords),
    excluded: sorted(params.excludedKeywords),
    locations: sorted(params.locations),
    remoteOnly: !!params.remoteOnly,
    salaryMin: params.salaryMin ?? null,
  })
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

export type PullRow = typeof sourcePulls.$inferSelect

export function pullRows(source: string, configId: number): Map<string, PullRow> {
  const rows = pullDb().select().from(sourcePulls)
    .where(and(eq(sourcePulls.source, source), eq(sourcePulls.configId, configId)))
    .all()
  return new Map(rows.map(r => [r.scope, r]))
}

/** Newest attempt at a source across configs and scopes, for sources that limit how often we ask. */
export function lastAttempt(source: string): string | null {
  const row = pullDb().select({ at: sql<string | null>`max(${sourcePulls.lastAttemptAt})` }).from(sourcePulls)
    .where(eq(sourcePulls.source, source))
    .get()
  return row?.at ?? null
}

/**
 * Start of the newest pull of a source that finished completely, across configs and scopes. Unlike
 * last_pulled_at it survives "Pull everything again", so a reset source does not look stuck.
 */
export function lastSuccess(source: string): string | null {
  const row = pullDb().select({ at: sql<string | null>`max(${sourcePulls.lastAttemptAt})` }).from(sourcePulls)
    .where(and(eq(sourcePulls.source, source), eq(sourcePulls.lastStatus, 'ok')))
    .get()
  return row?.at ?? null
}

export interface PullRecord {
  source: string
  configId: number
  scope: string
  /** Start time of this pull. Becomes the watermark when the pull finished completely. */
  startedAt: string
  hash: string
  status: 'ok' | 'partial' | 'failed' | 'unavailable'
  mode: 'full' | 'incremental'
  error?: string | null
  found?: number
  passed?: number
  known?: number
  added?: number
  requests?: number
}

/** Writes one scope's outcome. Only a status of ok moves the watermark. */
export function recordPull(r: PullRecord) {
  const db = pullDb()
  const counts = {
    found: r.found ?? 0,
    passed: r.passed ?? 0,
    known: r.known ?? 0,
    added: r.added ?? 0,
    requests: r.requests ?? 0,
  }
  const moved = r.status === 'ok' ? { lastPulledAt: r.startedAt, filterHash: r.hash } : {}
  const values = {
    source: r.source,
    configId: r.configId,
    scope: r.scope,
    lastAttemptAt: r.startedAt,
    lastStatus: r.status,
    lastError: r.error ? r.error.slice(0, 500) : null,
    lastMode: r.mode,
    ...counts,
    ...moved,
    updatedAt: nowIso(),
  }
  db.insert(sourcePulls).values(values)
    .onConflictDoUpdate({ target: [sourcePulls.source, sourcePulls.configId, sourcePulls.scope], set: values })
    .run()
}

/**
 * "Pull everything again": clears the watermarks (all sources, or one) so the next search reads
 * each source's whole window. Attempt times stay, so sources that limit how often we ask still wait.
 */
export function resetWatermarks(source?: string): number {
  const db = pullDb()
  const q = db.update(sourcePulls).set({ lastPulledAt: null, filterHash: null, updatedAt: nowIso() })
  const res = source ? q.where(eq(sourcePulls.source, source)).run() : q.run()
  return res.changes
}

export function allPullRows(): PullRow[] {
  return pullDb().select().from(sourcePulls).all()
}
