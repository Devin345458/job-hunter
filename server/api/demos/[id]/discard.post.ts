import { detachDemoFromResume } from '~~/server/utils/demo/attach'
import { appendBuildLog, getDemo, toDemoDetail, updateDemo } from '~~/server/utils/demo/store'

// POST /api/demos/:id/discard: drop a demo that has not been published. It comes off the
// tailored resume (and the PDF is regenerated) so the application goes out without it.
// The files stay on disk.
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  const demo = Number.isInteger(id) ? getDemo(id) : null
  if (!demo) throw createError({ statusCode: 404, statusMessage: 'Demo not found' })
  if (['building', 'publishing', 'published'].includes(demo.status)) {
    throw createError({ statusCode: 409, statusMessage: `A ${demo.status} demo cannot be discarded` })
  }
  updateDemo(id, { status: 'discarded' })
  const detached = await detachDemoFromResume(id)
  appendBuildLog(id, `discarded${detached.updated ? '; removed from the tailored resume and regenerated the PDF' : ''}`)
  return toDemoDetail(getDemo(id)!)
})
