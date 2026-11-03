import { eq } from 'drizzle-orm'
import { jobs } from '~~/server/db/schema'
import { createApplicationRow } from '~~/server/utils/apply/prepare'

// POST /api/applications/:jobId: prepare an application for one job, the same way the daily
// applications:prepare run does (tailor, cover letter, gap analysis, form dry run).
// Creates the application at once and adds the rest to the job queue; the detail page follows
// its status. Pass ?wait=true to wait for the whole preparation (scripts and tests).
export default defineEventHandler(async (event) => {
  const jobId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(jobId) || jobId <= 0) throw createError({ statusCode: 400, statusMessage: 'Invalid job ID' })
  const job = useDb().select().from(jobs).where(eq(jobs.id, jobId)).get()
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Job not found' })

  // One transaction: the daily prepare step never sees the new row in preparing without its item.
  const { app, item } = useDb().$client.transaction(() => {
    const app = createApplicationRow(job)
    return { app, item: queuePrepare(app.id) }
  }).immediate()
  if (getQuery(event).wait === 'true') return await waitForPreparation(app.id, item.id)
  setResponseStatus(event, 202)
  return { ...app, status: 'preparing', statusDetail: 'Waiting in the queue to prepare', id: app.id }
})
