import { eq } from 'drizzle-orm'
import { applications } from '~~/server/db/schema'
import { prepareApplication } from '~~/server/utils/apply/prepare'

const ALLOWED = new Set(['preparing', 'needs_input', 'proposed', 'needs_manual', 'submit_failed', 'draft', 'ready'])

// POST /api/applications/:applicationId/prepare: run the whole preparation again in place.
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  const app = Number.isInteger(id) ? useDb().select().from(applications).where(eq(applications.id, id)).get() : null
  if (!app) throw createError({ statusCode: 404, statusMessage: 'Application not found' })
  if (!ALLOWED.has(app.status)) throw createError({ statusCode: 409, statusMessage: `A ${app.status} application cannot be prepared again` })
  const run = prepareApplication(app.jobId, app, msg => console.log(`[prepare] ${msg}`))
  if (getQuery(event).wait === 'true') return await run
  void run.catch(e => console.error(`[prepare] application ${app.id} failed`, e))
  setResponseStatus(event, 202)
  return { applicationId: app.id, status: 'preparing' }
})
