import { eq } from 'drizzle-orm'
import { searchConfigs } from '~~/server/db/schema'

export default defineEventHandler(async (event) => {
  const db = useDb()
  const body = await readBody(event)

  if (!body.name || !body.keywords) {
    throw createError({
      statusCode: 400,
      statusMessage: 'name and keywords are required',
    })
  }

  try {
    // Ensure JSON fields are stored as strings
    const keywords = typeof body.keywords === 'string'
      ? body.keywords
      : JSON.stringify(body.keywords)

    const excludedKeywords = body.excludedKeywords
      ? (typeof body.excludedKeywords === 'string' ? body.excludedKeywords : JSON.stringify(body.excludedKeywords))
      : null

    const locations = body.locations
      ? (typeof body.locations === 'string' ? body.locations : JSON.stringify(body.locations))
      : null

    const jobSources = body.jobSources
      ? (typeof body.jobSources === 'string' ? body.jobSources : JSON.stringify(body.jobSources))
      : null

    // If an ID is provided, update the existing config
    if (body.id) {
      const configId = Number(body.id)

      const [existing] = await db
        .select()
        .from(searchConfigs)
        .where(eq(searchConfigs.id, configId))

      if (!existing) {
        throw createError({
          statusCode: 404,
          statusMessage: 'Search config not found',
        })
      }

      await db
        .update(searchConfigs)
        .set({
          name: body.name,
          keywords,
          excludedKeywords,
          locations,
          remoteOnly: body.remoteOnly ?? existing.remoteOnly,
          salaryMin: body.salaryMin ?? existing.salaryMin,
          salaryCurrency: body.salaryCurrency ?? existing.salaryCurrency,
          jobSources,
          isActive: body.isActive ?? existing.isActive,
        })
        .where(eq(searchConfigs.id, configId))

      const [updated] = await db
        .select()
        .from(searchConfigs)
        .where(eq(searchConfigs.id, configId))

      return updated
    }

    // Otherwise create a new config
    const [created] = await db
      .insert(searchConfigs)
      .values({
        name: body.name,
        keywords,
        excludedKeywords,
        locations,
        remoteOnly: body.remoteOnly ?? false,
        salaryMin: body.salaryMin ?? null,
        salaryCurrency: body.salaryCurrency ?? 'USD',
        jobSources,
        isActive: body.isActive ?? true,
      })
      .returning()

    return created
  } catch (error: any) {
    if (error.statusCode) throw error
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to save search config',
    })
  }
})
