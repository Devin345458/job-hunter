import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { repoCommits, repoFacts, repoSources } from '../../db/schema'
import { commitLogins, repoLanguages, tokenAccounts, tokenAt } from './github'
import { gitOk, prepareRepoCache, remoteUrl, repoCacheDir, repoCacheRoot, runGit } from './git'
import { MAX_REPO_KB, currentIdentities, forgetRepoData, includedRepos, refreshRepoList, saveIdentityCandidates, type RepoRow } from './settings'

// repos:index. For each repo switched on in Settings: a partial clone (commits and trees only)
// into <dataDir>/repo-cache, updated with fetch on later runs; Devin's own commits (author email
// or login he listed), with message, date, changed paths, and GitHub URL; the blobs those commits
// changed, so the suggester can search his diffs offline; the repo's languages; and dependency
// names from manifests at the default branch. Code by anyone else is never indexed.

export const MAX_COMMITS_PER_REPO = 5000
/** A commit touching this many files (a vendored import, a mass rename) is listed but its diff is not searched. */
export const LARGE_COMMIT_FILES = 300
const MAX_BLOBS_PER_REPO = 40_000
const MAX_MANIFESTS = 40

const EXCLUDED_DIRS = ['node_modules', 'vendor', 'bower_components', 'dist', 'build', '.output', '.nuxt', '.next', 'coverage', 'Pods', '.yarn']
const EXCLUDED_FILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock', 'gemfile.lock', 'cargo.lock', 'go.sum', 'poetry.lock', 'pipfile.lock', 'npm-shrinkwrap.json']
const EXCLUDED_EXT = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tif', 'tiff', 'svg', 'psd', 'ai', 'sketch', 'fig', 'heic',
  'pdf', 'zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'jar', 'war', 'apk', 'ipa', 'aab', 'dmg', 'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'wasm',
  'woff', 'woff2', 'ttf', 'eot', 'otf', 'mp3', 'mp4', 'mov', 'webm', 'wav', 'ogg', 'm4a', 'avi',
  'db', 'sqlite', 'sqlite3', 'map', 'csv', 'tsv', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'parquet', 'pkl', 'h5', 'onnx', 'npy', 'snap', 'lock',
]

/** True when a changed path is worth searching: source, config, and docs, not binaries, lockfiles, or vendored code. */
export function isSearchablePath(path: string): boolean {
  const lower = path.toLowerCase()
  const parts = lower.split('/')
  const file = parts[parts.length - 1] ?? ''
  if (parts.slice(0, -1).some(p => EXCLUDED_DIRS.some(d => d.toLowerCase() === p))) return false
  if (EXCLUDED_FILES.includes(file)) return false
  if (file.endsWith('.min.js') || file.endsWith('.min.css')) return false
  const dot = file.lastIndexOf('.')
  if (dot > 0 && EXCLUDED_EXT.includes(file.slice(dot + 1))) return false
  return true
}

/** The same exclusions as git pathspecs, so a diff search never asks for a blob the indexer skipped. */
export function excludedPathspecs(): string[] {
  return [
    ...EXCLUDED_DIRS.map(d => `:(exclude,glob,icase)**/${d}/**`),
    ...EXCLUDED_FILES.map(f => `:(exclude,glob,icase)**/${f}`),
    ':(exclude,glob,icase)**/*.min.js',
    ':(exclude,glob,icase)**/*.min.css',
    ...EXCLUDED_EXT.map(e => `:(exclude,glob,icase)**/*.${e}`),
  ]
}

// ── Who counts as Devin ──

export interface Identities {
  emails: string[]
  logins: string[]
}

/**
 * Exact author check, after git's substring filter.
 * his: a listed email, or that login's GitHub noreply address.
 * name_only: the author name is one of his logins but the email is not listed. Author names are
 * self-declared, so these count only when GitHub attributes the commit to his account.
 */
export function authorshipOf(name: string, email: string, ids: Identities): 'his' | 'name_only' | 'no' {
  const e = email.trim().toLowerCase()
  if (ids.emails.some(x => x.toLowerCase() === e)) return 'his'
  const logins = ids.logins.map(l => l.toLowerCase())
  const noreply = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/.exec(e)
  if (noreply && logins.includes(noreply[1]!)) return 'his'
  return logins.includes(name.trim().toLowerCase()) ? 'name_only' : 'no'
}

export function authorArgs(ids: Identities): string[] {
  return [...ids.emails, ...ids.logins].map(a => `--author=${a}`)
}

// ── Parsing ──

interface ChangedFile {
  path: string
  oldOid: string | null
  newOid: string | null
}

export interface ParsedCommit {
  sha: string
  authoredAt: string
  authorName: string
  authorEmail: string
  message: string
  files: ChangedFile[]
}

const ZERO = /^0+$/

/** Parses `git log --format=%x1e%H%x1f%aI%x1f%an%x1f%ae%x1f%B%x1f --raw --no-abbrev`. */
export function parseRawLog(out: string): ParsedCommit[] {
  const commits: ParsedCommit[] = []
  for (const rec of out.split('\x1e')) {
    if (!rec.trim()) continue
    const parts = rec.split('\x1f')
    if (parts.length < 6) continue
    const [sha, authoredAt, authorName, authorEmail, body, rest] = parts as [string, string, string, string, string, string]
    const files: ChangedFile[] = []
    for (const line of rest.split('\n')) {
      // :100644 100644 <old> <new> M\tpath
      const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [A-Z]\d*\t(.+)$/.exec(line)
      if (!m) continue
      const [, oldMode, newMode, oldOid, newOid, path] = m as unknown as [string, string, string, string, string, string]
      files.push({
        path,
        oldOid: oldMode === '160000' || ZERO.test(oldOid) ? null : oldOid,
        newOid: newMode === '160000' || ZERO.test(newOid) ? null : newOid,
      })
    }
    commits.push({ sha: sha.trim(), authoredAt: authoredAt.trim(), authorName: authorName.trim(), authorEmail: authorEmail.trim(), message: body.trim().slice(0, 2000), files })
  }
  return commits
}

const MANIFEST_NAME = /^(package\.json|composer\.json|go\.mod|gemfile|cargo\.toml|pyproject\.toml|requirements[\w.-]*\.txt|[^/]+\.csproj)$/i

export function isManifest(path: string): boolean {
  const parts = path.split('/')
  if (parts.slice(0, -1).some(p => EXCLUDED_DIRS.some(d => d.toLowerCase() === p.toLowerCase()))) return false
  return MANIFEST_NAME.test(parts[parts.length - 1] ?? '')
}

/** Dependency names a manifest declares. Never throws: a manifest that does not parse declares nothing. */
export function parseManifest(path: string, text: string): string[] {
  const file = (path.split('/').pop() ?? '').toLowerCase()
  const out = new Set<string>()
  try {
    if (file === 'package.json') {
      const j = JSON.parse(text)
      for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const name of Object.keys(j?.[k] ?? {})) out.add(name)
      }
    }
    else if (file === 'composer.json') {
      const j = JSON.parse(text)
      for (const k of ['require', 'require-dev']) {
        for (const name of Object.keys(j?.[k] ?? {})) if (name !== 'php' && !/^(ext|lib)-/.test(name)) out.add(name)
      }
    }
    else if (file === 'go.mod') {
      let block = false
      for (const raw of text.split('\n')) {
        const line = raw.replace(/\/\/.*$/, '').trim()
        if (/^require\s*\($/.test(line)) block = true
        else if (block && line === ')') block = false
        else if (block && line) out.add(line.split(/\s+/)[0]!)
        else if (/^require\s+\S+/.test(line)) out.add(line.split(/\s+/)[1]!)
      }
    }
    else if (/^requirements[\w.-]*\.txt$/.test(file)) {
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#') || line.startsWith('-')) continue
        const name = line.split(/[<>=!~;\[\s@]/)[0]
        if (name) out.add(name)
      }
    }
    else if (file === 'pyproject.toml' || file === 'cargo.toml') {
      let section = ''
      let inArray = false
      for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*$/, '').trim()
        const sec = /^\[([^\]]+)\]$/.exec(line)
        if (sec) {
          section = sec[1]!.trim()
          inArray = false
          continue
        }
        if (file === 'pyproject.toml') {
          const arrayStart = section === 'project' && /^dependencies\s*=\s*\[/.test(line)
          const optional = section === 'project.optional-dependencies' && /^[\w-]+\s*=\s*\[/.test(line)
          if (arrayStart || optional) inArray = true
          if (inArray) {
            for (const m of line.matchAll(/["']([^"']+)["']/g)) {
              const name = m[1]!.split(/[<>=!~;\[\s@]/)[0]
              if (name) out.add(name)
            }
            if (line.includes(']')) inArray = false
            continue
          }
          if (/^tool\.poetry(\.group\.[^.]+)?\.(dev-)?dependencies$/.test(section)) {
            const key = /^([A-Za-z0-9_.-]+)\s*=/.exec(line)?.[1]
            if (key && key.toLowerCase() !== 'python') out.add(key)
          }
        }
        else if (/(^|\.)(dev-|build-)?dependencies$/.test(section)) {
          const key = /^([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1]
          if (key) out.add(key)
        }
      }
    }
    else if (file === 'gemfile') {
      for (const m of text.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)) out.add(m[1]!)
    }
    else if (file.endsWith('.csproj')) {
      for (const m of text.matchAll(/<PackageReference\s+Include="([^"]+)"/gi)) out.add(m[1]!)
    }
  }
  catch {}
  return [...out].filter(n => n.length <= 120).slice(0, 400)
}

// ── One repo ──

export interface RepoIndexResult {
  repo: string
  status: 'indexed' | 'skipped' | 'failed'
  /** His commits in the index after this run. */
  his: number
  /** Every non-merge commit the clone holds, by anyone, for comparison. */
  all: number | null
  newCommits: number
  blobsFetched: number
  dependencies: number
  /** Unlisted emails on name-only commits GitHub links to no account, with commit counts. */
  candidates?: Record<string, number>
  note?: string
}

async function defaultRef(dir: string, row: RepoRow): Promise<string | null> {
  for (const ref of ['refs/remotes/origin/HEAD', row.defaultBranch ? `refs/remotes/origin/${row.defaultBranch}` : null]) {
    if (!ref) continue
    const r = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: dir })
    if (r.code === 0 && r.stdout.trim()) return ref
  }
  return null
}

export async function indexRepo(row: RepoRow, ids: Identities, log: (m: string) => void): Promise<RepoIndexResult> {
  const db = useDb()
  const base: RepoIndexResult = { repo: row.fullName, status: 'indexed', his: 0, all: null, newCommits: 0, blobsFetched: 0, dependencies: 0 }
  const setRow = (v: Partial<typeof repoSources.$inferInsert>) => db.update(repoSources).set({ ...v, updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) }).where(eq(repoSources.fullName, row.fullName)).run()

  if ((row.sizeKb ?? 0) > MAX_REPO_KB) {
    forgetRepoData(row.fullName)
    setRow({ skipReason: `Over 500 MB on GitHub (${Math.round((row.sizeKb ?? 0) / 1024)} MB), so it is not cloned`, indexError: null })
    return { ...base, status: 'skipped', note: 'over 500 MB' }
  }
  const token = tokenAt(row.tokenIndex)
  if (!token) {
    setRow({ indexError: 'No configured token can read this repo now' })
    return { ...base, status: 'failed', note: 'no token' }
  }

  const dir = repoCacheDir(row.fullName)
  try {
    if (!existsSync(join(dir, '.git'))) {
      log(`${row.fullName}: cloning (commits and trees only)`)
      await gitOk(['clone', '--filter=blob:none', '--no-checkout', '--quiet', remoteUrl(row.fullName), dir], { cwd: repoCacheRoot(), token, timeoutMs: 15 * 60_000 })
    }
    else {
      await gitOk(['fetch', '--prune', '--quiet', 'origin'], { cwd: dir, token, timeoutMs: 10 * 60_000 })
    }
    const ref = await defaultRef(dir, row)
    if (!ref) {
      setRow({ skipReason: 'Empty repo, nothing to index', indexError: null, indexedAt: nowText(), commitCount: 0, headSha: null })
      db.delete(repoCommits).where(eq(repoCommits.repo, row.fullName)).run()
      return { ...base, status: 'skipped', note: 'empty' }
    }
    const headSha = (await gitOk(['rev-parse', ref], { cwd: dir })).trim()

    // His commits only: git narrows by substring, then every commit is checked exactly.
    const raw = await gitOk([
      '-c', 'core.quotePath=false', 'log', '--all', '--no-merges', '--no-renames', `-n${MAX_COMMITS_PER_REPO}`,
      '--fixed-strings', '--regexp-ignore-case', ...authorArgs(ids),
      '--format=%x1e%H%x1f%aI%x1f%an%x1f%ae%x1f%B%x1f', '--raw', '--no-abbrev',
    ], { cwd: dir, timeoutMs: 5 * 60_000 })
    const parsed = parseRawLog(raw)
    const nameOnly = parsed.filter(c => authorshipOf(c.authorName, c.authorEmail, ids) === 'name_only')
    let attributed = new Map<string, string | null>()
    if (nameOnly.length) {
      try {
        attributed = await commitLogins(token, row.fullName, nameOnly.map(c => c.sha))
      }
      catch (e: any) {
        log(`${row.fullName}: could not ask GitHub who wrote ${nameOnly.length} commits, so they do not count (${e?.message ?? e})`)
      }
    }
    const logins = ids.logins.map(l => l.toLowerCase())
    const commits = parsed.filter((c) => {
      const a = authorshipOf(c.authorName, c.authorEmail, ids)
      if (a === 'his') return true
      if (a !== 'name_only') return false
      const login = attributed.get(c.sha)
      return !!login && logins.includes(login.toLowerCase())
    })
    // Unlisted emails on commits that carry his login as the name and that GitHub links to no
    // account: Settings offers them, and they count only once he adds them.
    const candidates = new Map<string, number>()
    for (const c of nameOnly) {
      if (attributed.has(c.sha) && attributed.get(c.sha) === null) candidates.set(c.authorEmail.toLowerCase(), (candidates.get(c.authorEmail.toLowerCase()) ?? 0) + 1)
    }
    const allCount = Number((await runGit(['rev-list', '--all', '--no-merges', '--count'], { cwd: dir })).stdout.trim()) || null

    // The blobs his commits changed, minus what the clone already holds, fetched by id in batches.
    const wanted: string[] = []
    const seenOid = new Set<string>()
    for (const c of commits) {
      if (c.files.length >= LARGE_COMMIT_FILES) continue
      for (const f of c.files) {
        if (!isSearchablePath(f.path)) continue
        for (const oid of [f.oldOid, f.newOid]) {
          if (oid && !seenOid.has(oid)) {
            seenOid.add(oid)
            wanted.push(oid)
          }
        }
      }
    }
    const tree = await gitOk(['-c', 'core.quotePath=false', 'ls-tree', '-r', '--full-tree', ref], { cwd: dir, timeoutMs: 120_000, maxBytes: 200 * 1024 * 1024 })
    const manifests = tree.split('\n')
      .map((l) => {
        const m = /^\d{6} blob ([0-9a-f]{40,64})\t(.+)$/.exec(l)
        return m ? { oid: m[1]!, path: m[2]! } : null
      })
      .filter((m): m is { oid: string; path: string } => !!m && isManifest(m.path))
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
      .slice(0, MAX_MANIFESTS)
    for (const m of manifests) if (!seenOid.has(m.oid)) {
      seenOid.add(m.oid)
      wanted.unshift(m.oid)
    }
    const present = new Set((await gitOk(['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'], { cwd: dir, timeoutMs: 5 * 60_000, maxBytes: 512 * 1024 * 1024 })).split('\n'))
    let missing = wanted.filter(o => !present.has(o))
    let note: string | undefined
    if (missing.length > MAX_BLOBS_PER_REPO) {
      note = `only the newest ${MAX_BLOBS_PER_REPO} changed files are searchable`
      missing = missing.slice(0, MAX_BLOBS_PER_REPO)
    }
    for (let i = 0; i < missing.length; i += 1000) {
      const batch = missing.slice(i, i + 1000)
      await gitOk(['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', 'origin', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', '--filter=blob:none', '--stdin'], {
        cwd: dir, token, input: `${batch.join('\n')}\n`, timeoutMs: 10 * 60_000,
      })
    }

    // Dependencies at the default branch.
    const deps = new Map<string, string>()
    for (const m of manifests) {
      const r = await runGit(['cat-file', 'blob', m.oid], { cwd: dir, timeoutMs: 30_000, maxBytes: 2 * 1024 * 1024 })
      if (r.code !== 0) continue
      for (const name of parseManifest(m.path, r.stdout)) if (!deps.has(name)) deps.set(name, m.path)
    }
    let languages: Record<string, number> = {}
    try {
      languages = await repoLanguages(token, row.fullName)
    }
    catch (e: any) {
      log(`${row.fullName}: languages not read (${e?.message ?? e})`)
    }

    // Store: the index equals his current commit set, so removing an identity removes its commits.
    const known = new Set(db.select({ sha: repoCommits.sha }).from(repoCommits).where(eq(repoCommits.repo, row.fullName)).all().map(r => r.sha))
    const current = new Set(commits.map(c => c.sha))
    const fresh = commits.filter(c => !known.has(c.sha))
    const stale = [...known].filter(s => !current.has(s))
    const at = nowText()
    db.transaction((tx) => {
      for (const sha of stale) tx.delete(repoCommits).where(and(eq(repoCommits.repo, row.fullName), eq(repoCommits.sha, sha))).run()
      for (const c of fresh) {
        tx.insert(repoCommits).values({
          repo: row.fullName,
          sha: c.sha,
          authoredAt: c.authoredAt,
          authorName: c.authorName,
          authorEmail: c.authorEmail.toLowerCase(),
          message: c.message || '(no message)',
          pathsJson: JSON.stringify(c.files.map(f => f.path).slice(0, LARGE_COMMIT_FILES)),
          url: `https://github.com/${row.fullName}/commit/${c.sha}`,
        }).run()
      }
      tx.delete(repoFacts).where(eq(repoFacts.repo, row.fullName)).run()
      for (const [name, bytes] of Object.entries(languages)) tx.insert(repoFacts).values({ repo: row.fullName, kind: 'language', name, detail: String(bytes), updatedAt: at }).run()
      for (const [name, path] of deps) tx.insert(repoFacts).values({ repo: row.fullName, kind: 'dependency', name, detail: path, updatedAt: at }).run()
      tx.update(repoSources).set({ headSha, indexedAt: at, commitCount: commits.length, skipReason: null, indexError: null, updatedAt: at }).where(eq(repoSources.fullName, row.fullName)).run()
    })
    log(`${row.fullName}: ${commits.length} of his commits (${allCount ?? '?'} in the clone), ${fresh.length} new, ${missing.length} blobs fetched, ${deps.size} dependencies`)
    return { ...base, his: commits.length, all: allCount, newCommits: fresh.length, blobsFetched: missing.length, dependencies: deps.size, candidates: Object.fromEntries(candidates), ...(note ? { note } : {}) }
  }
  catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500)
    setRow({ indexError: msg })
    log(`${row.fullName}: failed (${msg})`)
    return { ...base, status: 'failed', note: msg }
  }
}

function nowText() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

// ── The task body ──

export interface IndexRunStats extends Record<string, unknown> {
  repos: number
  indexed: number
  skipped: number
  failed: number
  newCommits: number
  commits: number
  perRepo: Record<string, { his: number; all: number | null; status: string; note?: string }>
  errors: string[]
  unlistedEmails?: number
  note?: string
}

/** Index every repo switched on. payload.repos limits the run to those full names (still only switched-on ones). */
export async function runRepoIndex(opts: { repos?: string[] }, log: (m: string) => void): Promise<IndexRunStats> {
  const stats: IndexRunStats = { repos: 0, indexed: 0, skipped: 0, failed: 0, newCommits: 0, commits: 0, perRepo: {}, errors: [] }
  const accounts = await tokenAccounts({ fresh: true })
  if (!accounts.length) {
    stats.note = 'No GitHub read token is set (NUXT_GITHUB_READ_TOKENS, NUXT_GITHUB_READ_TOKEN, or NUXT_GITHUB_TOKEN), so nothing was indexed.'
    return stats
  }
  const listed = await refreshRepoList(accounts)
  if (listed.error) stats.errors.push(listed.error)
  const ids = currentIdentities(accounts)
  if (!ids.emails.length && !ids.logins.length) {
    stats.note = 'No author emails or logins are set in Settings, so no commit counts as yours yet.'
    return stats
  }
  prepareRepoCache()
  let repos = includedRepos()
  if (opts.repos?.length) repos = repos.filter(r => opts.repos!.includes(r.fullName))
  stats.repos = repos.length
  const candidates: Record<string, { commits: number; repos: string[] }> = {}
  for (const row of repos) {
    const res = await indexRepo(row, ids, log)
    for (const [email, n] of Object.entries(res.candidates ?? {})) {
      const c = candidates[email] ??= { commits: 0, repos: [] }
      c.commits += n
      c.repos.push(row.fullName)
    }
    stats.perRepo[row.fullName] = { his: res.his, all: res.all, status: res.status, ...(res.note ? { note: res.note } : {}) }
    stats.newCommits += res.newCommits
    stats.commits += res.his
    if (res.status === 'indexed') stats.indexed++
    else if (res.status === 'skipped') stats.skipped++
    else {
      stats.failed++
      stats.errors.push(`${row.fullName}: ${res.note ?? 'failed'}`)
    }
  }
  // Only a full run replaces the offered emails; a run limited to some repos would drop the rest.
  if (!opts.repos?.length) saveIdentityCandidates(candidates)
  stats.unlistedEmails = Object.keys(candidates).length
  return stats
}

