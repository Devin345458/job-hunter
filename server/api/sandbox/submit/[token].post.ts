import { writeFileSync } from 'node:fs'
import { sandboxSubmissions } from '~~/server/db/schema'

const REQUIRED = ['first_name', 'last_name', 'email', 'phone', 'work_authorized', 'needs_sponsorship', 'why_us', 'consent']

// Receives the sandbox application form as a normal multipart POST, the way a plain ATS form
// does, validates it like one, stores it, and redirects to the confirmation page.
export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')
  assertSandboxToken(token)
  const parts = (await readMultipartFormData(event)) || []
  const payload: Record<string, string | string[]> = {}
  const files: Array<{ field: string; filename: string; bytes: number; path: string }> = []
  const stamp = Date.now()
  for (const part of parts) {
    if (!part.name) continue
    if (part.filename) {
      if (!part.data?.length) continue
      const safe = part.filename.replace(/[^\w.-]+/g, '_').slice(0, 80)
      const path = dataPath('sandbox', String(stamp), `${part.name}-${safe}`)
      writeFileSync(path, part.data)
      files.push({ field: part.name, filename: part.filename, bytes: part.data.length, path })
      continue
    }
    const value = part.data.toString('utf8')
    const prev = payload[part.name]
    payload[part.name] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value]
  }
  const missing = REQUIRED.filter(k => !payload[k] || String(payload[k]).trim() === '')
  if (!files.some(f => f.field === 'resume')) missing.push('resume')
  if (missing.length > 0) {
    return sendRedirect(event, `/sandbox/apply/${token}?error=${encodeURIComponent(missing.join(','))}`, 303)
  }
  const row = useDb().insert(sandboxSubmissions).values({
    token: token!,
    payloadJson: JSON.stringify(payload),
    filesJson: JSON.stringify(files),
    userAgent: getRequestHeader(event, 'user-agent') || null,
  }).returning().get()
  return sendRedirect(event, `/sandbox/apply/${token}?submitted=${row.id}`, 303)
})
