import { knowledgeEntries } from '~~/server/db/schema'

export default defineEventHandler(async (event) => {
  const db = useDb()
  const body = await readBody(event)

  if (!body.category || !body.key || !body.value) {
    throw createError({
      statusCode: 400,
      statusMessage: 'category, key, and value are required',
    })
  }

  const validCategories = ['profile', 'experience', 'skill', 'preference', 'project', 'education', 'personal']
  if (!validCategories.includes(body.category)) {
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid category. Must be one of: ${validCategories.join(', ')}`,
    })
  }

  try {
    const [entry] = await db
      .insert(knowledgeEntries)
      .values({
        category: body.category,
        key: body.key,
        value: body.value,
        source: body.source || 'user_answer',
      })
      .returning()

    return entry
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to create knowledge entry',
    })
  }
})
