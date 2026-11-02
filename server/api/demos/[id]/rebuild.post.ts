import { startRebuild } from '~~/server/utils/demo/build'
import { isDemoBuilding, isPreviewBuilding } from '~~/server/utils/demo/progress'
import { getAppWithJob, getDemo, toDemoDetail } from '~~/server/utils/demo/store'

// POST /api/demos/:id/rebuild: build a failed or planned demo again, in the background. Uses
// Claude (a build has cost about $0.50 to $1). Answers 202 at once with the demo, whose
// `progress` is set; GET /api/demos/:id shows the build as it runs. 409 while it is already
// building. A row left in 'building' by a server restart counts as failed here.
export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'))
  const demo = Number.isInteger(id) ? getDemo(id) : null
  if (!demo) throw createError({ statusCode: 404, statusMessage: 'Demo not found' })
  if (isDemoBuilding(id) || isPreviewBuilding(id)) {
    throw createError({ statusCode: 409, statusMessage: 'This demo is already building' })
  }
  const interrupted = demo.status === 'building'
  if (!['failed', 'proposed'].includes(demo.status) && !interrupted) {
    throw createError({ statusCode: 409, statusMessage: `Only a failed or planned demo can be built again; this one is ${demo.status}` })
  }
  if (!getAppWithJob(demo.applicationId)) throw createError({ statusCode: 409, statusMessage: 'The application for this demo no longer exists' })

  // The build claims the demo before its first await, so a second click now gets the 409 above.
  // It is recorded as a demos:rebuild run, so the run log shows it.
  startRebuild(id)

  setResponseStatus(event, 202)
  return toDemoDetail(getDemo(id)!)
})
