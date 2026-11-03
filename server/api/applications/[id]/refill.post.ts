import { eq } from 'drizzle-orm'
import { applications } from '~~/server/db/schema'
import { assertRefillable } from '~~/server/utils/apply/prepare'

const ALLOWED = new Set(['preparing', 'needs_input', 'proposed', 'needs_manual', 'submit_failed'])

// POST /api/applications/:applicationId/refill: run only the form dry run again
// (fresh snapshot, fresh answers, fresh screenshot) with the stored resume and cover letter.
// Added to the job queue; the application reads preparing at once. ?wait=true waits for it.
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  const app = Number.isInteger(id) ? useDb().select().from(applications).where(eq(applications.id, id)).get() : null
  if (!app) throw createError({ statusCode: 404, statusMessage: 'Application not found' })
  if (!ALLOWED.has(app.status)) throw createError({ statusCode: 409, statusMessage: `A ${app.status} application cannot be refilled` })
  const busy = activeItem([PREPARE_ONE_TASK, REFILL_TASK, APPROVE_TASK], 'applicationId', app.id)
  if (busy) throw createError({ statusCode: 409, statusMessage: busy.status === 'running' ? 'This application is being worked on now' : 'This application is already waiting in the queue' })
  // The same checks the refill itself makes, so a doomed refill is refused here instead of later.
  assertRefillable(app.id)
  // One transaction: the daily prepare step never sees it in preparing without its item.
  const item = useDb().$client.transaction(() => {
    setApplicationStatus(app.id, 'preparing', 'Waiting in the queue to fill the form again')
    return enqueue(REFILL_TASK, { applicationId: app.id }, { trigger: 'manual' }).item
  }).immediate()
  if (getQuery(event).wait === 'true') return await waitForPreparation(app.id, item.id)
  setResponseStatus(event, 202)
  return { applicationId: app.id, status: 'preparing' }
})
