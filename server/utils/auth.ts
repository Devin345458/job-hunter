import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'

// Single-user login. The password hash and the session secret come from env
// (NUXT_AUTH_PASSWORD_HASH, NUXT_SESSION_PASSWORD), so the only credential lives
// with whoever controls the Coolify environment.
//
// Hash format: scrypt:<N>:<r>:<p>:<saltBase64>:<hashBase64>
// (colons, not dollar signs, so env tooling never tries to interpolate the value; the older
// dollar-separated form is still accepted)
// Generate one with: node scripts/hash-password.mjs

export interface AppSession {
  user?: 'owner'
  loggedInAt?: string
}

const SESSION_NAME = 'jh_session'
const SESSION_MAX_AGE = 60 * 60 * 24 * 30

export function hashPassword(password: string, N = 2 ** 15, r = 8, p = 1): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64, { N, r, p, maxmem: 128 * N * r * 2 })
  return ['scrypt', N, r, p, salt.toString('base64'), hash.toString('base64')].join(':')
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.trim().split(stored.includes(':') ? ':' : '$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts as [string, string, string, string, string, string]
  const N = Number(nStr)
  const r = Number(rStr)
  const p = Number(pStr)
  const expected = Buffer.from(hashB64, 'base64')
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N, r, p, maxmem: 128 * N * r * 2 })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function authConfigured(): boolean {
  const config = useRuntimeConfig()
  return Boolean(config.authPasswordHash && config.sessionPassword && config.sessionPassword.length >= 32)
}

export function getAppSession(event: H3Event) {
  const config = useRuntimeConfig()
  return useSession<AppSession>(event, {
    name: SESSION_NAME,
    password: config.sessionPassword,
    maxAge: SESSION_MAX_AGE,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: !import.meta.dev,
      path: '/',
    },
  })
}

export async function isLoggedIn(event: H3Event): Promise<boolean> {
  if (!authConfigured()) return false
  // Skip cookie parsing entirely when there is no session cookie.
  if (!getCookie(event, SESSION_NAME)) return false
  try {
    const session = await getAppSession(event)
    return session.data.user === 'owner'
  }
  catch {
    return false
  }
}

export async function requireOwner(event: H3Event): Promise<void> {
  if (!(await isLoggedIn(event))) {
    throw createError({ statusCode: 401, statusMessage: 'Login required' })
  }
}

// ── Brute-force protection ──
// Per client: 5 failures in 15 minutes locks that client for 15 minutes.
// Global: 20 failures in an hour locks every login for an hour, which covers attacks
// spread across many IPs. In memory, so a restart clears it; the hash cost (scrypt N=2^15)
// still caps guesses at a few per second.

const CLIENT_WINDOW_MS = 15 * 60 * 1000
const CLIENT_LIMIT = 5
const GLOBAL_WINDOW_MS = 60 * 60 * 1000
const GLOBAL_LIMIT = 20

const clientFailures = new Map<string, number[]>()
let globalFailures: number[] = []

export function clientKey(event: H3Event): string {
  return getRequestHeader(event, 'cf-connecting-ip')
    || getRequestHeader(event, 'x-real-ip')
    || getRequestIP(event, { xForwardedFor: true })
    || 'unknown'
}

function recent(times: number[], windowMs: number, now: number) {
  return times.filter(t => now - t < windowMs)
}

/** Seconds until this client may try again, or 0 when allowed. */
export function loginLockedFor(key: string): number {
  const now = Date.now()
  globalFailures = recent(globalFailures, GLOBAL_WINDOW_MS, now)
  if (globalFailures.length >= GLOBAL_LIMIT) {
    return Math.ceil((GLOBAL_WINDOW_MS - (now - globalFailures[0]!)) / 1000)
  }
  const mine = recent(clientFailures.get(key) || [], CLIENT_WINDOW_MS, now)
  clientFailures.set(key, mine)
  if (mine.length >= CLIENT_LIMIT) {
    return Math.ceil((CLIENT_WINDOW_MS - (now - mine[0]!)) / 1000)
  }
  return 0
}

export function recordLoginFailure(key: string) {
  const now = Date.now()
  globalFailures.push(now)
  clientFailures.set(key, [...recent(clientFailures.get(key) || [], CLIENT_WINDOW_MS, now), now])
}

export function clearLoginFailures(key: string) {
  clientFailures.delete(key)
}
