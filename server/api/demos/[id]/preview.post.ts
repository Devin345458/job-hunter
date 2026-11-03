import { demoBusy } from '~~/server/utils/demo/progress'
import { getDemo, toDemoDetail } from '~~/server/utils/demo/store'

// POST /api/demos/:id/preview: build the static web preview now (for a demo built before
// previews existed, or to refresh one), or, for a demo without a UI, run its tests once and
// list them. No Claude calls; it runs the project's own tools as the build user. Adds a
// demos:preview item to the job queue and answers 202 with the demo; poll GET /api/demos/:id until
// preview.status leaves 'building' (it reads building while the item waits, too).
export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'))
  const demo = Number.isInteger(id) ? getDemo(id) : null
  if (!demo) throw createError({ statusCode: 404, statusMessage: 'Demo not found' })
  if (demoBusy(id, demo.status)) {
    throw createError({ statusCode: 409, statusMessage: 'This demo is already building' })
  }
  if (!['built', 'published'].includes(demo.status)) {
    throw createError({ statusCode: 409, statusMessage: `Only a built demo has a preview; this one is ${demo.status}` })
  }
  enqueue(PREVIEW_TASK, { demoId: id }, { trigger: 'manual', existing: () => activeItem([REBUILD_TASK, PREVIEW_TASK], 'demoId', id) })
  setResponseStatus(event, 202)
  return toDemoDetail(getDemo(id)!)
})
