import { and, desc, eq, isNotNull } from 'drizzle-orm'
import type { SourceLastRun, SourcesStatus, SourceStatusRow } from '#shared/types/sources'
import { properName } from '#shared/utils/names'
import { pipelineRuns, searchConfigs } from '../../db/schema'
import { AGGREGATOR_ADAPTERS, ALL_ADAPTERS, BOARD_ADAPTERS } from './index'
import { ATS_BOARDS } from './ats-boards'
import { discoveredBoardCount } from './board-discovery'
import { allPullRows } from './pull-state'

function parseList(value: string | null | undefined): string[] | null {
  if (!value) return null
  try {
    const v = JSON.parse(value)
    return Array.isArray(v) ? v.map(String) : null
  }
  catch {
    return null
  }
}

/** One line per source for Settings: when it was last pulled, and what the last search found. */
export function sourcesStatus(): SourcesStatus {
  const db = useDb()
  const active = db.select({ jobSources: searchConfigs.jobSources }).from(searchConfigs).where(eq(searchConfigs.isActive, true)).all()
  const chosen = new Set(active.flatMap(c => parseList(c.jobSources) ?? Object.keys(AGGREGATOR_ADAPTERS)))
  const last = db.select().from(pipelineRuns)
    .where(and(eq(pipelineRuns.task, 'jobs:search'), eq(pipelineRuns.status, 'succeeded'), isNotNull(pipelineRuns.statsJson)))
    .orderBy(desc(pipelineRuns.id))
    .limit(1)
    .get()
  let lastSources: Record<string, SourceLastRun> = {}
  try {
    lastSources = (JSON.parse(last?.statsJson ?? '{}') as { sources?: Record<string, SourceLastRun> }).sources ?? {}
  }
  catch {
    lastSources = {}
  }
  const rows = allPullRows()
  const boards = discoveredBoardCount()

  const out: SourceStatusRow[] = Object.keys(ALL_ADAPTERS).map((source) => {
    const adapter = ALL_ADAPTERS[source]!
    const mine = rows.filter(r => r.source === source)
    const scoped = mine.filter(r => r.scope !== '' || !mine.some(o => o.scope !== ''))
    const marks = scoped.map(r => r.lastPulledAt).filter((t): t is string => !!t).sort()
    const attempts = mine.map(r => r.lastAttemptAt).filter((t): t is string => !!t).sort()
    const lastAttemptAt = attempts.at(-1) ?? null
    const until = adapter.minIntervalMinutes && lastAttemptAt ? Date.parse(lastAttemptAt) + adapter.minIntervalMinutes * 60000 : 0
    const kind = source in BOARD_ADAPTERS ? 'board' : 'aggregator'
    return {
      source,
      name: properName(source),
      kind,
      selected: kind === 'board' || chosen.has(source),
      lastPulledAt: marks.at(-1) ?? null,
      oldestPulledAt: marks[0] ?? null,
      scopes: scoped.length,
      scopesPending: scoped.filter(r => !r.lastPulledAt).length,
      lastAttemptAt,
      waitUntil: until > Date.now() ? new Date(until).toISOString() : null,
      lastRun: lastSources[source] ?? null,
      ...(kind === 'board'
        ? { boards: { curated: ATS_BOARDS.filter(b => b.ats === source).length, discovered: boards[source]?.active ?? 0, gone: boards[source]?.gone ?? 0 } }
        : {}),
    }
  })
  return {
    lastRunAt: last?.finishedAt ?? last?.startedAt ?? null,
    lastRunId: last?.id ?? null,
    rows: out,
  }
}
