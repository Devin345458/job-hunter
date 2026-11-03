import { setRepoDescription } from '~~/server/utils/repos/describe'

// PUT /api/repos/description { fullName, text }
// Devin's own wording for what a repo is ("car wash management software"). Answer text uses it
// instead of the repo's name. An empty text clears it, so it is written again next time.
export default defineEventHandler(async (event) => {
  const body = await readBody<{ fullName?: unknown; text?: unknown }>(event)
  const fullName = typeof body?.fullName === 'string' ? body.fullName.trim() : ''
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw createError({ statusCode: 400, statusMessage: 'fullName must be owner/name' })
  if (typeof body?.text !== 'string') throw createError({ statusCode: 400, statusMessage: 'text must be text' })
  if (body.text.length > 200) throw createError({ statusCode: 400, statusMessage: 'Keep the description under 120 characters' })
  const saved = setRepoDescription(fullName, body.text)
  return { fullName, description: saved?.text ?? null, descriptionBy: saved?.by ?? null }
})
