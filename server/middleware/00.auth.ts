// Gate for the whole app. Without a valid owner session:
// - /api/* returns 401
// - every page redirects to /login
// The only public surface is the login page and endpoint, the health check, static
// build assets, the sandbox employer form (which checks its own token), and demo previews
// (server/routes/demo-preview, which checks its own token and sandboxes the page).

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
  '/demo-preview/',
]
const PUBLIC_EXACT = new Set(['/login', '/favicon.ico', '/robots.txt'])

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname

  // A worker process (NUXT_ROLE=worker) runs the schedule and the job queue and serves nothing but
  // its health check; the web process serves the app.
  if (!servesApp() && path !== '/api/health') {
    throw createError({ statusCode: 404, statusMessage: 'This process is the job worker; it serves only /api/health' })
  }

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
