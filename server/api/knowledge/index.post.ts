// POST /api/knowledge { category, key, value, source? }
// Upserts by (category, key) so adding an entry that already exists updates it instead of
// creating another duplicate row (production already holds every seeded row three times).
const VALID_CATEGORIES = ['profile', 'experience', 'skill', 'preference', 'project', 'education', 'personal']
const VALID_SOURCES = ['resume', 'user_answer', 'inferred']

export default defineEventHandler(async (event) => {
  const body = await readBody<{ category?: string; key?: string; value?: string; source?: string }>(event)
  const category = body?.category?.trim()
  const key = body?.key?.trim()
  const value = body?.value?.trim()
  if (!category || !key || !value) {
    throw createError({ statusCode: 400, statusMessage: 'category, key, and value are required' })
  }
  if (!VALID_CATEGORIES.includes(category)) {
    throw createError({ statusCode: 400, statusMessage: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` })
  }
  const source = body?.source && VALID_SOURCES.includes(body.source) ? body.source : 'user_answer'
  const entry = upsertKnowledge(category, key, value, source)
  return { ...entry, negative: isNegativeKnowledge(entry.value) }
})
