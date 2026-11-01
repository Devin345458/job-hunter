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

/** GET a URL and parse JSON. Throws HttpError on a non-2xx status. */
export async function fetchJson<T = any>(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<T> {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...opts.headers },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new HttpError(res.status, redact(url), body.replace(/\s+/g, ' ').trim())
  }
  return await res.json() as T
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
