import { eq, sql } from 'drizzle-orm'
import { applications } from '~~/server/db/schema'

export default defineEventHandler(async (event) => {
  const db = useDb()
  const id = Number(getRouterParam(event, 'id'))
  const body = await readBody(event)

  if (!id || isNaN(id)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid application ID',
    })
  }

  try {
    const existingResult = await db
      .select()
      .from(applications)
      .where(eq(applications.id, id))

    const existing = existingResult?.[0]
    if (!existing) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Application not found',
      })
    }

    // Build update object from allowed fields
    const allowedFields = [
      'status', 'notes', 'coverLetter', 'tailoringNotes',
      'tailoredResumeJson', 'tailoredResumePdfPath',
      'submittedAt', 'responseAt',
    ] as const

    const updateData: Record<string, any> = {
      updatedAt: sql`(datetime('now'))`,
    }

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updateData[field] = body[field]
      }
    }

    await db
      .update(applications)
      .set(updateData)
      .where(eq(applications.id, id))

    const updatedResult = await db
      .select()
      .from(applications)
      .where(eq(applications.id, id))

    return updatedResult?.[0]
  } catch (error: any) {
    if (error.statusCode) throw error
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to update application',
    })
  }
})
