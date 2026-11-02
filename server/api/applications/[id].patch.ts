import { eq, sql } from 'drizzle-orm'
import { applications } from '~~/server/db/schema'
import type { ApplicationOutcomeRequest } from '#shared/types/pipeline'
import { OutcomeRefused, recordOutcome } from '~~/server/utils/outcomes'

// PATCH /api/applications/:id: notes and the other editable fields, and the status moves Devin
// makes by hand. Status may only become an employer outcome (from submitted or another outcome) or
// submitted from approved or needs_manual ("I submitted it"); body { status, date?, note? }, see
// ApplicationOutcomeRequest. Every other status change is 400: pipeline statuses (approved,
// submitting, publishing, declined, proposed, and the rest) are set only by their own code paths.
export default defineEventHandler(async (event) => {
  const db = useDb()
  const id = Number(getRouterParam(event, 'id'))
  const body = (await readBody(event)) ?? {}

  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid application ID' })
  }

  const existing = db.select().from(applications).where(eq(applications.id, id)).get()
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'Application not found' })

  if (body.status !== undefined) {
    if (typeof body.status !== 'string' || !body.status) {
      throw createError({ statusCode: 400, statusMessage: 'Status must be a status name' })
    }
    const { status, date, note } = body as ApplicationOutcomeRequest
    try {
      recordOutcome(id, status, date ?? null, note ?? null)
    }
    catch (e: any) {
      if (e instanceof OutcomeRefused) throw createError({ statusCode: 400, statusMessage: e.message })
      throw e
    }
  }

  // Other editable fields. submittedAt and responseAt are set by the status moves above.
  const allowedFields = ['notes', 'coverLetter', 'tailoringNotes', 'tailoredResumeJson', 'tailoredResumePdfPath', 'submittedAt', 'responseAt'] as const
  const updateData: Record<string, any> = {}
  for (const field of allowedFields) {
    if (body[field] !== undefined && !(body.status !== undefined && (field === 'submittedAt' || field === 'responseAt'))) {
      updateData[field] = body[field]
    }
  }
  if (Object.keys(updateData).length > 0) {
    try {
      db.update(applications).set({ ...updateData, updatedAt: sql`(datetime('now'))` }).where(eq(applications.id, id)).run()
    }
    catch {
      throw createError({ statusCode: 500, statusMessage: 'Failed to update application' })
    }
  }

  return db.select().from(applications).where(eq(applications.id, id)).get()
})
