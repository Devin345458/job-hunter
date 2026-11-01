import { eq } from 'drizzle-orm'
import { jobs } from '~~/server/db/schema'
import { prepareApplication } from '~~/server/utils/apply/prepare'
import { createApplicationRow } from '~~/server/utils/apply/prepare'

// POST /api/applications/:jobId: prepare an application for one job, the same way the daily
// applications:prepare run does (tailor, cover letter, gap analysis, form dry run).
// Creates the application at once and runs the rest in the background; the detail page follows
// its status. Pass ?wait=true to wait for the whole preparation (scripts and tests).
export default defineEventHandler(async (event) => {
  const jobId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(jobId) || jobId <= 0) throw createError({ statusCode: 400, statusMessage: 'Invalid job ID' })
  const job = useDb().select().from(jobs).where(eq(jobs.id, jobId)).get()
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Job not found' })

  const app = createApplicationRow(job)
  const run = prepareApplication(job.id, app, msg => console.log(`[prepare] ${msg}`))
  if (getQuery(event).wait === 'true') {
    const outcome = await run
    return { ...app, ...outcome, id: app.id }
  }
  void run.catch(e => console.error(`[prepare] application ${app.id} failed`, e))
  setResponseStatus(event, 202)
  return { ...app, id: app.id }
})
