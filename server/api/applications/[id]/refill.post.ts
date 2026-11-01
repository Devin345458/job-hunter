import { eq } from 'drizzle-orm'
import { applications } from '~~/server/db/schema'
import { refillApplicationForm } from '~~/server/utils/apply/prepare'

const ALLOWED = new Set(['preparing', 'needs_input', 'proposed', 'needs_manual', 'submit_failed'])

// POST /api/applications/:applicationId/refill: run only the form dry run again
// (fresh snapshot, fresh answers, fresh screenshot) with the stored resume and cover letter.
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  const app = Number.isInteger(id) ? useDb().select().from(applications).where(eq(applications.id, id)).get() : null
  if (!app) throw createError({ statusCode: 404, statusMessage: 'Application not found' })
  if (!ALLOWED.has(app.status)) throw createError({ statusCode: 409, statusMessage: `A ${app.status} application cannot be refilled` })
  const run = refillApplicationForm(app.id)
  if (getQuery(event).wait === 'true') return await run
  void run.catch(e => console.error(`[refill] application ${app.id} failed`, e))
  setResponseStatus(event, 202)
  return { applicationId: app.id, status: 'preparing' }
})
