import { existsSync, readFileSync, statSync } from 'node:fs'
import { confinedPath } from '~~/server/utils/demo/exec'
import { getDemo } from '~~/server/utils/demo/store'

const MAX_BYTES = 300_000

// GET /api/demos/:id/file?path=src/main.go: one committed file from the demo repo, as text.
export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'))
  const demo = Number.isInteger(id) ? getDemo(id) : null
  if (!demo?.localPath) throw createError({ statusCode: 404, statusMessage: 'Demo not found' })
  const rel = String(getQuery(event).path || '')
  const tracked = parseJson<Array<{ path: string }>>(demo.filesJson, [])
  if (!tracked.some(f => f.path === rel)) throw createError({ statusCode: 404, statusMessage: 'File not in this demo' })
  let full: string
  try {
    full = confinedPath(resolveStoredPath(demo.localPath), rel)
  }
  catch {
    throw createError({ statusCode: 400, statusMessage: 'Bad path' })
  }
  if (!existsSync(full)) throw createError({ statusCode: 404, statusMessage: 'File missing on disk' })
  const bytes = statSync(full).size
  const buf = readFileSync(full)
  const binary = buf.subarray(0, 8000).includes(0)
  return {
    path: rel,
    bytes,
    binary,
    truncated: bytes > MAX_BYTES,
    content: binary ? null : buf.subarray(0, MAX_BYTES).toString('utf8'),
  }
})
