import { inArray } from 'drizzle-orm'
import { repoSources } from '../../db/schema'
import { GithubApiError, githubGet, orgLogins, searchCommits, tokenAccounts, tokenAt, type GithubRepo, type SearchCommitItem, type TokenAccount } from './github'
import { setFindProgress } from './find-state'
import { currentIdentities, forgetRepoData, personalLogins, saveFind, storedFind, type StoredFind } from './settings'

// Find repos with my commits. GitHub commit search (GET /search/commits) lists every commit by
// his login (author:<login>) and by each listed email GitHub does not already link to that login
// (author-email:<email>), across every repo each read token can see. One query returns at most
// 1,000 results, so a query over 1,000 is split by author date until every range is under 1,000.
// The result is one count per repo, stored with the repo list (app_settings repo_commit_search).
// Search only covers each repo's default branch, so a count can be lower than what repos:index
// later finds on every branch.

const CAP = 1000
const PER_PAGE = 100
/** GitHub opened in 2008. No commit search result is older than that. */
const EARLIEST_MS = Date.UTC(2008, 0, 1)
/** A search that is still going after this stops and keeps what it found, with a note. */
const MAX_RUN_MS = 30 * 60_000

function sqlNow() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

function isoSecond(ms: number) {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`
}

class SearchRun {
  readonly startedAt = sqlNow()
  readonly started = Date.now()
  requests = 0
  /** repo full name -> distinct commit shas */
  readonly shas = new Map<string, Set<string>>()
  /**
   * repo full name -> the same commits keyed by author date and first message line, which a
   * copied or rebased project keeps even when its SHAs change.
   */
  readonly keys = new Map<string, Set<string>>()
  /** repo full name -> the first search item seen for it, and the token that found it */
  readonly repoInfo = new Map<string, { item: SearchCommitItem['repository']; tokenIndex: number }>()
  readonly notes: string[] = []
  readonly ssoIds = new Map<number, number>() // org id -> token index
  timedOut = false
  waitingSeconds: number | null = null

  constructor(private log: (m: string) => void) {}

  commitCount() {
    let n = 0
    for (const s of this.shas.values()) n += s.size
    return n
  }

  report() {
    setFindProgress({ startedAt: this.startedAt, requests: this.requests, commits: this.commitCount(), repos: this.shas.size, waitingSeconds: this.waitingSeconds })
  }

  add(items: SearchCommitItem[], tokenIndex: number) {
    for (const it of items) {
      const repo = it.repository?.full_name
      if (!repo || !it.sha) continue
      let set = this.shas.get(repo)
      if (!set) {
        set = new Set()
        this.shas.set(repo, set)
        this.keys.set(repo, new Set())
        this.repoInfo.set(repo, { item: it.repository, tokenIndex })
      }
      set.add(it.sha)
      this.keys.get(repo)!.add(commitKey(it))
    }
  }

  async page(token: string, tokenIndex: number, q: string, page: number, perPage = PER_PAGE) {
    if (Date.now() - this.started > MAX_RUN_MS) {
      this.timedOut = true
      throw new StopSearch()
    }
    let res = await searchCommits(token, q, page, {
      perPage,
      onWait: (s) => {
        this.waitingSeconds = s
        this.report()
        this.log(`search limit reached, waiting ${s}s`)
      },
    })
    this.requests++
    // GitHub's search can time out on its side and say so. One retry, then keep what came back.
    if (res.incomplete) {
      res = await searchCommits(token, q, page, { perPage })
      this.requests++
      if (res.incomplete) this.notes.push(`GitHub's search timed out on part of "${q}", so some counts may be low.`)
    }
    for (const id of res.ssoOrgIds) if (!this.ssoIds.has(id)) this.ssoIds.set(id, tokenIndex)
    this.waitingSeconds = null
    this.report()
    return res
  }

  /** Every commit `base` matches between from and to (ms, whole seconds), splitting while a range holds over 1,000. */
  async collect(token: string, tokenIndex: number, base: string, from: number, to: number): Promise<void> {
    const q = `${base} author-date:${isoSecond(from)}..${isoSecond(to)}`
    const first = await this.page(token, tokenIndex, q, 1)
    if (first.total > CAP && to - from >= 2000) {
      // Results come oldest first, so nothing in this range is older than the first one: start
      // the split there instead of at 2008, which saves requests on empty years.
      const earliest = Math.floor(Date.parse(first.items[0]?.commit?.author?.date ?? '') / 1000) * 1000
      if (Number.isFinite(earliest) && earliest > from && earliest < to) from = earliest
      const mid = from + Math.floor((to - from) / 2000) * 1000
      await this.collect(token, tokenIndex, base, from, mid)
      await this.collect(token, tokenIndex, base, mid + 1000, to)
      return
    }
    this.add(first.items, tokenIndex)
    const pages = Math.ceil(Math.min(first.total, CAP) / PER_PAGE)
    for (let p = 2; p <= pages; p++) this.add((await this.page(token, tokenIndex, q, p)).items, tokenIndex)
    if (first.total > CAP) this.notes.push(`Over 1,000 commits in one second for "${base}" at ${isoSecond(from)}; only 1,000 were counted.`)
  }
}

class StopSearch extends Error {}

/** Author date to the second plus the first message line: the same commit in a copy of a project. */
function commitKey(it: SearchCommitItem): string {
  const date = Date.parse(it.commit?.author?.date ?? '')
  const line = String(it.commit?.message ?? '').split('\n')[0]!.trim().toLowerCase()
  return Number.isFinite(date) && line ? `${Math.floor(date / 1000)}|${line}` : `sha:${it.sha}`
}

let inFlight: Promise<StoredFind> | null = null

/** True while a search runs in this process. */
export function findRunning(): boolean {
  return !!inFlight
}

/**
 * Search GitHub for every repo holding his commits and store the counts. A second call while one
 * runs waits for the same search. Throws when the search fails; the previous counts stay stored
 * with the error beside them.
 */
export function findMyRepos(log: (m: string) => void = () => {}, accounts?: TokenAccount[]): Promise<StoredFind> {
  inFlight ??= runFind(log, accounts).finally(() => {
    inFlight = null
    setFindProgress(null)
  })
  return inFlight
}

async function runFind(log: (m: string) => void, given?: TokenAccount[]): Promise<StoredFind> {
  const run = new SearchRun(log)
  run.report()
  try {
    const accounts = given ?? await tokenAccounts()
    const usable = accounts.filter(a => !a.error && a.login)
    if (!usable.length) throw new Error(accounts.length ? 'No read token was accepted by GitHub, so nothing could be searched.' : 'No GitHub read token is set, so nothing could be searched.')
    const ids = currentIdentities(accounts)
    if (!ids.logins.length && !ids.emails.length) throw new Error('No author emails or logins are set in Settings, so no commit counts as yours yet.')
    const until = Date.now() + 24 * 60 * 60_000
    const now = Math.floor(until / 1000) * 1000

    for (const acct of usable) {
      const token = tokenAt(acct.index)
      if (!token) continue
      try {
        for (const login of ids.logins) {
          log(`token ${acct.index + 1}: commits by ${login}`)
          try {
            await run.collect(token, acct.index, `author:${login}`, EARLIEST_MS, now)
          }
          catch (e) {
            // 422: GitHub does not know this login, or cannot search it.
            if (e instanceof GithubApiError && e.status === 422) run.notes.push(`GitHub could not search commits by ${login}. Check the login in Settings.`)
            else throw e
          }
        }
        // An email GitHub links to one of his logins is already covered by that login's search.
        // Searching it again would only repeat the same commits, at 30 requests a minute.
        for (const email of ids.emails) {
          const base = `author-email:${email}`
          let first
          try {
            first = await run.page(token, acct.index, base, 1)
          }
          catch (e) {
            if (e instanceof GithubApiError && e.status === 422) {
              run.notes.push(`GitHub could not search commits by ${email}.`)
              continue
            }
            throw e
          }
          if (!first.total) continue
          if (first.total <= PER_PAGE) {
            run.add(first.items, acct.index)
            continue
          }
          let covered = false
          for (const login of ids.logins) {
            const both = await run.page(token, acct.index, `${base} author:${login}`, 1, 1).catch(() => null)
            if (both && both.total >= first.total) {
              covered = true
              break
            }
          }
          if (covered) {
            log(`token ${acct.index + 1}: ${email} is linked to your login, already counted`)
            continue
          }
          log(`token ${acct.index + 1}: commits by ${email}`)
          await run.collect(token, acct.index, base, EARLIEST_MS, now)
        }
      }
      catch (e) {
        if (!(e instanceof StopSearch)) throw e
        break
      }
    }
    if (run.timedOut) run.notes.push('The search stopped after 30 minutes, so these counts are partial. The next daily run searches again.')

    const { byRepo, dropped, details } = await creditCommits(run, accounts)
    if (dropped) run.notes.push(`Left out ${dropped} ${dropped === 1 ? 'repo' : 'repos'} of other people that only hold copies of commits counted in another repo (a copied project, for example).`)
    const ssoOrgs: string[] = []
    for (const [id, tokenIndex] of run.ssoIds) {
      const token = tokenAt(tokenIndex)
      if (token) ssoOrgs.push(...await orgLogins(token, [id]))
    }
    syncSearchOnlyRepos(run, accounts, byRepo, details)
    const distinct = new Set<string>()
    for (const name of Object.keys(byRepo)) for (const key of run.keys.get(name) ?? []) distinct.add(key)

    const result: StoredFind = {
      startedAt: run.startedAt,
      at: sqlNow(),
      seconds: Math.round((Date.now() - run.started) / 1000),
      requests: run.requests,
      commits: distinct.size,
      byRepo,
      notes: [...new Set(run.notes)],
      ssoOrgs: [...new Set(ssoOrgs)],
      error: null,
      errorAt: null,
    }
    saveFind(result)
    const owners = new Set(Object.keys(byRepo).map(r => r.split('/')[0]!.toLowerCase())).size
    log(`found ${result.commits} commits in ${Object.keys(byRepo).length} repos across ${owners} owners, ${result.requests} requests, ${result.seconds}s`)
    return result
  }
  catch (e: any) {
    const message = String(e?.message ?? e).slice(0, 400)
    const prev = storedFind()
    saveFind({
      ...(prev ?? { startedAt: run.startedAt, at: '', seconds: 0, requests: 0, commits: 0, byRepo: {}, notes: [], ssoOrgs: [] }),
      error: message,
      errorAt: sqlNow(),
    })
    throw e
  }
}

type RepoDetail = Partial<GithubRepo> & { stargazers_count?: number }

/**
 * One count per repo. A repo a token lists (his own, his organizations') counts every commit of
 * his it holds. A repo no token lists (someone else's public repo) counts only commits that no
 * listed repo holds, and a commit several of those hold counts once, for the most-starred one:
 * a project copied a hundred times (with his two commits in its history) is one repo, not a
 * hundred. Repos left with nothing are dropped.
 */
async function creditCommits(run: SearchRun, accounts: TokenAccount[]) {
  const listed = new Set(accounts.flatMap(a => a.repos.map(r => r.full_name)))
  // Commits are matched by author date and first message line, not SHA: a copy that was rebased
  // or squashed onto new history keeps those two and changes every SHA.
  const holders = new Map<string, string[]>()
  for (const [repo, keys] of run.keys) for (const key of keys) holders.set(key, [...(holders.get(key) ?? []), repo])

  const others = [...run.shas.keys()].filter(n => !listed.has(n))
  const details = new Map<string, RepoDetail>()
  // Stars and size (for the 500 MB rule) come from GET /repos, eight at a time.
  for (let i = 0; i < others.length; i += 8) {
    await Promise.all(others.slice(i, i + 8).map(async (name) => {
      const token = tokenAt(run.repoInfo.get(name)?.tokenIndex)
      if (!token) return
      try {
        details.set(name, await githubGet<RepoDetail>(token, `/repos/${name}`))
      }
      catch {}
    }))
  }
  const stars = (n: string) => Number(details.get(n)?.stargazers_count) || 0

  const byRepo: Record<string, number> = {}
  let dropped = 0
  for (const [repo, shas] of run.shas) {
    if (listed.has(repo)) {
      byRepo[repo] = shas.size
      continue
    }
    let n = 0
    for (const key of run.keys.get(repo) ?? []) {
      const h = holders.get(key) ?? [repo]
      if (h.some(x => listed.has(x))) continue
      const best = [...h].sort((a, b) => stars(b) - stars(a) || a.localeCompare(b))[0]
      if (best === repo) n++
    }
    if (n) byRepo[repo] = n
    else dropped++
  }
  const sorted = Object.fromEntries(Object.entries(byRepo).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
  return { byRepo: sorted, dropped, details }
}

/**
 * A repo the search found that no token lists (a public repo he contributed to) joins the repo
 * list, so it can be switched on, with its size from GET /repos so the 500 MB rule still applies.
 * One that an earlier search added and this one no longer counts leaves the list.
 */
function syncSearchOnlyRepos(run: SearchRun, accounts: TokenAccount[], byRepo: Record<string, number>, details: Map<string, RepoDetail>) {
  const db = useDb()
  const listed = new Set(accounts.flatMap(a => a.repos.map(r => r.full_name)))
  const known = new Set(db.select({ n: repoSources.fullName }).from(repoSources).all().map(r => r.n))
  const personal = personalLogins(accounts)
  const at = sqlNow()
  for (const fullName of Object.keys(byRepo)) {
    if (listed.has(fullName) || known.has(fullName)) continue
    const info = run.repoInfo.get(fullName)
    if (!info) continue
    const { item, tokenIndex } = info
    const full = details.get(fullName) ?? {}
    const owner = full.owner?.login ?? item.owner.login
    db.insert(repoSources).values({
      fullName,
      owner,
      name: full.name ?? item.name,
      ownerType: full.owner?.type ?? item.owner.type ?? null,
      isPrivate: !!(full.private ?? item.private),
      isFork: !!(full.fork ?? item.fork),
      archived: !!full.archived,
      sizeKb: full.size != null ? Number(full.size) || 0 : null,
      defaultBranch: full.default_branch || null,
      htmlUrl: full.html_url || item.html_url || null,
      pushedAt: full.pushed_at || null,
      tokenIndex,
      included: personal.has(owner.toLowerCase()) && !(full.fork ?? item.fork),
      listedAt: at,
      updatedAt: at,
    }).onConflictDoNothing().run()
  }
  // Only when every token answered and the search ran to the end: a token that failed to list, or
  // a search cut short, must not lose repos here.
  if (accounts.some(a => a.error) || run.timedOut) return
  const stale = db.select({ n: repoSources.fullName }).from(repoSources).all().map(r => r.n).filter(n => !listed.has(n) && !(byRepo[n]! > 0))
  for (const n of stale) forgetRepoData(n)
  for (let i = 0; i < stale.length; i += 400) db.delete(repoSources).where(inArray(repoSources.fullName, stale.slice(i, i + 400))).run()
}
