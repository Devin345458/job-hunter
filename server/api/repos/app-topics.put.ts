import { appRepoView, saveAppRepoTopics } from '~~/server/utils/repos/settings'

// PUT /api/repos/app-topics { topics: [{ name, cap }] } or { reset: true }
// The topics this app's own repo counts for. Its commits are a hit only for a subject that names
// one of them; cap yes lets them support Yes on their own, some caps them at Some experience.
// The next repos:suggest run uses the new list.
export default defineEventHandler(async (event) => {
  const body = await readBody<{ topics?: unknown; reset?: unknown }>(event)
  if (body?.reset === true) {
    saveAppRepoTopics(null)
    return appRepoView()
  }
  if (!Array.isArray(body?.topics)) throw createError({ statusCode: 400, statusMessage: 'topics must be a list' })
  if (body.topics.length > 40) throw createError({ statusCode: 400, statusMessage: 'Keep it to 40 topics or fewer' })
  saveAppRepoTopics(body.topics)
  return appRepoView()
})
