import { setSkillCore } from '~~/server/utils/skill-catalog'

// PATCH /api/knowledge/skills/:slug { core: boolean }
// Marks a catalog skill core or not. Drafts will give a core skill a full answer and every other
// skill 2 or 3 sentences; nothing reads the flag yet.
export default defineEventHandler(async (event) => {
  const slug = String(getRouterParam(event, 'slug') ?? '')
  const body = await readBody<{ core?: unknown }>(event)
  if (typeof body?.core !== 'boolean') throw createError({ statusCode: 400, statusMessage: 'Say whether the skill is core (true or false)' })
  const entry = setSkillCore(slug, body.core)
  if (!entry) throw createError({ statusCode: 404, statusMessage: 'That skill is not in the catalog. Reload the page.' })
  return { slug: entry.slug, core: entry.core }
})
