// Small HTTP helpers shared by the job sources and enrichment.

export const USER_AGENT = 'job-hunter/1.0 (personal job search; contact via github.com/Devin345458)'
export const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly url: string, public readonly body: string) {
    super(`HTTP ${status} from ${new URL(url).host}${body ? `: ${body.slice(0, 200)}` : ''}`)
    this.name = 'HttpError'
  }
}

function redact(url: string) {
  return url.replace(/(app_key|api_key|key)=[^&]+/gi, '$1=***')
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Per-host spacing between requests, so paging through a source stays inside its rate limit.
const nextSlot = new Map<string, number>()

async function waitForHost(host: string, minIntervalMs: number) {
  if (!minIntervalMs) return
  const now = Date.now()
  const at = Math.max(now, nextSlot.get(host) ?? 0)
  nextSlot.set(host, at + minIntervalMs)
  if (at > now) await sleep(at - now)
}

/** Seconds from a Retry-After header (seconds or an HTTP date), capped at a minute. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null
  const secs = Number(header)
  if (Number.isFinite(secs)) return Math.min(60000, Math.max(0, secs * 1000))
  const at = Date.parse(header)
  return Number.isNaN(at) ? null : Math.min(60000, Math.max(0, at - Date.now()))
}

// Responses kept for the length of one search run, so a second search config reads the same
// pages from memory instead of asking the source again. Only requests that pass cache: true use it.
let runCache: Map<string, Promise<unknown>> | null = null

export function startRunCache() {
  runCache = new Map()
}

export function endRunCache() {
  runCache = null
}

export interface FetchJsonOptions {
  headers?: Record<string, string>
  timeoutMs?: number
  /** Least time between two requests to the same host. */
  minIntervalMs?: number
  /** Retries after HTTP 429 or 503, honoring Retry-After, with doubling waits. Default 3. */
  retries?: number
  /** Reuse the response for the same URL within one search run. */
  cache?: boolean
}

async function fetchJsonOnce<T>(url: string, opts: FetchJsonOptions): Promise<T> {
  const host = new URL(url).host
  const retries = opts.retries ?? 3
  for (let attempt = 0; ; attempt++) {
    await waitForHost(host, opts.minIntervalMs ?? 0)
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...opts.headers },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
    })
    if (res.ok) return await res.json() as T
    const body = await res.text().catch(() => '')
    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      const wait = retryAfterMs(res.headers.get('retry-after')) ?? 2000 * 2 ** attempt
      await sleep(wait)
      continue
    }
    throw new HttpError(res.status, redact(url), body.replace(/\s+/g, ' ').trim())
  }
}

/** GET a URL and parse JSON. Throws HttpError on a non-2xx status (after retrying 429 and 503). */
export async function fetchJson<T = any>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  if (opts.cache && runCache) {
    const hit = runCache.get(url)
    if (hit) return await hit as T
    const pending = fetchJsonOnce<T>(url, opts)
    runCache.set(url, pending)
    pending.catch(() => runCache?.delete(url))
    return await pending
  }
  return await fetchJsonOnce<T>(url, opts)
}

/** GET a feed or page as text with the job-hunter user agent (RSS, XML), with the same retry rules. */
export async function fetchFeed(url: string, opts: FetchJsonOptions = {}): Promise<string> {
  const run = async () => {
    const host = new URL(url).host
    const retries = opts.retries ?? 3
    for (let attempt = 0; ; attempt++) {
      await waitForHost(host, opts.minIntervalMs ?? 0)
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml, text/xml, */*', ...opts.headers },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
      })
      const text = await res.text().catch(() => '')
      if (res.ok) return text
      if ((res.status === 429 || res.status === 503) && attempt < retries) {
        await sleep(retryAfterMs(res.headers.get('retry-after')) ?? 2000 * 2 ** attempt)
        continue
      }
      throw new HttpError(res.status, redact(url), text.replace(/\s+/g, ' ').trim())
    }
  }
  if (opts.cache && runCache) {
    const hit = runCache.get(url)
    if (hit) return await hit as string
    const pending = run()
    runCache.set(url, pending)
    pending.catch(() => runCache?.delete(url))
    return await pending
  }
  return await run()
}

/** GET a page as text, following redirects. Returns the final URL too. */
export async function fetchText(url: string, opts: { timeoutMs?: number } = {}): Promise<{ status: number; finalUrl: string; text: string }> {
  const res = await fetch(url, {
    headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
  })
  const text = await res.text().catch(() => '')
  return { status: res.status, finalUrl: res.url || url, text }
}

/** Runs fn over items with at most `limit` in flight. Results keep the input order. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!, i)
    }
  }))
  return out
}

/**
 * Non-fatal problems a source hit during its last search (one board down, a filter it could
 * not apply). The search run copies these into pipeline_runs stats.
 */
export const sourceWarnings = new Map<string, string[]>()

export function warn(source: string, message: string) {
  const list = sourceWarnings.get(source) ?? []
  list.push(message)
  sourceWarnings.set(source, list)
}
