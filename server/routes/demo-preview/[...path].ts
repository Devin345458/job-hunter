import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { H3Event } from 'h3'
import { demoRoot, PREVIEW_DIR, previewTokenMatches } from '~~/server/utils/demo/preview-state'
import { getDemo } from '~~/server/utils/demo/store'

// GET /demo-preview/<id>/<token>/<path>: the static build of a demo's web UI. Public (the
// auth middleware lets the prefix through); the token is an HMAC of the demo id keyed with
// NUXT_SESSION_PASSWORD, and a wrong one is a 404.
//
// The files are model-written code. Every response puts the document in a sandbox with an
// opaque origin (no allow-same-origin), so it cannot read the session cookie or call /api,
// and connect-src 'none' stops fetch, XHR, and WebSockets outright. Because the origin is
// opaque, module scripts and fonts arrive as cross-origin requests; Access-Control-Allow-Origin
// lets them load. That header is safe here: these files are public to anyone with the token.

const CSP = [
  'sandbox allow-scripts',
  "connect-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ')

const MAX_BYTES = 25_000_000

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

function notFound(event: H3Event) {
  setResponseStatus(event, 404)
  setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
  return 'Not found'
}

/** Reads <root>/.preview/<segments> only when it really is a regular file inside that folder. */
function readPreviewFile(root: string, segments: string[]): Buffer | null {
  const dir = join(root, PREVIEW_DIR)
  let fd: number | undefined
  try {
    if (!lstatSync(dir).isDirectory()) return null // a symlinked .preview is refused
    const realRoot = realpathSync(root)
    const realDir = realpathSync(dir)
    if (!realDir.startsWith(`${realRoot}/`)) return null
    const real = realpathSync(join(realDir, ...segments))
    if (!real.startsWith(`${realDir}/`)) return null
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW)
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > MAX_BYTES) return null
    return readFileSync(fd)
  }
  catch {
    return null
  }
  finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export default defineEventHandler((event) => {
  setResponseHeaders(event, {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  })
  if (event.method !== 'GET' && event.method !== 'HEAD') {
    setResponseStatus(event, 405)
    return 'Method not allowed'
  }

  // The parsed URL has dot segments resolved already, the same path the auth middleware checked.
  const pathname = getRequestURL(event).pathname
  const m = /^\/demo-preview\/(\d{1,9})\/([A-Za-z0-9_-]{1,100})(\/.*)?$/.exec(pathname)
  if (!m) return notFound(event)
  const id = Number(m[1])
  const demo = getDemo(id)
  if (!demo || !previewTokenMatches(id, m[2]!)) return notFound(event)
  // Relative asset paths need the trailing slash.
  if (m[3] === undefined) return sendRedirect(event, `${pathname}/`, 302)

  let segments: string[]
  try {
    segments = m[3].split('/').filter(Boolean).map(s => decodeURIComponent(s))
  }
  catch {
    return notFound(event)
  }
  if (segments.some(s => s.startsWith('.') || /[/\\\0]/.test(s))) return notFound(event)
  if (segments.length === 0 || m[3].endsWith('/')) segments.push('index.html')

  const body = readPreviewFile(demoRoot(demo), segments)
  if (!body) return notFound(event)
  setResponseHeader(event, 'Content-Type', TYPES[extname(segments[segments.length - 1]!).toLowerCase()] ?? 'application/octet-stream')
  return body
})
