import { and, desc, eq, sql } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { aiCalls, applications, demoProjects, jobs } from '../../db/schema'
import type { DemoDetail, GapAnalysis, GapItem } from '#shared/types/pipeline'

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

/** The gap item a demo answers: the first item marked demo. */
export function demoItem(gap: GapAnalysis | null): GapItem | null {
  return gap?.items.find(i => i.decision === 'demo' && i.demoIdea) ?? null
}

export function toDemoDetail(d: DemoRow): DemoDetail {
  const row = getAppWithJob(d.applicationId)
  const gap = parseJson<GapAnalysis | null>(row?.app.gapAnalysisJson, null)
  return {
    ...toDemoView(d),
    applicationId: d.applicationId,
    jobId: d.jobId,
    isSandbox: row?.app.isSandbox ?? false,
    applicationStatus: (row?.app.status ?? 'draft') as DemoDetail['applicationStatus'],
    job: { title: row?.job.title ?? '', company: row?.job.company ?? '' },
    plannedRepoUrl: d.repoName ? githubRepoUrl(d.repoName) : null,
    costUsd: d.costUsd ?? (d.id ? demoCost(d.id) : null),
    buildLog: d.buildLog,
    createdAt: d.createdAt,
    builtAt: d.builtAt,
    publishedAt: d.publishedAt,
    gapItem: gap?.items.find(i => i.decision === 'demo' && i.requirement === d.gapAddressed) ?? null,
    gap,
  }
}
