import { eq } from 'drizzle-orm'
import { applications, jobs } from '~~/server/db/schema'
import { approveEffect } from '~~/server/utils/apply/approve-effect'
import { getDemo, toDemoDetail } from '~~/server/utils/demo/store'

// GET /api/demos/:id: the demo with its build log, cost, and the gap it closes.
export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'))
  const demo = Number.isInteger(id) ? getDemo(id) : null
  if (!demo) throw createError({ statusCode: 404, statusMessage: 'Demo not found' })
  // What approving its application would do, decided the same way the review card decides it.
  const app = useDb().select().from(applications).where(eq(applications.id, demo.applicationId)).get()
  const job = app ? useDb().select().from(jobs).where(eq(jobs.id, app.jobId)).get() : null
  return { ...toDemoDetail(demo), approveEffect: app && job ? approveEffect(app, job, demo.status) : null }
})
