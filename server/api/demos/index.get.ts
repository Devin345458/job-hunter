import { desc, inArray, ne } from 'drizzle-orm'
import { applications, demoProjects, jobs } from '~~/server/db/schema'
import { approveEffect } from '~~/server/utils/apply/approve-effect'
import { toDemoDetail } from '~~/server/utils/demo/store'

// GET /api/demos: every demo project except discarded ones, newest first.
// ?all=1 includes discarded. Each demo carries approveEffect, decided the same way the detail
// page and the review card decide it, so the list never promises a publish that cannot happen.
export default defineEventHandler((event) => {
  const all = getQuery(event).all === '1'
  const db = useDb()
  const rows = all
    ? db.select().from(demoProjects).orderBy(desc(demoProjects.id)).all()
    : db.select().from(demoProjects).where(ne(demoProjects.status, 'discarded')).orderBy(desc(demoProjects.id)).all()
  const appIds = [...new Set(rows.map(d => d.applicationId))]
  const apps = appIds.length ? db.select().from(applications).where(inArray(applications.id, appIds)).all() : []
  const jobIds = [...new Set(apps.map(a => a.jobId))]
  const jobRows = jobIds.length ? db.select().from(jobs).where(inArray(jobs.id, jobIds)).all() : []
  const appById = new Map(apps.map(a => [a.id, a]))
  const jobById = new Map(jobRows.map(j => [j.id, j]))
  return {
    demos: rows.map((d) => {
      const detail = toDemoDetail(d)
      const app = appById.get(d.applicationId)
      const job = app ? jobById.get(app.jobId) : undefined
      // The list polls while a build runs; the log, the gap analysis, and the test list stay on the detail page.
      return {
        ...detail,
        buildLog: null,
        gap: null,
        preview: { ...detail.preview, tests: null },
        approveEffect: app && job ? approveEffect(app, job, d.status) : null,
      }
    }),
  }
})
