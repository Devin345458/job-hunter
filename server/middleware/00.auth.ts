// Gate for the whole app. Without a valid owner session:
// - /api/* returns 401
// - every page redirects to /login
// The only public surface is the login page and endpoint, the health check, static
// build assets, and the sandbox employer form (which checks its own token).

const PUBLIC_PREFIXES = [
  '/_nuxt/',
  '/__nuxt',
  '/_fonts/',
  '/api/auth/login',
  '/api/auth/session',
  '/api/health',
  '/api/sandbox/submit/',
  '/sandbox/apply/',
  '/sandbox/jobs/',
  '/api/sandbox/job',
]
const PUBLIC_EXACT = new Set(['/login', '/favicon.ico', '/robots.txt'])

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname

  // Cloudflare tells us the visitor's scheme. Keep the session cookie on https only.
  const visitor = getRequestHeader(event, 'cf-visitor')
  if (visitor && visitor.includes('"http"') && !import.meta.dev) {
    const url = getRequestURL(event)
    return sendRedirect(event, `https://${url.host}${url.pathname}${url.search}`, 301)
  }

  setResponseHeader(event, 'X-Robots-Tag', 'noindex, nofollow')

  if (PUBLIC_EXACT.has(path) || PUBLIC_PREFIXES.some(p => path.startsWith(p))) return

  if (await isLoggedIn(event)) return

  if (path.startsWith('/api/')) {
    throw createError({ statusCode: 401, statusMessage: 'Login required' })
  }

  const next = encodeURIComponent(getRequestURL(event).pathname + getRequestURL(event).search)
  return sendRedirect(event, `/login?next=${next}`, 302)
})
