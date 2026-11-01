import { refreshApplicationAnswers } from '~~/server/utils/apply'

// POST /api/applications/:applicationId/refresh-answers: take Devin's answered questions into the
// stored form answers (no browser), and move needs_input to proposed when nothing blocks.
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400, statusMessage: 'Invalid application ID' })
  try {
    return await refreshApplicationAnswers(id)
  }
  catch (e: any) {
    throw createError({ statusCode: /not found/i.test(e?.message) ? 404 : 500, statusMessage: e?.message || 'Refresh failed' })
  }
})
