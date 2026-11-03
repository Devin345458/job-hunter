import { DAILY_STEPS } from '~~/server/tasks/pipeline/daily'
import type { QueueRow } from '~~/server/utils/queue'

const TASKS = new Set<string>(['pipeline:daily', ...DAILY_STEPS])

// Manual trigger for any pipeline task. Adds it to the job queue and returns at once; the worker
// runs it when the items ahead of it finish. GET /api/pipeline/runs shows it waiting, running, and
// done. A full run that is already queued or under way is not queued twice; the same task waiting
// in the queue is not either.
export default defineEventHandler(async (event) => {
  const body = await readBody<{ task?: string; payload?: Record<string, unknown> }>(event)
  const task = body?.task
  if (!task || !TASKS.has(task)) {
    throw createError({ statusCode: 400, statusMessage: `task must be one of: ${[...TASKS].join(', ')}` })
  }
  const payload = body?.payload && typeof body.payload === 'object' ? body.payload : {}
  const { item, created } = task === 'pipeline:daily'
    ? enqueueDaily('manual')
    : enqueue(task, payload, { trigger: 'manual', existing: () => waitingManual(task, payload) })
  setResponseStatus(event, 202)
  return { started: task, queued: created, item: { id: item.id, status: item.status } }
})

/** The same manual run of this task, still waiting (a second click while it waits adds nothing). */
function waitingManual(task: string, payload: Record<string, unknown>): QueueRow | null {
  const item = activeItem(task)
  return item && item.status === 'queued' && item.trigger === 'manual' && !item.parentId && item.payloadJson === JSON.stringify(payload) ? item : null
}
