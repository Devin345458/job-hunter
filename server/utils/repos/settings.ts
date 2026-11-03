import { and, desc, eq, inArray, like, lt, or, sql } from 'drizzle-orm'
import { appSettings, pipelineRuns, repoCommits, repoFacts, repoSources, repoSuggestions } from '../../db/schema'
import type { RepoFindView, RepoIdentities, RepoOwnerGroup, RepoSettingsView, RepoTokenView, RepoView } from '#shared/types/repos'
import { loadKnowledge, profileValue } from '../knowledge'
import { isSsoSkip, tokenAccounts, readTokens, type TokenAccount } from './github'
import { removeRepoCache } from './git'
import { findProgress } from './find-state'

// Settings > GitHub evidence: which repos the read tokens can see, which ones Devin switched on,
// and which commit authors count as him. Repos owned by his own login are on by default, except
// forks, which hold mostly other people's commits. Every organization's or other person's repo is
// off until he turns it on.

// ── This app's own repo ──
// job-hunter names every skill as data (prompts, examples, skill lists), so its commits and files
// match every search. It is never switched on, never indexed, and never searched.

export const APP_REPO = 'Devin345458/job-hunter'
export const APP_REPO_NOTE = 'This app\'s own repo names every skill as data, so it never counts as evidence.'

export function isAppRepo(fullName: string | null | undefined): boolean {
  return String(fullName ?? '').toLowerCase() === APP_REPO.toLowerCase()
}

/** Switches this app's repo off and forgets anything indexed from it (a copy that had it on). */
export function excludeAppRepo() {
  const db = useDb()
  const row = db.select().from(repoSources).where(sql`lower(${repoSources.fullName}) = ${APP_REPO.toLowerCase()}`).get()
  if (!row) return
  const indexed = db.select({ id: repoCommits.id }).from(repoCommits).where(eq(repoCommits.repo, row.fullName)).limit(1).get()
  if (!row.included && !row.indexedAt && !indexed) return
  db.update(repoSources).set({ included: false, updatedAt: nowSqlText() }).where(eq(repoSources.fullName, row.fullName)).run()
  forgetRepoData(row.fullName)
}

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

type CandidatesByRepo = Record<string, Record<string, number>>

function storedCandidates(): CandidatesByRepo {
  const row = useDb().select().from(appSettings).where(eq(appSettings.key, CANDIDATES_KEY)).get()
  try {
    const parsed = row ? JSON.parse(row.valueJson) : null
    // Stored per repo since indexing went to 30 repos a run. The older shape was per email.
    if (parsed?.byRepo && typeof parsed.byRepo === 'object') return parsed.byRepo as CandidatesByRepo
    const out: CandidatesByRepo = {}
    for (const [email, v] of Object.entries((parsed ?? {}) as Record<string, { commits?: number; repos?: string[] }>)) {
      for (const repo of v?.repos ?? []) (out[repo] ??= {})[email] = Math.max(1, Math.round((v.commits ?? 1) / Math.max(1, v.repos!.length)))
    }
    return out
  }
  catch {
    return {}
  }
}

/**
 * Emails on commits whose author name is one of his logins, that GitHub links to no account, and
 * that he has not listed, per repo. Each index run replaces the entries of the repos it indexed and
 * keeps the rest, since one run covers at most 30 repos. Settings offers each email to add.
 */
export function saveIdentityCandidates(indexed: Record<string, Record<string, number>>) {
  const byRepo = { ...storedCandidates(), ...indexed }
  for (const [repo, emails] of Object.entries(byRepo)) if (!Object.keys(emails).length) delete byRepo[repo]
  const valueJson = JSON.stringify({ byRepo })
  useDb().insert(appSettings).values({ key: CANDIDATES_KEY, valueJson, updatedAt: nowSqlText() })
    .onConflictDoUpdate({ target: appSettings.key, set: { valueJson, updatedAt: nowSqlText() } }).run()
}

export function identityCandidates(listed: string[], includedNames?: Set<string>): Array<{ email: string; commits: number; repos: string[] }> {
  const have = new Set(listed.map(e => e.toLowerCase()))
  const byEmail = new Map<string, { commits: number; repos: string[] }>()
  for (const [repo, emails] of Object.entries(storedCandidates())) {
    if (includedNames && !includedNames.has(repo)) continue
    for (const [email, n] of Object.entries(emails)) {
      if (have.has(email.toLowerCase())) continue
      const c = byEmail.get(email) ?? { commits: 0, repos: [] }
      c.commits += n
      c.repos.push(repo)
      byEmail.set(email, c)
    }
  }
  return [...byEmail.entries()].map(([email, v]) => ({ email, ...v })).sort((a, b) => b.commits - a.commits)
}

// ── Find repos with my commits (stored result) ──

const FIND_KEY = 'repo_commit_search'
/** repos:index runs the commit search again when the stored one is older than this. */
export const FIND_TTL_MS = 24 * 60 * 60_000

/** The last commit search: every repo holding his commits, with a count each. */
export interface StoredFind {
  startedAt: string
  /** When it finished. */
  at: string
  seconds: number
  requests: number
  /** Distinct commits found, across every repo. */
  commits: number
  byRepo: Record<string, number>
  /** Plain notes: a range GitHub could not split, a login GitHub does not know, a time cap. */
  notes: string[]
  /** Organizations whose results GitHub left out for SSO. */
  ssoOrgs: string[]
  /** The last attempt's error, when it failed. The counts above are then the previous good search. */
  error: string | null
  errorAt: string | null
}

export function storedFind(): StoredFind | null {
  const row = useDb().select().from(appSettings).where(eq(appSettings.key, FIND_KEY)).get()
  if (!row) return null
  try {
    return JSON.parse(row.valueJson) as StoredFind
  }
  catch {
    return null
  }
}

export function saveFind(find: StoredFind) {
  const valueJson = JSON.stringify(find)
  useDb().insert(appSettings).values({ key: FIND_KEY, valueJson, updatedAt: nowSqlText() })
    .onConflictDoUpdate({ target: appSettings.key, set: { valueJson, updatedAt: nowSqlText() } }).run()
}

/** True when no search ran, or the last one (or the last failed attempt) is over a day old. */
export function findIsStale(): boolean {
  const f = storedFind()
  const times = [f?.at, f?.errorAt].filter((t): t is string => !!t).map(t => new Date(`${t.replace(' ', 'T')}Z`).getTime()).filter(Number.isFinite)
  return !times.length || Date.now() - Math.max(...times) > FIND_TTL_MS
}

// ── Repo list ──

/**
 * Re-list every repo the tokens can see and store it. A repo seen for the first time gets its
 * default switch: on for Devin's own repos, off for his forks and for everyone else's. Repos no token lists anymore
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
      }
      // updatedAt is left alone on a re-list: repos:index orders its queue by the last index or
      // attempt, which updatedAt records.
      db.insert(repoSources).values({ fullName: r.full_name, ...values, included: personal.has(r.owner.login.toLowerCase()) && !r.fork && !isAppRepo(r.full_name), updatedAt: at })
        .onConflictDoUpdate({ target: repoSources.fullName, set: values }).run()
    }
  }
  excludeAppRepo()
  // Only forget repos when every token answered. A failed token must not wipe its repos. Repos the
  // commit search found (a public repo he contributed to that /user/repos does not list) stay.
  if (!failed.length) {
    const found = storedFind()?.byRepo ?? {}
    const gone = db.select().from(repoSources).where(or(lt(repoSources.listedAt, at), sql`${repoSources.listedAt} is null`)).all()
      .filter(g => !(found[g.fullName]! > 0))
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
  if (included && isAppRepo(fullName)) throw createError({ statusCode: 400, statusMessage: APP_REPO_NOTE })
  db.update(repoSources).set({ included, updatedAt: nowSqlText() }).where(eq(repoSources.fullName, fullName)).run()
  if (!included) forgetRepoData(fullName)
  return db.select().from(repoSources).where(eq(repoSources.fullName, fullName)).get()!
}

/**
 * Switch many repos at once.
 * on: the repos holding his commits (by the last commit search) that are off, never forks. With an
 * owner, only that owner's. Repos without his commits stay off.
 * off: every repo of one owner that is on, forgetting what was indexed from each.
 */
export function setReposIncludedBulk(opts: { owner?: string | null; included: boolean }): { changed: number; owners: number } {
  const db = useDb()
  const owner = opts.owner?.trim() || null
  if (!opts.included && !owner) throw createError({ statusCode: 400, statusMessage: 'Turning repos off in bulk needs an owner' })
  const rows = owner
    ? db.select().from(repoSources).where(eq(repoSources.owner, owner)).all()
    : db.select().from(repoSources).all()
  if (owner && !rows.length) throw createError({ statusCode: 404, statusMessage: 'No repos from that owner are in the list. Refresh the list and try again.' })
  let targets: RepoRow[]
  if (opts.included) {
    const found = storedFind()?.byRepo
    if (!found) throw createError({ statusCode: 409, statusMessage: 'Find the repos with your commits first.' })
    targets = rows.filter(r => !r.included && !r.isFork && !isAppRepo(r.fullName) && (found[r.fullName] ?? 0) > 0)
  }
  else {
    targets = rows.filter(r => r.included)
  }
  const names = targets.map(r => r.fullName)
  const at = nowSqlText()
  db.transaction((tx) => {
    for (let i = 0; i < names.length; i += 400) {
      tx.update(repoSources).set({ included: opts.included, updatedAt: at }).where(inArray(repoSources.fullName, names.slice(i, i + 400))).run()
    }
  })
  if (!opts.included) for (const name of names) forgetRepoData(name)
  return { changed: names.length, owners: new Set(targets.map(r => r.owner)).size }
}

export function includedRepos(): RepoRow[] {
  return useDb().select().from(repoSources).where(eq(repoSources.included, true)).all().filter(r => !isAppRepo(r.fullName))
}

function toRepoView(r: RepoRow, found: Record<string, number> | null): RepoView {
  return {
    yourCommits: found ? (found[r.fullName] ?? 0) : null,
    fullName: r.fullName,
    name: r.name,
    isPrivate: r.isPrivate,
    isFork: r.isFork,
    archived: r.archived,
    sizeMb: r.sizeKb != null ? Math.round((r.sizeKb / 1024) * 10) / 10 : null,
    included: !!r.included && !isAppRepo(r.fullName),
    note: isAppRepo(r.fullName) ? APP_REPO_NOTE : null,
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
  // A copy that had this app's own repo on (before it was excluded) loses it on the next visit.
  excludeAppRepo()
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
  const find = storedFind()
  const found = find?.at ? find.byRepo : null
  const hasCommits = (r: RepoRow) => !!found && (found[r.fullName] ?? 0) > 0
  const byOwner = new Map<string, RepoRow[]>()
  for (const r of rows) byOwner.set(r.owner, [...(byOwner.get(r.owner) ?? []), r])
  const groups: RepoOwnerGroup[] = [...byOwner.entries()].map(([owner, list]) => ({
    owner,
    personal: personal.has(owner.toLowerCase()),
    ownerType: list[0]?.ownerType ?? null,
    withCommits: found ? list.filter(r => hasCommits(r) && !r.isFork).length : null,
    withCommitsOff: found ? list.filter(r => hasCommits(r) && !r.isFork && !r.included && !isAppRepo(r.fullName)).length : null,
    sso: list.some(r => r.included && isSsoSkip(r.skipReason)) || accounts.some(a => a.ssoOrgs.some(o => o.toLowerCase() === owner.toLowerCase())),
    // Repos with his commits first (most first), then the most recently pushed.
    repos: list
      .sort((a, b) => (found?.[b.fullName] ?? 0) - (found?.[a.fullName] ?? 0) || (b.pushedAt ?? '').localeCompare(a.pushedAt ?? '') || a.name.localeCompare(b.name))
      .map(r => toRepoView(r, found)),
  })).sort((a, b) => Number(b.personal) - Number(a.personal)
    || (b.withCommits ?? 0) - (a.withCommits ?? 0)
    || a.owner.localeCompare(b.owner, 'en', { sensitivity: 'base' }))

  const tokens: RepoTokenView[] = accounts.map((a) => {
    const counts = new Map<string, number>()
    for (const r of rows.filter(x => x.tokenIndex === a.index)) counts.set(r.owner, (counts.get(r.owner) ?? 0) + 1)
    return {
      position: a.index + 1,
      source: a.source,
      login: a.login,
      owners: [...counts.entries()].map(([owner, repos]) => ({ owner, repos })).sort((x, y) => y.repos - x.repos),
      ssoOrgs: a.ssoOrgs,
      error: a.error,
    }
  })

  // SSO: organizations a token listing or the commit search left out, plus owners whose repos the
  // indexer could not read for SSO.
  const ssoOrgs = new Map<string, string>()
  for (const o of [...accounts.flatMap(a => a.ssoOrgs), ...(find?.ssoOrgs ?? [])]) ssoOrgs.set(o.toLowerCase(), o)
  for (const r of rows) if (r.included && isSsoSkip(r.skipReason)) ssoOrgs.set(r.owner.toLowerCase(), r.owner)

  const on = rows.filter(r => r.included)
  const eligible = found ? rows.filter(r => hasCommits(r) && !r.isFork && !r.included && !isAppRepo(r.fullName)) : []
  const progress = findProgress()
  const findView: RepoFindView = {
    // Waiting in the job queue counts as running: the search is on its way.
    running: !!progress || !!activeItem(FIND_TASK),
    progress,
    at: find?.at || null,
    seconds: find?.at ? find.seconds : null,
    commits: find?.at ? find.commits : 0,
    repos: found ? Object.keys(found).length : 0,
    owners: found ? new Set(Object.keys(found).map(n => n.split('/')[0]!.toLowerCase())).size : 0,
    notes: find?.notes ?? [],
    error: find?.error ?? null,
    errorAt: find?.errorAt ?? null,
    turnOn: { repos: eligible.length, owners: new Set(eligible.map(r => r.owner)).size, otherOwners: [...new Set(eligible.filter(r => !personal.has(r.owner.toLowerCase())).map(r => r.owner))] },
  }

  const identities = currentIdentities(accounts)
  const lastIndex = db.select().from(pipelineRuns).where(and(eq(pipelineRuns.task, 'repos:index'), sql`${pipelineRuns.status} != 'skipped'`)).orderBy(desc(pipelineRuns.id)).limit(1).get()
  const indexedCommits = db.select({ n: sql<number>`count(*)` }).from(repoCommits).get()?.n ?? 0
  return {
    configured,
    tokens,
    groups,
    identities,
    unlistedEmails: identityCandidates(identities.emails, new Set(on.map(r => r.fullName))),
    defaultIdentities: defaultIdentities(accounts),
    listedAt: db.select({ at: sql<string | null>`max(${repoSources.listedAt})` }).from(repoSources).get()?.at ?? null,
    indexedCommits,
    index: {
      included: on.length,
      indexed: on.filter(r => !!r.indexedAt).length,
      oversized: on.filter(r => (r.sizeKb ?? 0) > MAX_REPO_KB).length,
      sso: on.filter(r => !r.indexedAt && isSsoSkip(r.skipReason)).length,
      failed: on.filter(r => !!r.indexError).length,
    },
    find: findView,
    ssoOrgs: [...ssoOrgs.values()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
    lastIndex: lastIndex ? { id: lastIndex.id, status: lastIndex.status, startedAt: lastIndex.startedAt, finishedAt: lastIndex.finishedAt } : null,
    listError,
  }
}
