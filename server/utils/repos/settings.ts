import { and, desc, eq, inArray, like, lt, or, sql } from 'drizzle-orm'
import { appSettings, pipelineRuns, repoCommits, repoFacts, repoSources, repoSuggestions } from '../../db/schema'
import type { RepoIdentities, RepoOwnerGroup, RepoSettingsView, RepoTokenView, RepoView } from '#shared/types/repos'
import { loadKnowledge, profileValue } from '../knowledge'
import { tokenAccounts, readTokens, type TokenAccount } from './github'
import { removeRepoCache } from './git'

// Settings > GitHub evidence: which repos the read tokens can see, which ones Devin switched on,
// and which commit authors count as him. Repos owned by his own login are on by default. Every
// organization's or other person's repo is off until he turns it on.

const IDENTITIES_KEY = 'repo_identities'
/** Re-list repos from GitHub when the stored list is older than this. */
const LIST_TTL_MS = 6 * 60 * 60_000

export const MAX_REPO_KB = 500 * 1024

export type RepoRow = typeof repoSources.$inferSelect

function nowSqlText() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

/** Lowercased logins that count as Devin's own accounts: each token's login plus NUXT_GITHUB_OWNER. */
export function personalLogins(accounts: TokenAccount[]): Set<string> {
  const set = new Set<string>()
  for (const a of accounts) if (a.login) set.add(a.login.toLowerCase())
  const owner = String(useRuntimeConfig().githubOwner || '').trim()
  if (owner) set.add(owner.toLowerCase())
  return set
}

// ── Author identities ──

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

export function cleanIdentities(input: { emails?: unknown; logins?: unknown }): { emails: string[]; logins: string[] } {
  const list = (v: unknown) => (Array.isArray(v) ? v : []).map(x => String(x ?? '').trim()).filter(Boolean)
  const emails = [...new Set(list(input.emails).map(e => e.toLowerCase()))].filter(e => EMAIL_RE.test(e)).slice(0, 20)
  const logins = [...new Map(list(input.logins).filter(l => LOGIN_RE.test(l)).map(l => [l.toLowerCase(), l])).values()].slice(0, 10)
  return { emails, logins }
}

/** Defaults: the knowledge base email, each token account's public email and GitHub noreply addresses, and the logins. */
export function defaultIdentities(accounts: TokenAccount[]): { emails: string[]; logins: string[] } {
  const emails: string[] = []
  const logins: string[] = []
  const kbEmail = profileValue(loadKnowledge('profile'), 'Email', 'email')
  if (kbEmail) emails.push(kbEmail)
  const kbGithub = profileValue(loadKnowledge('profile'), 'GitHub', 'Github', 'github')
  for (const a of accounts) {
    if (!a.login) continue
    if (a.email) emails.push(a.email)
    if (a.userId) emails.push(`${a.userId}+${a.login}@users.noreply.github.com`)
    emails.push(`${a.login}@users.noreply.github.com`)
    logins.push(a.login)
  }
  const owner = String(useRuntimeConfig().githubOwner || '').trim()
  if (owner) logins.push(owner)
  if (kbGithub && LOGIN_RE.test(kbGithub.replace(/^https?:\/\/github\.com\//i, '').replace(/\/.*$/, ''))) {
    logins.push(kbGithub.replace(/^https?:\/\/github\.com\//i, '').replace(/\/.*$/, ''))
  }
  return cleanIdentities({ emails, logins })
}

export function savedIdentities(): { emails: string[]; logins: string[] } | null {
  const row = useDb().select().from(appSettings).where(eq(appSettings.key, IDENTITIES_KEY)).get()
  if (!row) return null
  try {
    return cleanIdentities(JSON.parse(row.valueJson))
  }
  catch {
    return null
  }
}

/** The identities in force: what Devin saved, else the defaults. */
export function currentIdentities(accounts: TokenAccount[]): RepoIdentities {
  const saved = savedIdentities()
  if (saved) return { ...saved, edited: true }
  return { ...defaultIdentities(accounts), edited: false }
}

export function saveIdentities(input: { emails?: unknown; logins?: unknown } | null): void {
  const db = useDb()
  if (!input) {
    db.delete(appSettings).where(eq(appSettings.key, IDENTITIES_KEY)).run()
    return
  }
  const clean = cleanIdentities(input)
  if (!clean.emails.length && !clean.logins.length) {
    throw createError({ statusCode: 400, statusMessage: 'Keep at least one email or login, or nothing would count as yours.' })
  }
  const valueJson = JSON.stringify(clean)
  db.insert(appSettings).values({ key: IDENTITIES_KEY, valueJson, updatedAt: nowSqlText() })
    .onConflictDoUpdate({ target: appSettings.key, set: { valueJson, updatedAt: nowSqlText() } }).run()
}

const CANDIDATES_KEY = 'repo_identity_candidates'

/**
 * Emails on commits whose author name is one of his logins, that GitHub links to no account, and
 * that he has not listed. Written by each full repos:index run. Settings offers each one to add.
 */
export function saveIdentityCandidates(candidates: Record<string, { commits: number; repos: string[] }>) {
  const valueJson = JSON.stringify(candidates)
  useDb().insert(appSettings).values({ key: CANDIDATES_KEY, valueJson, updatedAt: nowSqlText() })
    .onConflictDoUpdate({ target: appSettings.key, set: { valueJson, updatedAt: nowSqlText() } }).run()
}

export function identityCandidates(listed: string[]): Array<{ email: string; commits: number; repos: string[] }> {
  const row = useDb().select().from(appSettings).where(eq(appSettings.key, CANDIDATES_KEY)).get()
  let all: Record<string, { commits: number; repos: string[] }> = {}
  try {
    all = row ? JSON.parse(row.valueJson) : {}
  }
  catch {}
  const have = new Set(listed.map(e => e.toLowerCase()))
  return Object.entries(all)
    .filter(([email]) => !have.has(email.toLowerCase()))
    .map(([email, v]) => ({ email, commits: v.commits, repos: v.repos }))
    .sort((a, b) => b.commits - a.commits)
}

// ── Repo list ──

/**
 * Re-list every repo the tokens can see and store it. A repo seen for the first time gets its
 * default switch: on for Devin's own login, off for everyone else. Repos no token lists anymore
 * lose their index and their clone.
 */
export async function refreshRepoList(accounts?: TokenAccount[]): Promise<{ accounts: TokenAccount[]; error: string | null }> {
  accounts ??= await tokenAccounts({ fresh: true })
  const db = useDb()
  const personal = personalLogins(accounts)
  const at = nowSqlText()
  const seen = new Set<string>()
  const failed = accounts.filter(a => a.error)
  for (const a of accounts) {
    for (const r of a.repos) {
      if (seen.has(r.full_name)) continue
      seen.add(r.full_name)
      const values = {
        owner: r.owner.login,
        name: r.name,
        ownerType: r.owner.type ?? null,
        isPrivate: !!r.private,
        isFork: !!r.fork,
        archived: !!r.archived,
        sizeKb: Number(r.size) || 0,
        defaultBranch: r.default_branch || null,
        htmlUrl: r.html_url || null,
        pushedAt: r.pushed_at || null,
        tokenIndex: a.index,
        listedAt: at,
        updatedAt: at,
      }
      db.insert(repoSources).values({ fullName: r.full_name, ...values, included: personal.has(r.owner.login.toLowerCase()) })
        .onConflictDoUpdate({ target: repoSources.fullName, set: values }).run()
    }
  }
  // Only forget repos when every token answered. A failed token must not wipe its repos.
  if (!failed.length) {
    const gone = db.select().from(repoSources).where(or(lt(repoSources.listedAt, at), sql`${repoSources.listedAt} is null`)).all()
    for (const g of gone) forgetRepoData(g.fullName)
    if (gone.length) db.delete(repoSources).where(inArray(repoSources.fullName, gone.map(g => g.fullName))).run()
  }
  return { accounts, error: failed.length ? failed.map(a => `Token ${a.index + 1}: ${a.error}`).join(' ') : null }
}

/** Drop everything indexed from one repo: commits, facts, the clone, and suggestions that cite it. */
export function forgetRepoData(fullName: string) {
  const db = useDb()
  db.delete(repoCommits).where(eq(repoCommits.repo, fullName)).run()
  db.delete(repoFacts).where(eq(repoFacts.repo, fullName)).run()
  db.delete(repoSuggestions).where(like(repoSuggestions.evidenceJson, `%"repo":${JSON.stringify(fullName)}%`)).run()
  try {
    removeRepoCache(fullName)
  }
  catch (e) {
    console.warn(`[repos] could not remove the clone of ${fullName}`, e)
  }
  db.update(repoSources).set({ headSha: null, indexedAt: null, commitCount: null, indexError: null, skipReason: null }).where(eq(repoSources.fullName, fullName)).run()
}

/** Switch one repo on or off. Off forgets its index at once, so nothing from it is cited again. */
export function setRepoIncluded(fullName: string, included: boolean): RepoRow {
  const db = useDb()
  const row = db.select().from(repoSources).where(eq(repoSources.fullName, fullName)).get()
  if (!row) throw createError({ statusCode: 404, statusMessage: 'That repo is not in the list. Refresh the list and try again.' })
  db.update(repoSources).set({ included, updatedAt: nowSqlText() }).where(eq(repoSources.fullName, fullName)).run()
  if (!included) forgetRepoData(fullName)
  return db.select().from(repoSources).where(eq(repoSources.fullName, fullName)).get()!
}

export function includedRepos(): RepoRow[] {
  return useDb().select().from(repoSources).where(eq(repoSources.included, true)).all()
}

function toRepoView(r: RepoRow): RepoView {
  return {
    fullName: r.fullName,
    name: r.name,
    isPrivate: r.isPrivate,
    isFork: r.isFork,
    archived: r.archived,
    sizeMb: r.sizeKb != null ? Math.round((r.sizeKb / 1024) * 10) / 10 : null,
    included: !!r.included,
    pushedAt: r.pushedAt,
    htmlUrl: r.htmlUrl,
    indexedAt: r.indexedAt,
    commitCount: r.commitCount,
    skipReason: r.skipReason,
    indexError: r.indexError,
  }
}

/** Everything the Settings section shows. Lists repos from GitHub when the stored list is stale. */
export async function repoSettingsView(opts: { refresh?: boolean } = {}): Promise<RepoSettingsView> {
  const db = useDb()
  const configured = readTokens().length > 0
  let listError: string | null = null
  let accounts: TokenAccount[] = []
  if (configured) {
    const newest = db.select({ at: sql<string | null>`max(${repoSources.listedAt})` }).from(repoSources).get()?.at ?? null
    const stale = !newest || Date.now() - new Date(`${newest.replace(' ', 'T')}Z`).getTime() > LIST_TTL_MS
    if (opts.refresh || stale) {
      const res = await refreshRepoList()
      accounts = res.accounts
      listError = res.error
    }
    else {
      accounts = await tokenAccounts()
      const bad = accounts.filter(a => a.error)
      if (bad.length) listError = bad.map(a => `Token ${a.index + 1}: ${a.error}`).join(' ')
    }
  }
  const personal = personalLogins(accounts)
  const rows = db.select().from(repoSources).all()
  const byOwner = new Map<string, RepoRow[]>()
  for (const r of rows) byOwner.set(r.owner, [...(byOwner.get(r.owner) ?? []), r])
  const groups: RepoOwnerGroup[] = [...byOwner.entries()].map(([owner, list]) => ({
    owner,
    personal: personal.has(owner.toLowerCase()),
    ownerType: list[0]?.ownerType ?? null,
    repos: list
      .sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? '') || a.name.localeCompare(b.name))
      .map(toRepoView),
  })).sort((a, b) => Number(b.personal) - Number(a.personal) || a.owner.localeCompare(b.owner, 'en', { sensitivity: 'base' }))

  const tokens: RepoTokenView[] = accounts.map((a) => {
    const counts = new Map<string, number>()
    for (const r of rows.filter(x => x.tokenIndex === a.index)) counts.set(r.owner, (counts.get(r.owner) ?? 0) + 1)
    return {
      position: a.index + 1,
      source: a.source,
      login: a.login,
      owners: [...counts.entries()].map(([owner, repos]) => ({ owner, repos })).sort((x, y) => y.repos - x.repos),
      error: a.error,
    }
  })
  const identities = currentIdentities(accounts)
  const lastIndex = db.select().from(pipelineRuns).where(and(eq(pipelineRuns.task, 'repos:index'), sql`${pipelineRuns.status} != 'skipped'`)).orderBy(desc(pipelineRuns.id)).limit(1).get()
  const indexedCommits = db.select({ n: sql<number>`count(*)` }).from(repoCommits).get()?.n ?? 0
  return {
    configured,
    tokens,
    groups,
    identities,
    unlistedEmails: identityCandidates(identities.emails),
    defaultIdentities: defaultIdentities(accounts),
    listedAt: db.select({ at: sql<string | null>`max(${repoSources.listedAt})` }).from(repoSources).get()?.at ?? null,
    indexedCommits,
    lastIndex: lastIndex ? { id: lastIndex.id, status: lastIndex.status, startedAt: lastIndex.startedAt, finishedAt: lastIndex.finishedAt } : null,
    listError,
  }
}
