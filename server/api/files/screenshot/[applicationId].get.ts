import { existsSync, readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { applications } from '~~/server/db/schema'

// Screenshot of the filled employer form, behind login like every other route.
export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'applicationId'))
  const app = Number.isInteger(id) ? useDb().select().from(applications).where(eq(applications.id, id)).get() : null
  const kind = getQuery(event).kind === 'submission' ? 'submission' : 'form'
  const stored = kind === 'submission'
    ? parseJson<{ screenshotPath?: string | null }>(app?.submissionJson, {}).screenshotPath
    : app?.formScreenshotPath
  if (!stored) throw createError({ statusCode: 404, statusMessage: 'No screenshot' })
  const path = resolveStoredPath(stored)
  if (!path.startsWith(dataDir()) || !existsSync(path)) throw createError({ statusCode: 404, statusMessage: 'No screenshot' })
  setResponseHeader(event, 'Content-Type', path.endsWith('.jpg') || path.endsWith('.jpeg') ? 'image/jpeg' : 'image/png')
  setResponseHeader(event, 'Cache-Control', 'private, max-age=300')
  return readFileSync(path)
})
