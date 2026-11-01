import { desc } from 'drizzle-orm'
import { sandboxSubmissions } from '~~/server/db/schema'

// Behind login. What the sandbox employer received.
export default defineEventHandler(() => {
  const rows = useDb().select().from(sandboxSubmissions).orderBy(desc(sandboxSubmissions.id)).limit(50).all()
  return {
    submissions: rows.map(r => ({
      id: r.id,
      createdAt: r.createdAt,
      userAgent: r.userAgent,
      payload: parseJson<Record<string, unknown>>(r.payloadJson, {}),
      files: parseJson<Array<{ field: string; filename: string; bytes: number }>>(r.filesJson, []).map(f => ({ field: f.field, filename: f.filename, bytes: f.bytes })),
    })),
  }
})
