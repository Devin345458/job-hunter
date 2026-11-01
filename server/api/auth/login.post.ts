export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  if (!authConfigured()) {
    throw createError({ statusCode: 503, statusMessage: 'Login is not configured on this server' })
  }

  const key = clientKey(event)
  const wait = loginLockedFor(key)
  if (wait > 0) {
    setResponseHeader(event, 'Retry-After', String(wait))
    throw createError({ statusCode: 429, statusMessage: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minutes.` })
  }

  const body = await readBody<{ password?: string }>(event)
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!password || !verifyPassword(password, config.authPasswordHash)) {
    recordLoginFailure(key)
    throw createError({ statusCode: 401, statusMessage: 'Wrong password' })
  }

  clearLoginFailures(key)
  const session = await getAppSession(event)
  await session.update({ user: 'owner', loggedInAt: new Date().toISOString() })
  return { ok: true }
})
