import { and, desc, eq, sql } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { aiCalls, applications, demoProjects, jobs } from '../../db/schema'
import type { DemoDetail, GapAnalysis, GapItem } from '#shared/types/pipeline'
import { plainGap } from './gap-text'
import { gapSummaryText } from '#shared/utils/plain-text'
import { previewView } from './preview-state'
import { buildProgress } from './progress'
import { stopKind } from './stop-reason'

export type DemoRow = InferSelectModel<typeof demoProjects>
export type AppRow = InferSelectModel<typeof applications>
export type JobRow = InferSelectModel<typeof jobs>

export function getDemo(demoId: number): DemoRow | null {
  return useDb().select().from(demoProjects).where(eq(demoProjects.id, demoId)).get() ?? null
}

export function updateDemo(demoId: number, values: Partial<DemoRow>) {
  useDb().update(demoProjects).set(values).where(eq(demoProjects.id, demoId)).run()
}

/** Add a timestamped line to the demo's build log (publish steps, discard). */
export function appendBuildLog(demoId: number, line: string) {
  const demo = getDemo(demoId)
  if (!demo) return
  const stamped = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC] ${line}`
  updateDemo(demoId, { buildLog: demo.buildLog ? `${demo.buildLog}\n${stamped}` : stamped })
}

export function getAppWithJob(applicationId: number): { app: AppRow; job: JobRow } | null {
  return useDb().select({ app: applications, job: jobs })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .where(eq(applications.id, applicationId))
    .get() ?? null
}

/** Demo rows for an application, newest first, discarded ones excluded. */
export function demosForApplication(applicationId: number): DemoRow[] {
  return useDb().select().from(demoProjects)
    .where(eq(demoProjects.applicationId, applicationId))
    .orderBy(desc(demoProjects.id)).all()
    .filter(d => d.status !== 'discarded')
}

/** Dollars of Claude calls logged against this demo (every agent turn passes ref demo/<id>). */
export function demoCost(demoId: number): number {
  const row = useDb()
    .select({ total: sql<number>`coalesce(sum(${aiCalls.costUsd}), 0)` })
    .from(aiCalls)
    .where(and(eq(aiCalls.refType, 'demo'), eq(aiCalls.refId, demoId)))
    .get()
  return row?.total ?? 0
}

/** Public GitHub URL the demo gets on publish. Resume entries use it before the repo exists. */
export function githubRepoUrl(repoName: string): string {
  const owner = useRuntimeConfig().githubOwner || 'Devin345458'
  return `https://github.com/${owner}/${repoName}`
}

export function storeGapAnalysis(applicationId: number, gap: GapAnalysis) {
  useDb().update(applications)
    .set({ gapAnalysisJson: JSON.stringify(gap), updatedAt: nowSql() })
    .where(eq(applications.id, applicationId))
    .run()
}

/** A requirement's lowercase words, without the "(kind: ...)" tag older analyses copied and without punctuation. */
function requirementWords(text: string): Set<string> {
  return new Set(text.replace(/\s*\(kind: [^)]*\)/gi, '').toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean))
}

/**
 * True when two requirement lines are the same requirement. A gap analysis that ran again can
 * word it a little differently from the line the demo was built for ("Familiarity with
 * Test-Driven or Spec-Driven Development" against "Familiarity with Test-Driven Development or
 * Spec-Driven Development"), so the words are compared, not the exact text.
 */
export function sameRequirement(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  if (a.trim() === b.trim()) return true
  const x = requirementWords(a)
  const y = requirementWords(b)
  if (!x.size || !y.size) return false
  const shared = [...x].filter(w => y.has(w)).length
  return shared / Math.max(x.size, y.size) >= 0.85
}

/** The index of the gap item about this requirement: an exact match first, then the same words. */
function itemIndexFor(gap: GapAnalysis | null, requirement: string | null, decision?: GapItem['decision']): number {
  if (!gap || !requirement) return -1
  const ok = (i: GapItem) => !decision || i.decision === decision
  const exact = gap.items.findIndex(i => ok(i) && i.requirement === requirement)
  return exact >= 0 ? exact : gap.items.findIndex(i => ok(i) && sameRequirement(i.requirement, requirement))
}

/** The gap item a demo answers: the first item marked demo. */
export function demoItem(gap: GapAnalysis | null): GapItem | null {
  return gap?.items.find(i => i.decision === 'demo' && i.demoIdea) ?? null
}

/**
 * A failed demo whose application's current gap analysis no longer plans it (Devin's answers since
 * then cover the gap). It will never be retried, so the pages say so instead of promising a retry.
 */
export function demoNoLongerPlanned(d: { status: string; gapAddressed: string | null }, gapAnalysisJson: string | null | undefined): boolean {
  if (d.status !== 'failed') return false
  const gap = parseJson<GapAnalysis | null>(gapAnalysisJson, null)
  if (!gap) return false
  return itemIndexFor(gap, d.gapAddressed, 'demo') === -1
}

/** Statuses in which the demo's code exists, so a row that now says "no demo" can say one was built. */
const BUILT_STATUSES = new Set(['built', 'publishing', 'published'])

export function toDemoDetail(d: DemoRow): DemoDetail {
  const row = getAppWithJob(d.applicationId)
  const stored = parseJson<GapAnalysis | null>(row?.app.gapAnalysisJson, null)
  const noLongerPlanned = demoNoLongerPlanned(d, row?.app.gapAnalysisJson)
  // Shown in plain words: real plurals, "you", and knowledge base references by name. The summary
  // says what state this demo is in ("Demo built: ..."), and never names a demo the current
  // analysis no longer plans.
  const plain = stored ? plainGap(stored) : null
  const gap = plain ? { ...plain, summary: gapSummaryText(plain.summary, noLongerPlanned ? null : d), items: [...plain.items] } : null
  const itemIndex = itemIndexFor(stored, d.gapAddressed, 'demo')
  // The current analysis can cover the gap another way ("Use existing experience") after this
  // demo was built; that row says the demo exists anyway.
  const rowIndex = itemIndexFor(stored, d.gapAddressed)
  if (gap && rowIndex >= 0 && gap.items[rowIndex]!.decision !== 'demo' && BUILT_STATUSES.has(d.status)) {
    const item = gap.items[rowIndex]!
    const done = d.status === 'published' ? 'built and published' : 'built'
    gap.items[rowIndex] = { ...item, rationale: `${item.rationale.trim()} The ${d.title} demo was ${done} for this anyway.` }
  }
  return {
    ...toDemoView(d),
    applicationId: d.applicationId,
    jobId: d.jobId,
    isSandbox: row?.app.isSandbox ?? false,
    applicationStatus: (row?.app.status ?? 'draft') as DemoDetail['applicationStatus'],
    job: { title: row?.job.title ?? '', company: row?.job.company ?? '' },
    plannedRepoUrl: d.repoName ? githubRepoUrl(d.repoName) : null,
    // While a build runs, the stored figure is the last run's; the live total comes from ai_calls.
    costUsd: buildProgress(d.id) ? demoCost(d.id) : d.costUsd ?? (d.id ? demoCost(d.id) : null),
    buildLog: d.buildLog,
    createdAt: d.createdAt,
    builtAt: d.builtAt,
    publishedAt: d.publishedAt,
    gapItem: itemIndex >= 0 ? gap!.items[itemIndex]! : null,
    gap,
    progress: buildProgress(d.id),
    stoppedFor: d.status === 'failed' && itemIndex >= 0 ? stopKind(d.error) : null,
    noLongerPlanned,
    // What the current analysis decided for this gap instead (reframe or skip), in plain words.
    notNeededReason: noLongerPlanned && rowIndex >= 0 ? gap!.items[rowIndex]!.rationale : null,
    preview: previewView(d),
  }
}
