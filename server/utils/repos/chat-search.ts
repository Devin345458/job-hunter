import { eq, inArray } from 'drizzle-orm'
import { repoCommits, repoSources } from '../../db/schema'
import type { GithubChatSearch, GithubFinding } from '#shared/types/repos'
import { CodeSearchLimited, GithubApiError, isSsoError, isSsoSkip, readTokens, searchCode, tokenAccounts, tokenAt } from './github'
import { anchorPattern, cleanTerms, messageBody, pathMatches, searchEvidence, withSignatures, type TermSet } from './search'
import { APP_REPO, APP_REPO_DESCRIPTION, APP_REPO_FRAMING, currentIdentities, isAppRepo, savedIdentities, storedFind, type RepoRow } from './settings'

// The question chat's GitHub search (server/utils/question-chat.ts), in order:
// 1. Devin's indexed commits: messages and changed file paths. No diffs, so a chat turn takes
//    seconds instead of a git log -G over every clone.
// 2. repo_facts of the repos he switched on: declared dependencies and languages.
// 3. GitHub code search, only in switched-on repos that hold his commits. Every query names its
//    repos with repo: qualifiers, so a repo he has not switched on is never searched. Code in a
//    repo is not code he wrote, so a code search hit is a lead and is labeled as one.
// The findings and the coverage go to the panel as data; the panel builds the links.

export const CHAT_SEARCH_LIMITS = {
  commits: 8,
  files: 8,
  dependencies: 6,
  languages: 4,
  /** Code search requests in one chat search. GitHub allows 10 a minute per user. */
  codeRequests: 4,
  /** repo: qualifiers in one code search request, at most; the query length below decides first. */
  reposPerRequest: 40,
  /**
   * Characters in one code search query, the word and its repo: qualifiers together. GitHub answers
   * 400 "query exceeds max length" past 1,024 (measured 2026-11-04: 994 passed, 1,025 failed).
   */
  maxQueryChars: 1000,
  /** Words searched, one request each: the REST code search ANDs words and has no OR. */
  codeTerms: 4,
} as const

/** Any read token is set, or a repo is indexed: the chat can search something. */
export function githubSearchAvailable(): boolean {
  if (readTokens().length) return true
  return !!useDb().select({ n: repoSources.fullName }).from(repoSources).where(eq(repoSources.included, true)).limit(1).get()
}

/**
 * The code search words, one request each: identifiers and package names, quoted when they hold
 * punctuation. Words the question or Devin's message name ("GraphQL", "Shopify") go first.
 */
export function codeSearchWords(terms: TermSet, context = ''): string[] {
  const seen = new Set<string>()
  const words: string[] = []
  for (const raw of [...terms.code, ...terms.packages]) {
    const t = raw.replace(/[^\w@/.-]+/g, ' ').trim()
    if (t.length < 4 || t.includes(' ') || seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase())
    words.push(t)
  }
  const said = context.toLowerCase()
  const named = (w: string) => new RegExp(`(^|[^a-z0-9])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(said)
  return [...words.filter(named), ...words.filter(w => !named(w))]
    .slice(0, CHAT_SEARCH_LIMITS.codeTerms)
    .map(w => (/^\w+$/.test(w) ? w : `"${w}"`))
}

function repoCommitCount(r: RepoRow, found: Record<string, number> | null): number {
  return Math.max(r.commitCount ?? 0, found?.[r.fullName] ?? 0)
}

/**
 * Searches Devin's GitHub for the terms (Claude's, plus the file and package signatures of what
 * `context` names). opts.subject is the question's subject: with `context`, it decides which terms
 * can make a commit a hit (subjectAnchors in search.ts). opts.scopeTexts are the wordings the
 * question was asked as (appRepoScopeTexts in skill-catalog.ts), which open this app's repo when
 * they name one of its topics. Never throws for GitHub trouble: what could not be searched is in
 * coverage.
 */
export async function githubChatSearch(rawTerms: TermSet, context: string, log: (m: string) => void = () => {}, opts: { subject?: string | null; signatureText?: string; scopeTexts?: string[] } = {}): Promise<GithubChatSearch> {
  // Signatures follow the subject and Devin's own message (opts.signatureText), never the question text.
  const signatureText = opts.signatureText ?? (opts.subject?.trim() || context)
  const terms = withSignatures(cleanTerms(rawTerms, 20), signatureText)
  const db = useDb()
  // This app's own repo names every skill as data: searchEvidence reads its commits only for a
  // subject that names one of its topics, and code search never covers it.
  const included = db.select().from(repoSources).where(eq(repoSources.included, true)).all()
  const find = storedFind()
  const found = find?.at ? find.byRepo : null
  const indexed = included.filter(r => r.indexedAt)

  const result: GithubChatSearch = {
    terms: [...new Map([...terms.code, ...terms.paths, ...terms.packages].map(t => [t.toLowerCase(), t])).values()].slice(0, 16),
    findings: [],
    pathSummaries: [],
    coverage: {
      indexed: indexed.map(r => r.fullName),
      codeSearched: [],
      notIndexed: included.length - indexed.length,
      codeSkipped: 0,
      offWithCommits: found ? Object.entries(found).filter(([name, n]) => n > 0 && !included.some(r => r.fullName === name)).length : 0,
      codeNote: null,
    },
  }

  // 1 and 2: his indexed commits (messages and paths) and the repo facts.
  const evidence = await searchEvidence(terms, log, { diffs: false, anchors: { subject: opts.subject ?? null, text: context, signatureText, scopeTexts: opts.scopeTexts } })
  // This app's repo was looked at only when the subject named one of its topics.
  result.coverage.indexed = indexed.map(r => r.fullName).filter(n => !isAppRepo(n) || !!evidence.appRepo)
  // Strongest first, taken in turn from each repo so one busy repo does not fill the list.
  const byRepo = new Map<string, typeof evidence.hits>()
  for (const h of evidence.hits) byRepo.set(h.repo, [...(byRepo.get(h.repo) ?? []), h])
  const shown = interleave([...byRepo.values()]).slice(0, CHAT_SEARCH_LIMITS.commits)
  const messages = shown.length
    ? new Map(db.select({ sha: repoCommits.sha, message: repoCommits.message }).from(repoCommits).where(inArray(repoCommits.sha, shown.map(h => h.sha))).all().map(r => [r.sha, r.message] as const))
    : new Map<string, string>()
  // A commit is a hit through an anchor, so the panel names the anchor that matched.
  const textTerms = [...evidence.anchors.code, ...evidence.anchors.packages]
  const commits: GithubFinding[] = shown.map(h => ({
    kind: 'commit',
    repo: h.repo,
    url: h.url,
    title: h.subject,
    date: h.date,
    detail: h.reasons.includes('path') && h.paths.length
      ? `files: ${h.paths.slice(0, 3).join(', ')}${h.paths.length > 3 ? ` and ${h.paths.length - 3} more` : ''}`
      : messageMatch(messageBody(messages.get(h.sha) ?? h.subject), textTerms),
  }))
  result.pathSummaries = pathSummaries(indexed.map(r => r.fullName).filter(n => !isAppRepo(n)), evidence.anchors.paths)
  const dependencies: GithubFinding[] = evidence.dependencies.slice(0, CHAT_SEARCH_LIMITS.dependencies).map(d => ({
    kind: 'dependency',
    repo: d.repo,
    url: `https://github.com/${d.repo}/blob/HEAD/${d.manifest.split('/').map(encodeURIComponent).join('/')}`,
    title: d.name,
    date: null,
    detail: d.manifest,
  }))
  const languages: GithubFinding[] = evidence.languages.slice(0, CHAT_SEARCH_LIMITS.languages).map(l => ({
    kind: 'language',
    repo: l.repo,
    url: `https://github.com/${l.repo}`,
    title: l.name,
    date: null,
    detail: null,
  }))

  // 3: code search, only in switched-on repos that hold his commits (or are his own), most commits first.
  const files: GithubFinding[] = []
  // Code search looks only for anchors (subject words, named terms, signatures), like the commit hits.
  const words = codeSearchWords(evidence.anchors, context)
  let personal = new Set<string>()
  try {
    // Saved logins first: listing every repo of every token after a restart takes seconds.
    const logins = savedIdentities()?.logins ?? currentIdentities(await tokenAccounts()).logins
    personal = new Set(logins.map(l => l.toLowerCase()))
  }
  catch {}
  const eligible = included
    .filter(r => r.tokenIndex != null && !isSsoSkip(r.skipReason) && !isAppRepo(r.fullName))
    .filter(r => repoCommitCount(r, found) > 0 || personal.has(r.owner.toLowerCase()))
    .sort((a, b) => repoCommitCount(b, found) - repoCommitCount(a, found) || (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''))
  if (!words.length) {
    result.coverage.codeNote = 'Code search did not run: there was no word to search code for.'
  }
  else if (!eligible.length) {
    result.coverage.codeNote = 'Code search did not run: no switched-on repo holds your commits yet.'
  }
  else {
    const batches: RepoRow[][] = []
    const byToken = new Map<number, RepoRow[]>()
    for (const r of eligible) byToken.set(r.tokenIndex!, [...(byToken.get(r.tokenIndex!) ?? []), r])
    // Room for the longest word, so every word's query fits.
    const room = CHAT_SEARCH_LIMITS.maxQueryChars - Math.max(...words.map(w => w.length)) - 1
    for (const list of byToken.values()) {
      for (const names of repoBatches(list.map(r => r.fullName), room)) batches.push(names.map(n => list.find(r => r.fullName === n)!))
    }
    const allowed = new Set(eligible.map(r => r.fullName.toLowerCase()))
    const seen = new Set<string>()
    const searched = new Set<string>()
    const searchedWords = new Set<string>()
    let requests = 0
    // Every batch for the first word, then the next word: a word counts once it covered every repo.
    outer: for (const word of words) {
      for (const batch of batches) {
        if (requests >= CHAT_SEARCH_LIMITS.codeRequests) break outer
        const token = tokenAt(batch[0]!.tokenIndex)
        if (!token) continue
        requests++
        try {
          const page = await searchCode(token, `${word} ${batch.map(r => `repo:${r.fullName}`).join(' ')}`)
          batch.forEach(r => searched.add(r.fullName))
          searchedWords.add(word)
          for (const item of page.items) {
          const repo = item.repository?.full_name ?? ''
          // Never show a file from a repo outside this batch's switched-on list.
          if (!allowed.has(repo.toLowerCase())) continue
          const key = `${repo}/${item.path}`.toLowerCase()
            if (seen.has(key)) continue
            seen.add(key)
            files.push({ kind: 'file', repo, url: item.html_url, title: item.path, date: null, detail: `has "${word.replace(/"/g, '')}"` })
          }
        }
        catch (e: any) {
          if (e instanceof CodeSearchLimited) {
            result.coverage.codeNote = `GitHub code search allows 10 searches a minute, so it stopped early. Ask again in ${e.seconds < 90 ? `${e.seconds} seconds` : 'a few minutes'} to search the rest.`
            break outer
          }
          const msg = String(e?.message ?? e)
          if (isSsoError(msg)) result.coverage.codeNote = `Code search was refused for ${batch[0]!.owner} until the token is authorized for its SAML SSO.`
          else if (e instanceof GithubApiError && e.status === 422) result.coverage.codeNote = 'GitHub could not code search some of these repos.'
          else result.coverage.codeNote = 'Code search failed for some repos. Try again in a minute.'
          log(`code search failed: ${msg.slice(0, 200)}`)
        }
      }
    }
    result.coverage.codeSearched = eligible.map(r => r.fullName).filter(n => searched.has(n))
    result.coverage.codeSkipped = eligible.length - result.coverage.codeSearched.length
    const leftWords = words.filter(w => !searchedWords.has(w))
    if (!result.coverage.codeNote && (result.coverage.codeSkipped > 0 || leftWords.length)) {
      result.coverage.codeNote = `Code search looked only for ${[...searchedWords].join(', ') || 'nothing'}${result.coverage.codeSkipped ? ` in the ${result.coverage.codeSearched.length} switched-on repos with the most of your commits` : ''}, to stay under GitHub's limit of 10 searches a minute.`
    }
  }

  result.findings = [...commits, ...spread(files, CHAT_SEARCH_LIMITS.files), ...dependencies, ...languages]
  return result
}

/**
 * Repo names packed into groups whose repo: qualifiers, joined by spaces, fit in `room` characters
 * (and at most reposPerRequest of them), in the order given.
 */
export function repoBatches(names: string[], room: number): string[][] {
  const out: string[][] = []
  let batch: string[] = []
  let length = 0
  for (const name of names) {
    const add = `repo:${name}`.length + (batch.length ? 1 : 0)
    if (batch.length && (length + add > room || batch.length >= CHAT_SEARCH_LIMITS.reposPerRequest)) {
      out.push(batch)
      batch = []
      length = 0
    }
    batch.push(name)
    length += `repo:${name}`.length + (batch.length > 1 ? 1 : 0)
  }
  if (batch.length) out.push(batch)
  return out
}

/** Which search word a commit message holds, as the panel shows it: 'message has "GraphQL"'. */
function messageMatch(message: string, words: string[]): string {
  for (const w of words) {
    const m = new RegExp(anchorPattern(w), 'i').exec(message)
    if (m) return `message has "${m[0]}"`
  }
  return 'commit message'
}

/**
 * Per repo, how many of his commits change a file matching the path terms, whatever their
 * messages say, with the matching file names they change most.
 */
function pathSummaries(repos: string[], paths: string[]) {
  if (!paths.length || !repos.length) return []
  const out: Array<{ repo: string; commits: number; first: string; last: string; files: string[] }> = []
  const rows = useDb().select({ repo: repoCommits.repo, authoredAt: repoCommits.authoredAt, pathsJson: repoCommits.pathsJson })
    .from(repoCommits).where(inArray(repoCommits.repo, repos)).all()
  for (const repo of repos) {
    let count = 0
    let first = ''
    let last = ''
    const files = new Map<string, number>()
    for (const r of rows) {
      if (r.repo !== repo) continue
      let list: string[] = []
      try {
        list = JSON.parse(r.pathsJson ?? '[]')
      }
      catch {}
      const matched = list.filter(p => pathMatches(p, paths))
      if (!matched.length) continue
      count++
      const day = r.authoredAt.slice(0, 10)
      if (!first || day < first) first = day
      if (!last || day > last) last = day
      for (const p of matched) {
        const name = p.split('/').pop() ?? p
        files.set(name, (files.get(name) ?? 0) + 1)
      }
    }
    if (count) out.push({ repo, commits: count, first, last, files: [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n) })
  }
  return out.sort((a, b) => b.commits - a.commits)
}

/**
 * Up to `max` files, taken in turn from each searched word and, within a word, from each repo, so
 * one busy word or repo does not fill the list.
 */
function spread(files: GithubFinding[], max: number): GithubFinding[] {
  const byWord = new Map<string, Map<string, GithubFinding[]>>()
  for (const f of files) {
    const repos = byWord.get(f.detail ?? '') ?? new Map<string, GithubFinding[]>()
    repos.set(f.repo, [...(repos.get(f.repo) ?? []), f])
    byWord.set(f.detail ?? '', repos)
  }
  return interleave([...byWord.values()].map(repos => interleave([...repos.values()]))).slice(0, max)
}

/** First items of every list, then the second ones, and so on. */
function interleave<T>(lists: T[][]): T[] {
  const out: T[] = []
  for (let i = 0; lists.some(l => i < l.length); i++) {
    for (const l of lists) if (i < l.length) out.push(l[i]!)
  }
  return out
}

function list(names: string[], max = 8): string {
  if (!names.length) return 'none'
  return names.length > max ? `${names.slice(0, max).join(', ')}, and ${names.length - max} more` : names.join(', ')
}

/** The search result as the chat prompt shows it, numbered so a reply can name an item. */
export function githubPromptSection(s: GithubChatSearch): string {
  const lines: string[] = [`Searched for: ${s.terms.join(', ') || '(nothing)'}`]
  const of = (k: GithubFinding['kind']) => s.findings.filter(f => f.kind === k)
  const commits = of('commit')
  const files = of('file')
  const deps = of('dependency')
  const langs = of('language')
  if (commits.length) {
    lines.push('\nHis own commits (authored by Devin, checked against his emails and logins):')
    commits.forEach((f, i) => lines.push(`[C${i + 1}] ${f.repo} | ${f.date} | ${f.title} | matched: ${f.detail}`))
    if (commits.some(f => isAppRepo(f.repo))) lines.push(`${APP_REPO} is ${APP_REPO_DESCRIPTION.replace(/\bI\b/g, 'he')}. ${APP_REPO_FRAMING}`)
  }
  for (const p of s.pathSummaries) lines.push(`${p.repo}: ${p.commits} of his commits change ${p.files.join(', ')}, from ${p.first} to ${p.last}`)
  if (files.length) {
    lines.push('\nFiles GitHub code search found in switched-on repos that hold some of his commits. Leads only: someone else may have written them:')
    files.forEach((f, i) => lines.push(`[F${i + 1}] ${f.repo} | ${f.title}${f.detail ? ` | ${f.detail}` : ''}`))
  }
  if (deps.length) {
    lines.push('\nPackages these repos declare (context only, not proof he used them):')
    deps.forEach((f, i) => lines.push(`[D${i + 1}] ${f.repo}: ${f.title} in ${f.detail}`))
  }
  if (langs.length) lines.push(`\nRepo languages that match: ${langs.map(f => `${f.repo} (${f.title})`).join(', ')}`)
  if (!s.findings.length) lines.push('\nNothing matched.')
  const c = s.coverage
  lines.push(`\nWhere it looked: his indexed commits in ${c.indexed.length} switched-on repos (${list(c.indexed)}); code search in ${c.codeSearched.length} repos.`)
  if (c.notIndexed) lines.push(`${c.notIndexed} switched-on repos are not indexed yet.`)
  if (c.offWithCommits) lines.push(`${c.offWithCommits} repos that hold his commits are switched off in Settings, so they were not searched.`)
  if (c.codeNote) lines.push(c.codeNote)
  return lines.join('\n')
}
