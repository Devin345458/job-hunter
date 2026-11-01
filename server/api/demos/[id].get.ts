import { getDemo, toDemoDetail } from '~~/server/utils/demo/store'

// GET /api/demos/:id: the demo with its build log, cost, and the gap it closes.
export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'))
  const demo = Number.isInteger(id) ? getDemo(id) : null
  if (!demo) throw createError({ statusCode: 404, statusMessage: 'Demo not found' })
  return toDemoDetail(demo)
})
