import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { repoCommits, repoFacts, repoSources } from '../../db/schema'
import { tokenAt } from './github'
import { repoCacheDir, runGit } from './git'
import { LARGE_COMMIT_FILES, excludedPathspecs } from './indexer'

// Searches Devin's indexed commits for the terms one question expands into: commit messages and
// changed paths from the database, his diffs from the local clones (git log -G over his commit
// list only, cut to the matching lines), and dependency names from the manifests. A dependency
// alone is context, never evidence: evidence is always one of his commits.

export interface TermSet {
  /** Identifiers, API names, and words found in code, diffs, or commit messages. */
  code: string[]
  /** File extensions (".cs") or path fragments ("/scim/"). */
  paths: string[]
  /** Package names (npm, composer, pip, go, gem, cargo, nuget). */
  packages: string[]
}

export type HitReason = 'diff' | 'message' | 'path'

export interface CommitHit {
  repo: string
  sha: string
  url: string
  /** YYYY-MM-DD */
  date: string
  subject: string
  reasons: HitReason[]
  /** Changed paths that matched a path term or held a matching diff line. */
  paths: string[]
  /** Matching changed lines, cut short. Empty for message and path hits. */
  excerpt: string
}

export interface RepoPathSummary {
  repo: string
  /** His commits that touch a file matching a path term. */
  commits: number
  first: string
  last: string
}

export interface SearchResult {
  hits: CommitHit[]
  pathSummaries: RepoPathSummary[]
  dependencies: Array<{ repo: string; name: string; manifest: string }>
  languages: Array<{ repo: string; name: string }>
  repos: Array<{ repo: string; isPrivate: boolean; owner: string }>
  errors: string[]
}

const MAX_HITS = 14
const MAX_PER_REPO = 6
const EXCERPT_LINE = 160
const EXCERPT_COMMIT = 700
const EXCERPT_TOTAL = 5000

function escapeJs(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeEre(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Terms that are plain short words match as whole words, so "Go" never matches "good". */
function termPattern(t: string) {
  const e = escapeJs(t)
  return /^[a-z0-9]{1,4}$/i.test(t) ? `(?<![A-Za-z0-9])${e}(?![A-Za-z0-9])` : e
}

export function cleanTerms(t: TermSet): TermSet {
  const clean = (list: string[], min: number) => [...new Map(list
    .map(s => String(s ?? '').trim())
    .filter(s => s.length >= min && s.length <= 60 && !/[\r\n]/.test(s))
    .map(s => [s.toLowerCase(), s])).values()].slice(0, 12)
  return { code: clean(t.code, 3), paths: clean(t.paths, 2), packages: clean(t.packages, 2) }
}

function pathMatches(path: string, terms: string[]): boolean {
  const p = path.toLowerCase()
  return terms.some((t) => {
    const x = t.toLowerCase()
    return x.startsWith('.') && !x.includes('/') ? p.endsWith(x) : p.includes(x)
  })
}

function depMatches(name: string, terms: string[]): boolean {
  const n = name.toLowerCase()
  return terms.some((t) => {
    const x = t.toLowerCase()
    return n === x || n.startsWith(`${x}/`) || (x.length >= 5 && n.includes(x))
  })
}

interface DiffHit {
  paths: Set<string>
  lines: string[]
}

/** Parses `git log -p --format=%x1e%H` and keeps changed lines that match the JS pattern. */
function parseDiffHits(out: string, re: RegExp): Map<string, DiffHit> {
  const hits = new Map<string, DiffHit>()
  for (const rec of out.split('\x1e')) {
    const nl = rec.indexOf('\n')
    const sha = (nl >= 0 ? rec.slice(0, nl) : rec).trim()
    if (!/^[0-9a-f]{40,64}$/.test(sha)) continue
    let file = ''
    const hit: DiffHit = { paths: new Set(), lines: [] }
    for (const line of rec.slice(nl + 1).split('\n')) {
      if (line.startsWith('diff --git ')) {
        const m = / b\/(.+)$/.exec(line)
        file = m ? m[1]! : ''
        continue
      }
      if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('Binary files')) continue
      if ((line.startsWith('+') || line.startsWith('-')) && re.test(line.slice(1))) {
        hit.paths.add(file)
        if (hit.lines.length < 8) {
          const text = line.slice(1).trim().replace(/\s+/g, ' ')
          hit.lines.push(`${file}: ${line[0]} ${text.length > EXCERPT_LINE ? `${text.slice(0, EXCERPT_LINE - 1)}…` : text}`)
        }
      }
    }
    if (hit.paths.size) hits.set(sha, hit)
  }
  return hits
}

export async function searchEvidence(rawTerms: TermSet, log: (m: string) => void = () => {}): Promise<SearchResult> {
  const terms = cleanTerms(rawTerms)
  const db = useDb()
  const repos = db.select().from(repoSources).where(and(eq(repoSources.included, true), isNotNull(repoSources.indexedAt))).all()
  const result: SearchResult = {
    hits: [],
    pathSummaries: [],
    dependencies: [],
    languages: [],
    repos: repos.map(r => ({ repo: r.fullName, isPrivate: r.isPrivate, owner: r.owner })),
    errors: [],
  }
  if (!repos.length) return result
  const names = repos.map(r => r.fullName)

  const textTerms = [...terms.code, ...terms.packages]
  const textRe = textTerms.length ? new RegExp(textTerms.map(termPattern).join('|'), 'i') : null

  for (const f of db.select().from(repoFacts).where(inArray(repoFacts.repo, names)).all()) {
    if (f.kind === 'dependency' && (depMatches(f.name, terms.packages) || depMatches(f.name, terms.code))) {
      result.dependencies.push({ repo: f.repo, name: f.name, manifest: f.detail ?? '' })
    }
    if (f.kind === 'language' && [...terms.code, ...terms.packages, ...terms.paths.map(p => p.replace(/^\./, ''))].some(t => t.toLowerCase() === f.name.toLowerCase())) {
      result.languages.push({ repo: f.repo, name: f.name })
    }
  }

  const all: Array<CommitHit & { score: number }> = []
  for (const repo of repos) {
    const commits = db.select().from(repoCommits).where(eq(repoCommits.repo, repo.fullName)).all()
    if (!commits.length) continue
    const byRepo = new Map<string, CommitHit & { score: number }>()
    const add = (c: typeof commits[number], reason: HitReason, paths: string[] = [], excerpt = '') => {
      let h = byRepo.get(c.sha)
      if (!h) {
        h = {
          repo: repo.fullName,
          sha: c.sha,
          url: c.url,
          date: c.authoredAt.slice(0, 10),
          subject: c.message.split('\n')[0]!.slice(0, 200),
          reasons: [],
          paths: [],
          excerpt: '',
          score: 0,
        }
        byRepo.set(c.sha, h)
      }
      if (!h.reasons.includes(reason)) {
        h.reasons.push(reason)
        h.score += reason === 'diff' ? 3 : reason === 'message' ? 2 : 1
      }
      for (const p of paths) if (!h.paths.includes(p) && h.paths.length < 6) h.paths.push(p)
      if (excerpt && !h.excerpt) h.excerpt = excerpt
    }

    // Messages and paths, from the index.
    const pathOnly: typeof commits = []
    for (const c of commits) {
      const paths = JSON.parse(c.pathsJson ?? '[]') as string[]
      if (textRe && textRe.test(c.message)) add(c, 'message')
      if (terms.paths.length) {
        const matched = paths.filter(p => pathMatches(p, terms.paths))
        if (matched.length) {
          if (textRe && textRe.test(c.message)) add(c, 'path', matched)
          else pathOnly.push(c)
        }
      }
    }
    if (pathOnly.length) {
      const sorted = [...pathOnly].sort((a, b) => a.authoredAt.localeCompare(b.authoredAt))
      result.pathSummaries.push({ repo: repo.fullName, commits: pathOnly.length, first: sorted[0]!.authoredAt.slice(0, 10), last: sorted[sorted.length - 1]!.authoredAt.slice(0, 10) })
      // The earliest and the latest two stand for the rest.
      for (const c of [...new Set([sorted[0]!, sorted[1], sorted[sorted.length - 2], sorted[sorted.length - 1]!].filter(Boolean))] as typeof commits) {
        add(c, 'path', (JSON.parse(c.pathsJson ?? '[]') as string[]).filter(p => pathMatches(p, terms.paths)))
      }
    }

    // His diffs, from the clone: only his indexed commits, only searchable paths.
    if (textRe) {
      const shas = commits.filter(c => (JSON.parse(c.pathsJson ?? '[]') as string[]).length < LARGE_COMMIT_FILES).map(c => c.sha)
      const ere = `(${textTerms.map(escapeEre).join('|')})`
      const r = await runGit([
        '-c', 'core.quotePath=false', 'log', '--no-walk=unsorted', '--stdin', '--regexp-ignore-case', `-G${ere}`,
        '-p', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--format=%x1e%H',
        '--', '.', ...excludedPathspecs(),
      ], { cwd: repoCacheDir(repo.fullName), token: tokenAt(repo.tokenIndex), input: `${shas.join('\n')}\n`, timeoutMs: 120_000, maxBytes: 8 * 1024 * 1024 })
      if (r.code !== 0 && !r.truncated) {
        result.errors.push(`${repo.fullName}: diff search failed`)
        log(`${repo.fullName}: diff search failed (${r.stderr.split('\n').filter(l => l && !/promisor/i.test(l)).join(' ').slice(0, 200)})`)
      }
      const bySha = new Map(commits.map(c => [c.sha, c] as const))
      for (const [sha, d] of parseDiffHits(r.stdout, textRe)) {
        const c = bySha.get(sha)
        if (!c) continue
        let excerpt = d.lines.join('\n')
        if (excerpt.length > EXCERPT_COMMIT) excerpt = `${excerpt.slice(0, EXCERPT_COMMIT - 1)}…`
        add(c, 'diff', [...d.paths], excerpt)
      }
    }
    all.push(...[...byRepo.values()].sort((a, b) => b.score - a.score || b.date.localeCompare(a.date)).slice(0, MAX_PER_REPO))
  }

  // Strongest first across repos, then a budget on the excerpt text sent anywhere.
  let budget = EXCERPT_TOTAL
  result.hits = all
    .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date))
    .slice(0, MAX_HITS)
    .map(({ score, ...h }) => {
      if (h.excerpt.length > budget) h.excerpt = budget > 80 ? `${h.excerpt.slice(0, budget - 1)}…` : ''
      budget -= h.excerpt.length
      return h
    })
  return result
}
