import { refreshGapAnalysis } from '~~/server/utils/demo/gaps'
import { getAppWithJob } from '~~/server/utils/demo/store'

// POST /api/demos/analyze { applicationId }: run the gap analysis now and store it on the
// application. Questions it needs answered are created with askQuestion().
export default defineEventHandler(async (event) => {
  const body = await readBody<{ applicationId?: number }>(event)
  const applicationId = Number(body?.applicationId)
  if (!Number.isInteger(applicationId) || !getAppWithJob(applicationId)) {
    throw createError({ statusCode: 404, statusMessage: 'Application not found' })
  }
  try {
    return await refreshGapAnalysis(applicationId)
  }
  catch (e: any) {
    if (e instanceof AiBudgetExceeded) throw createError({ statusCode: 429, statusMessage: e.message })
    throw createError({ statusCode: 502, statusMessage: `Gap analysis failed: ${e?.message || e}` })
  }
})
