// POST /api/repos/find
// "Find repos with my commits": searches GitHub for every commit by his logins and emails and
// stores a count per repo. Takes minutes (search allows 30 requests a minute), so it goes to the
// job queue and the route returns 202; GET /api/repos shows it waiting, its progress, and then the
// counts. A second call while one is queued or running joins it. Recorded in pipeline_runs as
// repos:find (server/utils/queue-run.ts).
export default defineEventHandler((event) => {
  setResponseStatus(event, 202)
  const { created } = enqueue(FIND_TASK, {}, { trigger: 'manual', existing: () => activeItem(FIND_TASK) })
  return { started: created, running: true }
})
