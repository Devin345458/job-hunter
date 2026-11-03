import { eq } from 'drizzle-orm'
import { applications } from '~~/server/db/schema'

const ALLOWED = new Set(['preparing', 'needs_input', 'proposed', 'needs_manual', 'submit_failed', 'draft', 'ready'])

// POST /api/applications/:applicationId/prepare: run the whole preparation again in place. Added to
// the job queue; the application reads preparing at once. ?wait=true waits for it to finish.
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  const app = Number.isInteger(id) ? useDb().select().from(applications).where(eq(applications.id, id)).get() : null
  if (!app) throw createError({ statusCode: 404, statusMessage: 'Application not found' })
  if (!ALLOWED.has(app.status)) throw createError({ statusCode: 409, statusMessage: `A ${app.status} application cannot be prepared again` })
  const busy = activeItem([PREPARE_ONE_TASK, REFILL_TASK, APPROVE_TASK], 'applicationId', app.id)
  if (busy) throw createError({ statusCode: 409, statusMessage: busy.status === 'running' ? 'This application is being worked on now' : 'This application is already waiting in the queue' })
  // One transaction: the daily prepare step never sees it in preparing without its item.
  const item = useDb().$client.transaction(() => {
    setApplicationStatus(app.id, 'preparing', 'Waiting in the queue to prepare again')
    return enqueue(PREPARE_ONE_TASK, { applicationId: app.id }, { trigger: 'manual' }).item
  }).immediate()
  if (getQuery(event).wait === 'true') return await waitForPreparation(app.id, item.id)
  setResponseStatus(event, 202)
  return { applicationId: app.id, status: 'preparing' }
})
