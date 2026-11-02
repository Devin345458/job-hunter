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

/** One GET against the REST API. Follows the Link header when `all` is set. */
export async function githubGet<T = any>(token: string, path: string, opts: { all?: boolean; maxPages?: number } = {}): Promise<T> {
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
    const account: TokenAccount = { index: t.index, source: t.source, login: null, userId: null, email: null, repos: [], error: null }
    try {
      const user = await githubGet<{ login: string; id: number; email: string | null }>(t.token, '/user')
      account.login = user.login
      account.userId = user.id
      account.email = user.email || null
      account.repos = await githubGet<GithubRepo[]>(t.token, '/user/repos?per_page=100&sort=pushed', { all: true, maxPages: 50 })
    }
    catch (e: any) {
      account.error = e instanceof GithubApiError && (e.status === 401 || e.status === 403)
        ? 'GitHub refused this token. Check that it is valid and has Contents and Metadata read access.'
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
