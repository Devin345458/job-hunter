import { DAILY_STEPS } from '~~/server/tasks/pipeline/daily'

const TASKS = new Set<string>(['pipeline:daily', ...DAILY_STEPS])

// Manual trigger for any pipeline task. Starts it in the background and returns at once;
// GET /api/pipeline/runs shows the result.
export default defineEventHandler(async (event) => {
  const body = await readBody<{ task?: string; payload?: Record<string, unknown> }>(event)
  const task = body?.task
  if (!task || !TASKS.has(task)) {
    throw createError({ statusCode: 400, statusMessage: `task must be one of: ${[...TASKS].join(', ')}` })
  }
  void runTask(task, { payload: { ...(body?.payload || {}), trigger: 'manual' } })
    .catch(e => console.error(`[pipeline] manual ${task} failed`, e))
  setResponseStatus(event, 202)
  return { started: task }
})
