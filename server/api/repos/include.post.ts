import { setRepoIncluded } from '~~/server/utils/repos/settings'

// POST /api/repos/include { fullName, included }
// Switches one repo on or off for GitHub evidence. Off forgets what was indexed from it (commits,
// facts, the clone, and suggestions citing it) at once. On takes effect at the next repos:index.
export default defineEventHandler(async (event) => {
  const body = await readBody<{ fullName?: unknown; included?: unknown }>(event)
  const fullName = typeof body?.fullName === 'string' ? body.fullName.trim() : ''
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw createError({ statusCode: 400, statusMessage: 'fullName must be owner/name' })
  if (typeof body?.included !== 'boolean') throw createError({ statusCode: 400, statusMessage: 'included must be true or false' })
  const row = setRepoIncluded(fullName, body.included)
  return { fullName: row.fullName, included: !!row.included }
})
