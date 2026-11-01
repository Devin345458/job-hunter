export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const category = query.category as string | undefined
  try {
    return loadKnowledge(category)
  }
  catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to fetch knowledge entries',
    })
  }
})
