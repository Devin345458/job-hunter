import { createHash } from 'node:crypto'

// Read tokens for GitHub evidence and the few REST calls the indexer makes with them.
// A token never leaves this process: it is not logged, not stored, not returned by any API, and
// git receives it only through its environment (see git.ts). Errors name the path and the
// status, never a header.

export interface ReadToken {
  token: string
  /** Which setting it came from, for the Settings page. */
  source: 'NUXT_GITHUB_READ_TOKENS' | 'NUXT_GITHUB_READ_TOKEN' | 'NUXT_GITHUB_TOKEN'
  /** 0-based position, stored as repo_sources.token_index. */
  index: number
}

/**
 * Every configured read token, in order: the NUXT_GITHUB_READ_TOKENS list, then
 * NUXT_GITHUB_READ_TOKEN. Only when neither is set does NUXT_GITHUB_TOKEN (the push token) serve.
 */
export function readTokens(): ReadToken[] {
  const config = useRuntimeConfig()
  const out: ReadToken[] = []
  const seen = new Set<string>()
  const add = (raw: unknown, source: ReadToken['source']) => {
    for (const t of String(raw ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
      if (seen.has(t)) continue
      seen.add(t)
      out.push({ token: t, source, index: out.length })
    }
  }
  add(config.githubReadTokens, 'NUXT_GITHUB_READ_TOKENS')
  add(config.githubReadToken, 'NUXT_GITHUB_READ_TOKEN')
  if (!out.length) add(config.githubToken, 'NUXT_GITHUB_TOKEN')
  return out
}

/** Short fingerprint for in-memory cache keys, so a changed token is never served stale data. */
function fingerprint(token: string) {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

export class GithubApiError extends Error {
  constructor(public status: number, path: string, detail = '') {
    super(`GitHub returned ${status} for ${path}${detail ? `: ${detail}` : ''}`)
  }
}

// ── SAML single sign-on ──
// An organization that enforces SAML SSO refuses a token until someone authorizes it for that
// organization (Configure SSO next to the token on github.com/settings/tokens). GitHub then answers
// 403 with a message naming SAML, git prints "organization has enabled or enforced SAML SSO", and
// list endpoints leave the organization's repos out with an X-GitHub-SSO: partial-results header.

/** True when an error message (REST, GraphQL, or git stderr) is an SSO refusal. */
export function isSsoError(message: string | null | undefined): boolean {
  return /\bSAML\b|single sign-on|SSO enforcement|enforced SAML/i.test(String(message ?? ''))
}

/** What Settings shows for an organization the token is not authorized for yet. */
export function ssoMessage(org: string): string {
  return `Authorize this token for ${org} in GitHub (Configure SSO next to the token)`
}

/** True when a repo's stored skip reason is the SSO message above. */
export function isSsoSkip(skipReason: string | null | undefined): boolean {
  return String(skipReason ?? '').startsWith('Authorize this token for ')
}

/** Organization ids from an `X-GitHub-SSO: partial-results; organizations=1,2` header. */
export function ssoPartialOrgIds(header: string | null | undefined): number[] {
  const m = /organizations=([\d,\s]+)/i.exec(String(header ?? ''))
  if (!m) return []
  return [...new Set(m[1]!.split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0))]
}

const orgNameCache = new Map<number, string>()

/** Organization logins for the ids an SSO header named. Falls back to the id when GitHub will not say. */
export async function orgLogins(token: string, ids: number[]): Promise<string[]> {
  const out: string[] = []
  for (const id of ids) {
    let login = orgNameCache.get(id)
    if (!login) {
      try {
        login = (await githubGet<{ login: string }>(token, `/organizations/${id}`)).login
        orgNameCache.set(id, login)
      }
      catch {
        login = `organization ${id}`
      }
    }
    out.push(login)
  }
  return out
}

/** One GET against the REST API. Follows the Link header when `all` is set. */
export async function githubGet<T = any>(token: string, path: string, opts: { all?: boolean; maxPages?: number; onResponse?: (res: Response) => void } = {}): Promise<T> {
  let url: string | null = path.startsWith('https://') ? path : `https://api.github.com${path}`
  const pages: any[] = []
  let page = 0
  while (url) {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'job-hunter-repo-evidence',
      },
      signal: AbortSignal.timeout(30_000),
    })
    const shown = new URL(url).pathname
    opts.onResponse?.(res)
    if (!res.ok) {
      let detail = ''
      try {
        detail = String(((await res.json()) as any)?.message ?? '').slice(0, 160)
      }
      catch {}
      throw new GithubApiError(res.status, shown, detail)
    }
    const body = await res.json()
    if (!opts.all) return body as T
    pages.push(...(Array.isArray(body) ? body : []))
    page++
    if (opts.maxPages && page >= opts.maxPages) break
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')
    url = next ? next[1]! : null
  }
  return pages as T
}

export interface TokenAccount {
  index: number
  source: ReadToken['source']
  login: string | null
  userId: number | null
  /** The account's public email, when it shows one. */
  email: string | null
  repos: GithubRepo[]
  /** Organizations whose repos GitHub left out because they enforce SAML SSO and the token is not authorized for them. */
  ssoOrgs: string[]
  error: string | null
}

export interface GithubRepo {
  full_name: string
  name: string
  owner: { login: string; type: string }
  private: boolean
  fork: boolean
  archived: boolean
  size: number
  default_branch: string
  html_url: string
  pushed_at: string | null
  description?: string | null
}

const accountCache = new Map<string, { at: number; account: TokenAccount }>()
const ACCOUNT_TTL_MS = 10 * 60_000

/** The account behind each token and the repos it can read. Cached ten minutes per token. */
export async function tokenAccounts(opts: { fresh?: boolean } = {}): Promise<TokenAccount[]> {
  const tokens = readTokens()
  return Promise.all(tokens.map(async (t) => {
    const key = `${t.index}:${fingerprint(t.token)}`
    const hit = accountCache.get(key)
    if (hit && !opts.fresh && Date.now() - hit.at < ACCOUNT_TTL_MS) return hit.account
    const account: TokenAccount = { index: t.index, source: t.source, login: null, userId: null, email: null, repos: [], ssoOrgs: [], error: null }
    try {
      const user = await githubGet<{ login: string; id: number; email: string | null }>(t.token, '/user')
      account.login = user.login
      account.userId = user.id
      account.email = user.email || null
      // A classic token lists every repo the user can reach, across every organization. One that an
      // SSO organization has not authorized gets that organization's repos left out, with a header.
      const ssoIds = new Set<number>()
      account.repos = await githubGet<GithubRepo[]>(t.token, '/user/repos?per_page=100&sort=pushed', {
        all: true,
        maxPages: 50,
        onResponse: res => ssoPartialOrgIds(res.headers.get('x-github-sso')).forEach(id => ssoIds.add(id)),
      })
      if (ssoIds.size) account.ssoOrgs = await orgLogins(t.token, [...ssoIds])
    }
    catch (e: any) {
      account.error = e instanceof GithubApiError && (e.status === 401 || e.status === 403)
        ? 'GitHub refused this token. Check that it is valid and has the repo scope (classic token) or Contents and Metadata read access (fine-grained token).'
        : (e?.message || 'Could not reach GitHub').slice(0, 300)
    }
    accountCache.set(key, { at: Date.now(), account })
    return account
  }))
}

/** The token a repo is read with, by its stored position. */
export function tokenAt(index: number | null | undefined): string | null {
  if (index == null) return null
  return readTokens()[index]?.token ?? null
}

/** Byte counts per language for one repo. */
export async function repoLanguages(token: string, fullName: string): Promise<Record<string, number>> {
  return githubGet<Record<string, number>>(token, `/repos/${fullName}/languages`)
}

/**
 * The GitHub account each commit is attributed to (GitHub links a commit to an account by its
 * author email), or null when the email belongs to no account. One GraphQL request per 50 commits.
 */
export async function commitLogins(token: string, fullName: string, shas: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  const [owner, name] = fullName.split('/')
  for (let i = 0; i < shas.length; i += 50) {
    const batch = shas.slice(i, i + 50).filter(s => /^[0-9a-f]{40}$/.test(s))
    if (!batch.length) continue
    const fields = batch.map((sha, j) => `c${j}: object(oid: "${sha}") { ... on Commit { author { user { login } } } }`).join('\n')
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'job-hunter-repo-evidence' },
      body: JSON.stringify({ query: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`, variables: { owner, name } }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new GithubApiError(res.status, '/graphql')
    const body = await res.json() as { data?: { repository?: Record<string, { author?: { user?: { login?: string } | null } | null } | null> }; errors?: Array<{ message?: string }> }
    const repo = body.data?.repository
    if (!repo) throw new Error(`GitHub GraphQL did not return ${fullName}: ${(body.errors ?? []).map(e => e.message).join('; ').slice(0, 200)}`)
    batch.forEach((sha, j) => out.set(sha, repo[`c${j}`]?.author?.user?.login ?? null))
  }
  return out
}

// ── Commit search ──

export interface SearchCommitItem {
  sha: string
  repository: {
    full_name: string
    name: string
    owner: { login: string; type: string }
    private: boolean
    fork: boolean
    html_url: string
  }
  commit: { author: { date: string }; message?: string }
}

export interface SearchPage {
  total: number
  incomplete: boolean
  items: SearchCommitItem[]
  /** Organization ids GitHub left out for SSO, from the X-GitHub-SSO header. */
  ssoOrgIds: number[]
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * One page of GET /search/commits. Search allows 30 requests a minute, so this waits for the
 * window to reset (X-RateLimit-Reset, or Retry-After for the secondary limit) and tries again
 * instead of failing. `onWait` reports each wait in seconds.
 */
export async function searchCommits(token: string, q: string, page: number, opts: { perPage?: number; onWait?: (seconds: number) => void } = {}): Promise<SearchPage> {
  const params = new URLSearchParams({ q, sort: 'author-date', order: 'asc', per_page: String(opts.perPage ?? 100), page: String(page) })
  const url = `https://api.github.com/search/commits?${params}`
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'job-hunter-repo-evidence',
      },
      signal: AbortSignal.timeout(60_000),
    })
    if (res.ok) {
      const body = await res.json() as { total_count?: number; incomplete_results?: boolean; items?: SearchCommitItem[] }
      // Stay inside the window: when it is spent, wait here so the next call does not bounce.
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        const wait = waitMs(res)
        opts.onWait?.(Math.ceil(wait / 1000))
        await sleep(wait)
      }
      return { total: Number(body.total_count) || 0, incomplete: !!body.incomplete_results, items: body.items ?? [], ssoOrgIds: ssoPartialOrgIds(res.headers.get('x-github-sso')) }
    }
    let detail = ''
    try {
      detail = String(((await res.json()) as any)?.message ?? '').slice(0, 200)
    }
    catch {}
    const limited = res.status === 429 || (res.status === 403 && (/rate limit/i.test(detail) || res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')))
    if (limited && attempt < 8) {
      const wait = waitMs(res)
      opts.onWait?.(Math.ceil(wait / 1000))
      await sleep(wait)
      continue
    }
    if (res.status >= 500 && attempt < 2) {
      await sleep(5000)
      continue
    }
    throw new GithubApiError(res.status, '/search/commits', detail)
  }
}

function waitMs(res: Response): number {
  const retry = Number(res.headers.get('retry-after'))
  if (Number.isFinite(retry) && retry > 0) return retry * 1000 + 500
  const reset = Number(res.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0) return Math.min(Math.max(reset * 1000 - Date.now(), 0) + 1000, 5 * 60_000)
  return 60_000
}

// ── Code search ──

export interface CodeSearchItem {
  path: string
  html_url: string
  repository: { full_name: string }
}

export interface CodeSearchPage {
  total: number
  items: CodeSearchItem[]
}

/** Code search allows 10 requests a minute. The chat never waits that out: it reports the limit instead. */
export class CodeSearchLimited extends Error {
  constructor(public seconds: number) {
    super(`GitHub code search allows 10 searches a minute; try again in ${seconds} seconds`)
  }
}

/**
 * One GET /search/code. The query must name its repos with repo: qualifiers (the caller passes
 * only repos Devin switched on). Throws CodeSearchLimited on the rate limit and GithubApiError
 * otherwise, never with the token in the message.
 */
export async function searchCode(token: string, q: string, perPage = 30): Promise<CodeSearchPage> {
  const params = new URLSearchParams({ q, per_page: String(perPage) })
  const res = await fetch(`https://api.github.com/search/code?${params}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'job-hunter-repo-evidence',
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (res.ok) {
    const body = await res.json() as { total_count?: number; items?: CodeSearchItem[] }
    return { total: Number(body.total_count) || 0, items: body.items ?? [] }
  }
  let detail = ''
  try {
    detail = String(((await res.json()) as any)?.message ?? '').slice(0, 200)
  }
  catch {}
  if (res.status === 429 || (res.status === 403 && (/rate limit/i.test(detail) || res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')))) {
    throw new CodeSearchLimited(Math.max(1, Math.ceil(waitMs(res) / 1000)))
  }
  throw new GithubApiError(res.status, '/search/code', detail)
}
