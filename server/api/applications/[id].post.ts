import { eq } from 'drizzle-orm'
import { applications, jobs } from '~~/server/db/schema'
import { createApplicationRow } from '~~/server/utils/apply/prepare'

// POST /api/applications/:jobId: prepare an application for one job, from the job's page. The same
// as Apply on a Decide card: it records the choice (a positive signal for learning) and adds the
// preparation (tailor, cover letter, form answers, form dry run) to the job queue. A job that
// already has a Decide card (to_decide) is prepared from that row. The detail page follows its
// status. Pass ?wait=true to wait for the whole preparation (scripts and tests).
export default defineEventHandler(async (event) => {
  const jobId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(jobId) || jobId <= 0) throw createError({ statusCode: 400, statusMessage: 'Invalid job ID' })
  const db = useDb()
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get()
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Job not found' })

  // One transaction: the read-forms step never sees the row in preparing without its item.
  const { app, item } = db.$client.transaction(() => {
    const existing = db.select().from(applications).where(eq(applications.jobId, job.id)).get()
    const app = existing?.status === 'to_decide' ? existing : createApplicationRow(job)
    return { app, item: queuePrepare(app.id) }
  }).immediate()
  const decision = recordDecision(app.id, 'apply', null, null)
  db.update(applications).set({ decidedAt: nowSql() }).where(eq(applications.id, app.id)).run()
  await onDecision(decision.id).catch(e => console.error('[learning] onDecision failed', e))
  if (getQuery(event).wait === 'true') return await waitForPreparation(app.id, item.id)
  setResponseStatus(event, 202)
  return { ...app, status: 'preparing', statusDetail: 'Waiting in the queue to prepare', id: app.id }
})
