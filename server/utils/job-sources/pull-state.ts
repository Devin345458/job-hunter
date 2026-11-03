import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { SearchParams } from './types'

// Incremental pull state: one row per source, search config, and scope (a keyword for sources
// queried per keyword, a board token for employer boards, '' for one-feed sources). The row's
// last_pulled_at is the watermark: the start time of the last pull of that scope that finished
// completely. A failed or cut-short pull records the attempt and leaves the watermark alone.
//
// These two tables are created here with CREATE TABLE IF NOT EXISTS on first use instead of a
// numbered drizzle migration, and are defined here instead of server/db/schema.ts, so this unit
// adds no migration and no schema edit (another unit adds a migration in parallel, and drizzle
// applies migrations by timestamp). drizzle-kit generate does not know about them. Times are ISO
// strings with a Z, so a browser reads them as UTC.

export const sourcePulls = sqliteTable('source_pulls', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(),
  configId: integer('config_id').notNull(),
  scope: text('scope').notNull().default(''),
  /** Hash of the config's filters when the watermark was set. A different hash means a full pull. */
  filterHash: text('filter_hash'),
  lastPulledAt: text('last_pulled_at'),
  lastAttemptAt: text('last_attempt_at'),
  lastStatus: text('last_status'), // ok, partial, failed, unavailable
  lastError: text('last_error'),
  lastMode: text('last_mode'), // full, incremental
  found: integer('found').notNull().default(0),
  passed: integer('passed').notNull().default(0),
  known: integer('known').notNull().default(0),
  added: integer('added').notNull().default(0),
  requests: integer('requests').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
}, table => [
  uniqueIndex('source_pulls_key_idx').on(table.source, table.configId, table.scope),
])

/** Employer boards found through apply links, pulled like the curated list in ats-boards.ts. */
export const jobBoards = sqliteTable('job_boards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ats: text('ats').notNull(),
  token: text('token').notNull(),
  company: text('company').notNull(),
  foundVia: text('found_via'),
  status: text('status').notNull().default('active'), // active, gone
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [
  uniqueIndex('job_boards_ats_token_idx').on(table.ats, table.token),
  index('job_boards_status_idx').on(table.status),
])

const DDL = `
CREATE TABLE IF NOT EXISTS source_pulls (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  source text NOT NULL,
  config_id integer NOT NULL,
  scope text DEFAULT '' NOT NULL,
  filter_hash text,
  last_pulled_at text,
  last_attempt_at text,
  last_status text,
  last_error text,
  last_mode text,
  found integer DEFAULT 0 NOT NULL,
  passed integer DEFAULT 0 NOT NULL,
  known integer DEFAULT 0 NOT NULL,
  added integer DEFAULT 0 NOT NULL,
  requests integer DEFAULT 0 NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS source_pulls_key_idx ON source_pulls (source, config_id, scope);
CREATE TABLE IF NOT EXISTS job_boards (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  ats text NOT NULL,
  token text NOT NULL,
  company text NOT NULL,
  found_via text,
  status text DEFAULT 'active' NOT NULL,
  last_error text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS job_boards_ats_token_idx ON job_boards (ats, token);
CREATE INDEX IF NOT EXISTS job_boards_status_idx ON job_boards (status);
`

let ready = false

/** The database with the pull tables in place. */
export function pullDb() {
  const db = useDb()
  if (!ready) {
    db.$client.exec(DDL)
    ready = true
  }
  return db
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
