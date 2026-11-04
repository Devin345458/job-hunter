import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { repoCommits, repoSources } from '../db/schema'
import type { KnowledgeEntry } from './knowledge'
import { anchorPattern, cleanTerms, messageBody, pathMatches, subjectAnchors, subjectParts, withSignatures, type TermSet } from './repos/search'
import { isAppRepo } from './repos/settings'

// What a records draft says about scale: how much of Devin's own work touches a subject, counted by
// code over every one of his indexed commits (not the few the chat search shows), and which roles in
// his knowledge base name it. A draft states scope ("in more than 50 projects since 2022") only from
// these counts or from his own words, and checkScope() below holds every sentence to that.

export const FOOTPRINT_LIMITS = {
  /** Commits added to the draft's records beside the chat search's, one per project, busiest projects first. */
  sampleCommits: 8,
  /** Matched file names and message words the aggregate names. */
  topFiles: 4,
  topWords: 4,
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
}

/**
 * The anchors the chat search uses for this draft (githubChatSearch, then searchEvidence): Claude's
 * terms with the signatures added, bounded, then cut to what can make a commit a hit. Built from the
 * same inputs so the counts and the commits cited beside them come from one rule.
 */
export function draftAnchors(planTerms: TermSet, subject: string | null, context: string, signatureText: string): TermSet {
  const terms = cleanTerms(withSignatures(cleanTerms(planTerms, 20), signatureText), 80, false)
  return subjectAnchors(terms, subject, context, signatureText)
}

/** A count rounded down to a figure a person would say: 52 to 50, 377 to 350, 1,240 to 1,200. */
export function roundedDown(n: number): number | null {
  const step = n >= 1000 ? 100 : n >= 100 ? 50 : n >= 30 ? 10 : 5
  let r = Math.floor(n / step) * step
  if (r === n) r -= step
  return r >= 10 ? r : null
}

/**
 * Counts Devin's own commits in switched-on, indexed repos (this app's repo left out) that match the
 * anchors the way the chat search does: a message (trailers left out) naming an anchor word, or a
 * changed path matching an anchor path. Null when none match.
 */
export function subjectFootprint(subject: string, anchors: TermSet): SubjectFootprint | null {
  const words = [...anchors.code, ...anchors.packages]
  const wordRe = words.length ? new RegExp(words.map(anchorPattern).join('|'), 'i') : null
  if (!wordRe && !anchors.paths.length) return null
  const db = useDb()
  const repos = db.select({ fullName: repoSources.fullName }).from(repoSources)
    .where(and(eq(repoSources.included, true), isNotNull(repoSources.indexedAt))).all()
    .map(r => r.fullName).filter(n => !isAppRepo(n))
  if (!repos.length) return null
  const rows = db.select({ repo: repoCommits.repo, url: repoCommits.url, authoredAt: repoCommits.authoredAt, message: repoCommits.message, pathsJson: repoCommits.pathsJson })
    .from(repoCommits).where(inArray(repoCommits.repo, repos)).all()

  let commits = 0
  const byRepo = new Map<string, number>()
  const years = new Map<string, { projects: Set<string>; commits: number }>()
  const files = new Map<string, { name: string; commits: number; folders: Map<string, number> }>()
  const matchedWords = new Map<string, number>()
  // The most telling commit per project: one whose message names the subject, else a small change.
  const best = new Map<string, { score: number; url: string; title: string; date: string }>()
  for (const r of rows) {
    const body = messageBody(r.message)
    const wordHit = wordRe ? wordRe.exec(body) : null
    let paths: string[] = []
    try {
      paths = JSON.parse(r.pathsJson ?? '[]')
    }
    catch {}
    const pathHits = anchors.paths.length ? paths.filter(p => pathMatches(p, anchors.paths)) : []
    if (!wordHit && !pathHits.length) continue
    commits++
    byRepo.set(r.repo, (byRepo.get(r.repo) ?? 0) + 1)
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
    const title = body.split('\n')[0]!.trim()
    if (/^merge\b/i.test(title) || title.length < 12) continue
    // A message that names the subject says what the work was. A commit matched by its files only
    // speaks for the subject when those files are most of what it changed; a docs commit records
    // writing, not building.
    const pathShare = paths.length ? pathHits.length / paths.length : 0
    if (!wordHit && pathShare < 0.5 && paths.length > 3) continue
    // The title naming it beats a long body that mentions it once.
    const inTitle = !!wordRe && wordRe.test(title)
    const score = (inTitle ? 100 : pathShare >= 0.5 ? 60 : wordHit ? 40 : 20)
      + Math.min(title.length, 80) / 8
      - (/^(?:\[[^\]]*\]\s*)?docs(?:\([^)]*\))?!?:/i.test(title) ? 60 : 0)
    const prev = best.get(r.repo)
    if (!prev || score > prev.score) best.set(r.repo, { score, url: r.url, title: title.slice(0, 200), date: r.authoredAt.slice(0, 10) })
  }
  if (!commits) return null
  const perYear = [...years.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([year, v]) => ({ year, projects: v.projects.size, commits: v.commits }))
  const busiest = [...byRepo.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([repo]) => repo)
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
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

function withRounded(n: number, one: string, many: string): string {
  const r = roundedDown(n)
  return r ? `${plural(n, one, many)} (more than ${r.toLocaleString('en-US')})` : plural(n, one, many)
}

/**
 * The aggregate as the draft reads it. Every figure a sentence may use is written out, the rounded
 * forms included, so the number checks pass only for figures the counts state.
 */
export function footprintText(f: SubjectFootprint): string {
  const span = f.firstYear === f.lastYear ? `in ${f.firstYear}` : `from ${f.firstYear} to ${f.lastYear}`
  const latest = f.perYear[f.perYear.length - 1]!
  const lines = [
    `Projects where Devin's own commits (work he wrote or changed) match ${f.subject}: ${withRounded(f.projects, 'project', 'projects')}, ${span}${f.perYear.length > 1 ? `, ${latest.projects} of them in ${latest.year}` : ''}.`,
    f.perYear.length > 1 ? `Projects per year: ${f.perYear.map(y => `${y.year}: ${y.projects}`).join(', ')}.` : null,
    `Commits in all: ${f.commits.toLocaleString('en-US')}.`,
    f.files.length ? `Files these commits change most: ${f.files.map(x => `${x.name} (${plural(x.commits, 'commit', 'commits')}${x.folder ? `, mostly in ${x.folder}` : ''})`).join(', ')}.` : null,
    f.words.length ? `Words their messages use most: ${f.words.map(x => `${x.word} (${plural(x.commits, 'commit', 'commits')})`).join(', ')}.` : null,
  ]
  return lines.filter(Boolean).join(' ')
}

/** The one line the sources list shows under a sentence that cites the aggregate. */
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

/** "more than 50 projects", "377 commits", "over 20 repositories". */
const COUNT = /\b(?:(more than|over|at least|nearly|almost|about|around|roughly|close to)\s+)?(\d[\d,]*)\+?\s+(?:(?:different|separate|client|other|of\s+(?:my|our|his))\s+)?(projects?|repositories|repos|codebases?|applications?|apps|commits?)\b/g

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
 * Scope and frequency phrases the sentence uses that its records do not state:
 * - a count of projects only against an aggregate's counts (rounded down, never up), a per-year
 *   count with its year named, or the same figure and noun in a cited knowledge base entry or
 *   Devin's own words; a count of commits only from those last two (a draft describes work, not commits);
 * - "daily", "every day", "every project", "all my projects" only when his own words (or a cited
 *   knowledge base entry) say so;
 * - "since 2022" only when an aggregate starts that year or earlier, his words say it, or a cited
 *   role runs from that year to the present;
 * - "for five years", "8+ years" only when his words or a cited knowledge base entry say it.
 */
export function unsupportedScope(sentence: string, records: ScopeRecord[]): string[] {
  const t = sentence.toLowerCase().replace(/[‘’]/g, '\'')
  const prints = records.filter(r => r.kind === 'aggregate' && r.footprint).map(r => r.footprint!)
  // Only Devin's own words and his knowledge base can state a frequency or a universal scope.
  const firm = records.filter(r => r.kind === 'said' || r.kind === 'knowledge').map(r => r.text.toLowerCase().replace(/[‘’]/g, '\'')).join('\n')
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
    const qualifier = m[1] ?? ''
    const n = Number(m[2]!.replace(/,/g, ''))
    const commitsNoun = /^commit/.test(m[3]!)
    // A draft talks about projects, not commits: a commit count stands only where his words or his
    // knowledge base state it.
    const fits = !commitsNoun && prints.some((f) => {
      const total = f.projects
      if (qualifier === 'more than' || qualifier === 'over') return n < total
      if (qualifier === 'at least') return n <= total
      if (qualifier) return n <= total && n >= total * 0.9
      if (n === total) return true
      // "30 projects in 2026": a year's own count, with that year in the sentence.
      return f.perYear.some(y => y.projects === n && t.includes(y.year))
    })
    const stated = new RegExp(`(^|[^0-9])${m[2]!.replace(/,/g, ',?')}\\+?\\s+(?:[a-z]+\\s+)?${m[3]!.replace(/s$/, '')}`).test(firm)
    if (!fits && !stated) out.push(m[0])
  }

  for (const m of t.matchAll(new RegExp(SINCE.source, 'g'))) {
    const year = m[1]!
    const fromPrint = prints.some(f => year >= f.firstYear && year <= f.lastYear)
    const fromRole = new RegExp(`${year}\\s*(?:-|to)\\s*present`).test(firm)
    if (!fromPrint && !fromRole && !firm.includes(`since ${year}`)) out.push(m[0])
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
