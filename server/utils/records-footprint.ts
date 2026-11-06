import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { repoCommits, repoSources } from '../db/schema'
import type { KnowledgeEntry } from './knowledge'
import { anchorPattern, appRepoAnchors, appRepoMessage, appRepoPath, appRepoScopeOf, messageBody, pathMatches, subjectAnchors, subjectParts, type TermSet } from './repos/search'
import { APP_REPO_DESCRIPTION, isAppRepo } from './repos/settings'

// Where Devin's own work on a subject sits: how much of it touches the subject, counted by code over
// every one of his indexed commits (not the few the chat search shows), the projects where it
// clusters (the candidate stories a draft is built around), and which roles in his knowledge base
// name it. The counts only pick the stories and the sample commits. They are never a record a
// draft cites, and no draft states them (Devin, 2026-11-05: no statistics only a script would
// count): a scope or count stands only on his own words or his knowledge base, and
// unsupportedScope() below holds every sentence to that.

export const FOOTPRINT_LIMITS = {
  /** Commits added to the draft's records beside the chat search's, one per project, busiest projects first. */
  sampleCommits: 8,
  /** Matched file names and message words the aggregate names. */
  topFiles: 4,
  topWords: 4,
  /** Candidate stories: the projects with the most matching commits, and the commits read in full from each. */
  storyProjects: 3,
  /** Commits read in full from the busiest project, and from each of the others. */
  storyCommits: 8,
  storyCommitsOther: 4,
} as const

export interface SubjectFootprint {
  /** The question's subject as the record names it. */
  subject: string
  commits: number
  projects: number
  firstYear: string
  lastYear: string
  /** Projects (and commits) with a matching commit in each year, oldest first. */
  perYear: Array<{ year: string; projects: number; commits: number }>
  /** Changed files that matched, by commits, most first ("docker-compose.yml"), with the folder they sit in most (".github/workflows"). */
  files: Array<{ name: string; commits: number; folder: string | null }>
  /** Anchor words that matched in commit messages, by commits, most first. */
  words: Array<{ word: string; commits: number }>
  /** One telling commit per project, busiest projects first: examples of the kinds of work. */
  sample: Array<{ repo: string; url: string; title: string; date: string }>
  /** Of the commits, those in this app's own repo, which Claude Code agents he directed wrote. */
  directed: number
  /**
   * The candidate stories: the projects with the most matching commits, each with its most telling
   * commits (the subject in the title, a long body, figures such as "257 to 0", recent), oldest
   * first. The draft reads these commits' full messages and builds its answer around one of them.
   */
  stories: Array<{ repo: string; commits: number; first: string; last: string; picks: Array<{ url: string; title: string; date: string; score: number }> }>
}

/** Figures a commit body states: "257 to 0", "32/32", "1,903", "44px", "17 findings". */
const FIGURE = /\b\d[\d,.]*(?:\s*(?:\/|to|x|->)\s*\d[\d,.]*)?(?:%|px|ms|s\b)?/g

/**
 * How well a commit tells a story about the subject: the subject in its title, a body that explains
 * the work, figures that measure it, and recent work first among equals. A docs commit records
 * writing, not building, but an audit or a design it records is often what set the work off, so it
 * stays a candidate below the code commits.
 */
export function storyScore(c: { title: string; body: string; date: string; inTitle: boolean; wordHit: boolean; pathShare: number; newest: string }): number {
  const rest = c.body.slice(c.title.length)
  const figures = (rest.match(FIGURE) ?? []).filter(f => !/^(?:19|20)\d{2}$/.test(f)).length
  const ageYears = Math.max(0, (Date.parse(c.newest) - Date.parse(c.date)) / (365 * 864e5))
  return (c.inTitle ? 100 : c.pathShare >= 0.5 ? 50 : c.wordHit ? 40 : 10)
    + Math.min(rest.trim().length, 1500) / 50
    + Math.min(figures, 8) * 6
    + Math.max(0, 15 - ageYears * 5)
    - (/^(?:\[[^\]]*\]\s*)?docs(?:\([^)]*\))?!?:/i.test(c.title) ? 30 : 0)
}

/**
 * The anchors the counts use: the subject's own words and its signatures (known aliases, files,
 * packages), from the subject alone (the question when there is none). Never the search plan's
 * terms, which Claude picks anew each time: the same records always give the same counts.
 */
export function draftAnchors(subject: string | null, question: string): TermSet {
  const text = subject?.trim() || question
  return subjectAnchors({ code: [], paths: [], packages: [] }, subject?.trim() || null, text, text)
}

/** A count rounded down to a figure a person would say: 52 to 50, 377 to 350, 1,240 to 1,200. The eval scripts use it to show that even a rounded count is not a claim. */
export function roundedDown(n: number): number | null {
  const step = n >= 1000 ? 100 : n >= 100 ? 50 : n >= 30 ? 10 : 5
  let r = Math.floor(n / step) * step
  if (r === n) r -= step
  return r >= 10 ? r : null
}

/**
 * Counts Devin's own commits in switched-on, indexed repos that match the anchors the way the chat
 * search does: a message (trailers left out) naming an anchor word, or a changed path matching an
 * anchor path. This app's own repo counts only for a subject that names one of its topics, or
 * whose question was asked as wording that does (scopeTexts, appRepoScopeTexts() in
 * skill-catalog.ts), by its own anchors (appRepoScopeOf, appRepoAnchors in repos/search.ts). Null
 * when none match.
 */
export function subjectFootprint(subject: string, anchors: TermSet, scopeTexts: string[] = []): SubjectFootprint | null {
  const words = [...anchors.code, ...anchors.packages]
  const wordRe = words.length ? new RegExp(words.map(anchorPattern).join('|'), 'i') : null
  const app = appRepoScopeOf([subject, ...scopeTexts])
  const appAnchors = app ? appRepoAnchors(app) : null
  const appWords = appAnchors ? [...appAnchors.code, ...appAnchors.packages] : []
  const appRe = appWords.length ? new RegExp(appWords.map(anchorPattern).join('|'), 'i') : null
  if (!wordRe && !anchors.paths.length && !appRe) return null
  const db = useDb()
  const repos = db.select({ fullName: repoSources.fullName }).from(repoSources)
    .where(and(eq(repoSources.included, true), isNotNull(repoSources.indexedAt))).all()
    .map(r => r.fullName).filter(n => !isAppRepo(n) || !!app)
  if (!repos.length) return null
  const rows = db.select({ repo: repoCommits.repo, url: repoCommits.url, authoredAt: repoCommits.authoredAt, message: repoCommits.message, pathsJson: repoCommits.pathsJson })
    .from(repoCommits).where(inArray(repoCommits.repo, repos)).all()

  let commits = 0
  let directed = 0
  const byRepo = new Map<string, number>()
  const years = new Map<string, { projects: Set<string>; commits: number }>()
  const files = new Map<string, { name: string; commits: number; folders: Map<string, number> }>()
  const matchedWords = new Map<string, number>()
  // The most telling commit per project: one whose message names the subject, else a small change.
  const best = new Map<string, { score: number; url: string; title: string; date: string }>()
  // Every telling commit per project, for the candidate stories.
  const told = new Map<string, Array<{ url: string; title: string; date: string; body: string; inTitle: boolean; wordHit: boolean; pathShare: number }>>()
  const span = new Map<string, { first: string; last: string }>()
  for (const r of rows) {
    const own = isAppRepo(r.repo)
    const re = own ? appRe : wordRe
    const anchorPaths = own ? appAnchors?.paths ?? [] : anchors.paths
    const body = own ? appRepoMessage(r.message) : messageBody(r.message)
    const wordHit = re ? re.exec(body) : null
    let paths: string[] = []
    try {
      paths = (JSON.parse(r.pathsJson ?? '[]') as string[]).filter(p => !own || appRepoPath(p))
    }
    catch {}
    const pathHits = anchorPaths.length ? paths.filter(p => pathMatches(p, anchorPaths)) : []
    if (!wordHit && !pathHits.length) continue
    commits++
    if (own) directed++
    byRepo.set(r.repo, (byRepo.get(r.repo) ?? 0) + 1)
    const day = r.authoredAt.slice(0, 10)
    const sp = span.get(r.repo)
    span.set(r.repo, { first: !sp || day < sp.first ? day : sp.first, last: !sp || day > sp.last ? day : sp.last })
    const year = r.authoredAt.slice(0, 4)
    const y = years.get(year) ?? { projects: new Set<string>(), commits: 0 }
    y.projects.add(r.repo)
    y.commits++
    years.set(year, y)
    if (wordHit) {
      const w = wordHit[0].toLowerCase().replace(/\s+/g, ' ')
      matchedWords.set(w, (matchedWords.get(w) ?? 0) + 1)
    }
    const byName = new Map<string, string>()
    for (const p of pathHits) byName.set(p.split('/').pop() ?? p, p.split('/').slice(0, -1).join('/'))
    for (const [name, folder] of byName) {
      const f = files.get(name.toLowerCase()) ?? { name, commits: 0, folders: new Map<string, number>() }
      f.commits++
      if (folder) f.folders.set(folder, (f.folders.get(folder) ?? 0) + 1)
      files.set(name.toLowerCase(), f)
    }
    // The title as written (docs file names kept); the match test reads it as the anchors do.
    const title = messageBody(r.message).split('\n')[0]!.trim()
    if (/^merge\b/i.test(title) || title.length < 12) continue
    // A message that names the subject says what the work was. A commit matched by its files only
    // speaks for the subject when those files are most of what it changed; a docs commit records
    // writing, not building.
    const pathShare = paths.length ? pathHits.length / paths.length : 0
    if (!wordHit && pathShare < 0.5 && paths.length > 3) continue
    // The title naming it beats a long body that mentions it once.
    const inTitle = !!re && re.test(own ? appRepoMessage(title) : title)
    const score = (inTitle ? 100 : pathShare >= 0.5 ? 60 : wordHit ? 40 : 20)
      + Math.min(title.length, 80) / 8
      - (/^(?:\[[^\]]*\]\s*)?docs(?:\([^)]*\))?!?:/i.test(title) ? 60 : 0)
    const prev = best.get(r.repo)
    if (!prev || score > prev.score) best.set(r.repo, { score, url: r.url, title: title.slice(0, 200), date: r.authoredAt.slice(0, 10) })
    told.set(r.repo, [...(told.get(r.repo) ?? []), { url: r.url, title: title.slice(0, 200), date: day, body, inTitle, wordHit: !!wordHit, pathShare }])
  }
  if (!commits) return null
  const perYear = [...years.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([year, v]) => ({ year, projects: v.projects.size, commits: v.commits }))
  const busiest = [...byRepo.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([repo]) => repo)
  const newest = [...span.values()].reduce((m, v) => (v.last > m ? v.last : m), '')
  const stories = busiest.filter(repo => told.has(repo)).slice(0, FOOTPRINT_LIMITS.storyProjects).map((repo, i) => {
    const picks = told.get(repo)!
      .map(c => ({ url: c.url, title: c.title, date: c.date, score: Math.round(storyScore({ ...c, newest })) }))
      .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date))
      .slice(0, i === 0 ? FOOTPRINT_LIMITS.storyCommits : FOOTPRINT_LIMITS.storyCommitsOther)
      .sort((a, b) => a.date.localeCompare(b.date))
    return { repo, commits: byRepo.get(repo)!, first: span.get(repo)!.first, last: span.get(repo)!.last, picks }
  })
  return {
    subject,
    commits,
    projects: byRepo.size,
    firstYear: perYear[0]!.year,
    lastYear: perYear[perYear.length - 1]!.year,
    perYear,
    files: [...files.values()].sort((a, b) => b.commits - a.commits).slice(0, FOOTPRINT_LIMITS.topFiles).map(f => ({
      name: f.name,
      commits: f.commits,
      // The folder most of them sit in, when most of them sit in one.
      folder: [...f.folders.entries()].sort((a, b) => b[1] - a[1]).find(([, n]) => n * 2 >= f.commits)?.[0] ?? null,
    })),
    words: [...matchedWords.entries()].sort((a, b) => b[1] - a[1]).slice(0, FOOTPRINT_LIMITS.topWords).map(([word, n]) => ({ word, commits: n })),
    sample: busiest.map(repo => ({ repo, ...best.get(repo)! })).filter(s => s.url).slice(0, FOOTPRINT_LIMITS.sampleCommits)
      .map(({ repo, url, title, date }) => ({ repo, url, title, date })),
    directed,
    stories,
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

/**
 * The counts in one paragraph, for the eval scripts and the log. No draft is sent them: they pick
 * the candidate stories, and no figure in them is ever a claim (unsupportedScope).
 */
export function footprintText(f: SubjectFootprint): string {
  const span = f.firstYear === f.lastYear ? `in ${f.firstYear}` : `from ${f.firstYear} to ${f.lastYear}`
  const latest = f.perYear[f.perYear.length - 1]!
  const lines = [
    `Projects where Devin's own commits (work he wrote or changed) match ${f.subject}: ${plural(f.projects, 'project', 'projects')}, ${span}${f.perYear.length > 1 ? `, ${latest.projects} of them in ${latest.year}` : ''}.`,
    f.perYear.length > 1 ? `Projects per year: ${f.perYear.map(y => `${y.year}: ${y.projects}`).join(', ')}.` : null,
    `Commits in all: ${f.commits.toLocaleString('en-US')}.`,
    f.files.length ? `Files these commits change most: ${f.files.map(x => `${x.name} (${plural(x.commits, 'commit', 'commits')}${x.folder ? `, mostly in ${x.folder}` : ''})`).join(', ')}.` : null,
    f.words.length ? `Words their messages use most: ${f.words.map(x => `${x.word} (${plural(x.commits, 'commit', 'commits')})`).join(', ')}.` : null,
    f.directed ? `${plural(f.directed, 'of these commits is', 'of these commits are')} in ${APP_REPO_DESCRIPTION.replace(/\bI\b/g, 'he')}.` : null,
  ]
  return lines.filter(Boolean).join(' ')
}

/** The counts in one line, for the log. */
export function footprintDetail(f: SubjectFootprint): string {
  const span = f.firstYear === f.lastYear ? f.firstYear : `${f.firstYear} to ${f.lastYear}`
  return `${f.subject}, ${plural(f.commits, 'commit', 'commits')} in ${plural(f.projects, 'project', 'projects')}, ${span}`
}

// ── Roles that name the subject ─────────────────────────────

/**
 * Tools a role line may name instead of the subject itself: Kubernetes runs containers, Sentry is
 * error monitoring. Only for finding role lines; never anchors, so no commit becomes a hit by them.
 */
const RELATED_ROLE_WORDS: Array<{ when: RegExp; words: string[] }> = [
  { when: /\bdocker\b|\bcontaineri[sz]|\bcontainers?\b/i, words: ['Docker', 'Kubernetes', 'container', 'containers'] },
  // Not Elasticsearch: a role line names it for reporting as often as for logs.
  { when: /observab|\bmonitoring\b|\blogging\b|\bincident|\balerting\b/i, words: ['Sentry', 'Kibana', 'Grafana', 'Prometheus', 'monitoring', 'logging', 'alerting', 'debugging'] },
  { when: /\bpayments?\b|\bbilling\b|\breconcil|\bfinancial\b/i, words: ['Stripe', 'payment', 'payments', 'billing', 'invoices'] },
]

export interface RoleMention {
  entry: KnowledgeEntry
  /** "Oct 2021 - Present" */
  period: string | null
  /** The role's lines that name the subject or a related tool. */
  lines: string[]
}

/** Experience entries in the knowledge base with the lines that name the subject, its anchors, or a related tool. */
export function roleMentions(entries: KnowledgeEntry[], subject: string, anchors: TermSet): RoleMention[] {
  const words = [
    ...subjectParts(subject),
    ...anchors.code.filter(w => w.length >= 3),
    ...RELATED_ROLE_WORDS.filter(r => r.when.test(subject)).flatMap(r => r.words),
  ]
  if (!words.length) return []
  const re = new RegExp(words.map(anchorPattern).join('|'), 'i')
  const out: RoleMention[] = []
  for (const e of entries) {
    if (e.category !== 'experience') continue
    const parts = e.value.split('\n').map(l => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean)
    const period = /^[A-Z][a-z]{2} \d{4}\s*-\s*(?:Present|[A-Z][a-z]{2} \d{4})/.exec(parts[0] ?? '')?.[0] ?? null
    const lines = parts.filter(l => l !== parts[0] && !/^(accomplishments|responsibilities):?$/i.test(l) && re.test(l))
    if (lines.length) out.push({ entry: e, period, lines })
  }
  return out
}

// ── The scope guard ─────────────────────────────────────────

/** What a sentence rests on, as the scope guard reads it. */
export interface ScopeRecord {
  kind: 'knowledge' | 'commit' | 'memory' | 'said' | 'aggregate'
  text: string
  footprint?: SubjectFootprint
}

const SPELLED: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 }

/** How often: words of the same family support each other ("every day" and "daily"). */
const FREQUENCY: Array<{ family: string; re: RegExp }> = [
  { family: 'daily', re: /\b(?:daily|every ?day|each day|all day|day[- ]to[- ]day|day in,? day out|every (?:single )?(?:work)?day|all the time|constantly)\b/ },
  { family: 'weekly', re: /\b(?:weekly|every week|each week)\b/ },
  { family: 'regularly', re: /\b(?:regularly|routinely|frequently|often)\b/ },
]

/** "every project", "all of my repos", "most of our client projects". */
const UNIVERSAL = /\b(every|each|all|most|nearly all|almost all)\s+(?:of\s+)?(?:my\s+|our\s+|the\s+|his\s+)?(?:[a-z]+\s+){0,2}?(projects?|repositories|repos|codebases?|apps?|applications?|clients?|builds?|stacks?)\b/g

/** Spelled counts a sentence may give instead of a figure ("fifty projects"). */
const SPELLED_COUNT: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
}

/** "more than 50 projects", "377 commits", "over 20 repositories", "fifty client projects". */
const COUNT = new RegExp(`\\b(?:(more than|over|at least|nearly|almost|about|around|roughly|close to)\\s+)?(\\d[\\d,]*|${Object.keys(SPELLED_COUNT).join('|')})\\+?\\s+(?:(?:different|separate|client|other|of\\s+(?:my|our|his))\\s+)?(projects?|repositories|repos?|codebases?|applications?|apps?|commits?)\\b`, 'g')

/** "dozens of projects", "hundreds of commits": a count without a figure. */
const VAGUE_COUNT = /\b(dozens|scores|hundreds|thousands)\s+of\s+(?:(?:my|our|his|different|client)\s+)?(?:projects?|repositories|repos?|codebases?|applications?|apps?|commits?)\b/g

const SINCE = /\bsince (?:early |late |mid )?((?:19|20)\d{2})\b/g

const YEARS = /\b(?:for |over |more than |nearly |almost |about )*(\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|many)\+?\s+years?\b/g

function frequencyFamilies(text: string): Set<string> {
  return new Set(FREQUENCY.filter(f => f.re.test(text)).map(f => f.family))
}

/** "every project" with its universal word and its noun only, so "every Laravel project" reads as "every project". */
function universalKey(word: string, noun: string): string {
  const w = /^(nearly|almost) all$/.test(word) ? 'most' : word === 'each' ? 'every' : word
  return `${w} ${noun.replace(/(?:ies|s)$/, '').replace(/^repo(?:sitor)?$/, 'repo')}`
}

/**
 * Scope and frequency phrases the sentence uses that its records do not state. Only Devin's own
 * words and his knowledge base state scope; the code's counts across his commits never do, and an
 * aggregate record passed in supports nothing:
 * - a count of projects, repos, apps, or commits ("more than 50 projects", "dozens of projects",
 *   "fifty projects") only when the same figure and noun are in a cited knowledge base entry or his
 *   own words;
 * - "daily", "every day", "every project", "all my projects" only when his own words (or a cited
 *   knowledge base entry) say so;
 * - "since 2022" only when his words say it, or a cited role runs from that year to the present;
 * - "for five years", "8+ years" only when his words or a cited knowledge base entry say it.
 */
export function unsupportedScope(sentence: string, records: ScopeRecord[]): string[] {
  const t = sentence.toLowerCase().replace(/[\u2018\u2019]/g, '\'')
  // Only Devin's own words and his knowledge base can state a frequency, a count, or a universal scope.
  const firm = records.filter(r => r.kind === 'said' || r.kind === 'knowledge').map(r => r.text.toLowerCase().replace(/[\u2018\u2019]/g, '\'')).join('\n')
  const out: string[] = []

  const want = frequencyFamilies(t)
  if (want.size) {
    const have = frequencyFamilies(firm)
    // Daily use covers "regularly" and "weekly"; nothing covers daily but daily.
    for (const fam of want) {
      if (have.has(fam) || (fam !== 'daily' && have.has('daily')) || (fam === 'regularly' && have.has('weekly'))) continue
      out.push(FREQUENCY.find(f => f.family === fam)!.re.exec(t)?.[0] ?? fam)
    }
  }

  const firmUniversals = new Set([...firm.matchAll(new RegExp(UNIVERSAL.source, 'g'))].map(m => universalKey(m[1]!, m[2]!)))
  for (const m of t.matchAll(new RegExp(UNIVERSAL.source, 'g'))) {
    if (!firmUniversals.has(universalKey(m[1]!, m[2]!))) out.push(m[0])
  }

  for (const m of t.matchAll(new RegExp(COUNT.source, 'g'))) {
    const raw = m[2]!
    const n = SPELLED_COUNT[raw] ?? Number(raw.replace(/,/g, ''))
    const noun = m[3]!.replace(/(?:ies|s)$/, '').replace(/^repositor$/, 'repo')
    if (!countStated(firm, n, noun)) out.push(m[0])
  }
  for (const m of t.matchAll(new RegExp(VAGUE_COUNT.source, 'g'))) {
    if (!firm.includes(m[1]!)) out.push(m[0])
  }

  for (const m of t.matchAll(new RegExp(SINCE.source, 'g'))) {
    const year = m[1]!
    const fromRole = new RegExp(`${year}\\s*(?:-|to)\\s*present`).test(firm)
    if (!fromRole && !firm.includes(`since ${year}`)) out.push(m[0])
  }

  for (const m of t.matchAll(new RegExp(YEARS.source, 'g'))) {
    // A plain year count ("2 years"), never "2026 years" or a date.
    const raw = m[1]!
    const n = SPELLED[raw] ?? (Number.isFinite(Number(raw)) ? Number(raw) : null)
    if (n != null && n > 60) continue
    const stated = n != null
      ? new RegExp(`(^|[^0-9])(?:${n}|${Object.entries(SPELLED).find(([, v]) => v === n)?.[0] ?? n})\\+?\\s+years?`).test(firm)
      : firm.includes(`${raw} years`)
    if (!stated) out.push(m[0].trim())
  }
  return [...new Set(out)]
}

/** A count with its noun in his words or his knowledge base: "50 projects", "more than 50 client projects", "fifty projects". */
function countStated(firm: string, n: number, noun: string): boolean {
  const spelled = Object.entries(SPELLED_COUNT).filter(([, v]) => v === n).map(([w]) => w)
  const figures = [String(n), n.toLocaleString('en-US'), ...spelled].map(f => f.replace(/,/g, ',?'))
  return new RegExp(`(^|[^0-9a-z])(?:${figures.join('|')})\\+?\\s+(?:[a-z]+\\s+){0,2}${noun}`).test(firm)
}
