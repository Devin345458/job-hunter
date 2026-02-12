import { searchConfigs } from '~~/server/db/schema'

export default defineEventHandler(async (event) => {
  const db = useDb()

  try {
    return await db
      .select()
      .from(searchConfigs)
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to fetch search configs',
    })
  }
})
