import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { questions, repoCommits, repoSources, repoSuggestions } from '../../db/schema'
import type { RepoEvidence } from '#shared/types/repos'
import { AiBudgetExceeded, aiStructured, fallbackModel } from '../ai'
import { scrubDashes, unsupportedNumbers } from '../apply/text'
import { SEARCH_RULES, cleanTerms, searchEvidence, withSignatures, type CommitHit, type SearchResult, type TermSet } from './search'
import { parseEvidence } from './suggest-store'

// repos:suggest. For each pending knows or has_done question: one cheap Claude call turns the
// subject into search terms (cached per subject), the search runs over Devin's own commits, and
// when there are hits one Claude call judges them. The result is a suggestion only: a level
// (Yes or Some experience, never No), a draft for the "Where did you do it?" box that cites only
// what the commits show, and the commits it rests on. Devin confirms with one tap and Save.
// No hits stores status none, which shows nothing: finding nothing is never a No.

const DRAFT_MAX = 600

const TermsSchema = z.object({
  searchable: z.boolean().describe('False when commits cannot show this: soft skills, talks, events, people management, or anything outside code.'),
  code: z.array(z.string()).describe('Up to 10 specific identifiers, API names, or words that would appear in his code, diffs, or commit messages. At least 3 characters each. Never generic words like auth, api, data, test, config, user.'),
  paths: z.array(z.string()).describe('Up to 6 file extensions with a leading dot (".cs"), file names ("schema.graphql", "shopify.app.toml"), or folder names ("graphql/", "/scim/") that only this subject would produce. Empty when none are specific.'),
  packages: z.array(z.string()).describe('Up to 8 package names a project using this would declare (npm, composer, pip, go, gem, cargo, nuget), exactly as published, e.g. "@simplewebauthn/server".'),
})

const JudgeSchema = z.object({
  level: z.enum(['Yes', 'Some experience', 'None']),
  reason: z.string().describe('One short sentence on why, for the log.'),
  draft: z.string().describe('First person as Devin, one to three plain sentences, empty when level is None.'),
  evidence: z.array(z.object({
    sha: z.string().describe('A sha from the list, as given.'),
    line: z.string().describe('One plain line under 120 characters on what this commit shows.'),
  })).describe('One to five commits from the list that best show it. Empty when level is None.'),
})

type QuestionRow = typeof questions.$inferSelect

/** Extensions every web project has. As a path term they match nearly every commit, so they stay only when the subject names the language. */
const COMMON_EXT: Record<string, string[]> = {
  '.ts': ['typescript'],
  '.tsx': ['typescript', 'react', 'tsx'],
  '.js': ['javascript', 'node', 'js'],
  '.jsx': ['javascript', 'react', 'jsx'],
  '.mjs': ['javascript', 'node'],
  '.vue': ['vue'],
  '.py': ['python'],
  '.php': ['php', 'laravel'],
  '.rb': ['ruby', 'rails'],
  '.go': ['go', 'golang'],
  '.java': ['java'],
  '.html': ['html'],
  '.css': ['css'],
  '.scss': ['sass', 'scss', 'css'],
  '.json': ['json'],
  '.md': ['markdown', 'documentation', 'writing'],
  '.yml': ['yaml'],
  '.yaml': ['yaml'],
}

/** Drops path terms like ".ts" for a subject that is not TypeScript. */
export function specificPaths(paths: string[], subject: string): string[] {
  const s = subject.toLowerCase()
  return paths.filter((p) => {
    const langs = COMMON_EXT[p.toLowerCase()]
    return !langs || langs.some(l => new RegExp(`(^|[^a-z0-9])${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(s))
  })
}

function termsPrompt(q: QuestionRow) {
  return `Devin is a software developer. A job application asks him this ${q.kind === 'knows' ? 'skill' : 'experience'} question:
"${q.question}"
Subject: ${q.subject ?? q.question}

The app will search his own git commits (messages, changed file paths, diff lines) and the package manifests of his repos for evidence. Give the search terms that would find work on exactly this subject.
- Prefer distinctive terms: library and package names, API names, protocol names, class or function names, config keys, URL paths. For passkeys: webauthn, navigator.credentials, publicKeyCredential, @simplewebauthn/server, FIDO2, passkey. For SCIM: scim, /scim/v2, ServiceProviderConfig, urn:ietf:params:scim.
- A programming language is best found by file extension (paths) and its package manager, not by its name.
- Changed file paths count even when the commit message never names the subject: give the file names and folders only this subject creates (GraphQL: .graphql, schema.graphql, graphql/; a Shopify app: shopify.app.toml, .liquid).
- Leave out words that would match unrelated code.
- searchable is false, with empty lists, when commits cannot show it (communication, demos at events, writing for people, management).`
}

function judgeSystem() {
  return `You review Devin's own GitHub commits for evidence that answers a skill or experience question on a job application. Every commit listed was authored by Devin (checked against his author emails and logins). Code by anyone else was left out. Your result is only a suggestion with links. Devin reads the commits and confirms or changes it.

Rules:
- level Yes: the commits show he built or used the subject itself, in real code or configuration, more than in passing.
- level Some experience: the commits show light or partial use: a small change, one use, an experiment, setup without much use.
- level None: the matches are coincidence (the word in a comment, an unrelated identifier, a dependency bump with no use), or they do not show the subject. None never means he lacks it. It only means these commits do not show it.
- When the question asks about production and the commits do not show the work shipped or ran for users, the level is at most Some experience.
- A dependency in a manifest is context only. Evidence is always one of the listed commits.
- evidence: one to five listed commits that best show it, by sha, each with one plain factual line about what that commit did ("Added WebAuthn registration and login endpoints"). Never cite a sha that is not listed.
- Prefer commits that changed code or configuration. A commit that only edited notes, docs, or a task list is weaker. Cite it only when nothing better shows the point.
- draft: the example only, for a box under the question that asks "Where did you do it?". The level is picked separately, so never start with Yes, No, or the level. First person as Devin, one to three plain sentences, under ${DRAFT_MAX} characters. Say which repo, what he built or did, and when (month and year from the commit dates). Use only what the commits show. Never add an employer, client, user count, metric, team, or result the commits do not show. No dashes. Empty when level is None.`
}

/** The search rules version a stored result was made under; 1 before versions were recorded. */
export function rulesOf(termsJson: string | null | undefined): number {
  try {
    const n = Number(JSON.parse(termsJson ?? '{}')?.rules)
    return Number.isInteger(n) && n > 0 ? n : 1
  }
  catch {
    return 1
  }
}

function shortSha(sha: string) {
  return sha.slice(0, 12)
}

function judgePrompt(q: QuestionRow, terms: TermSet, found: SearchResult): string {
  const lines: string[] = []
  lines.push(`Question: "${q.question}"`)
  lines.push(`Subject: ${q.subject ?? ''}`)
  lines.push(`Searched for: ${[...terms.code, ...terms.packages, ...terms.paths].join(', ')}`)
  const repos = [...new Set(found.hits.map(h => h.repo))]
  lines.push(`\nRepos with matching commits: ${repos.join(', ')}`)
  if (found.languages.length) lines.push(`Repo languages that match: ${found.languages.map(l => `${l.repo} (${l.name})`).join(', ')}`)
  if (found.dependencies.length) {
    lines.push(`Dependencies declared at the default branch that match: ${found.dependencies.slice(0, 20).map(d => `${d.repo}: ${d.name} in ${d.manifest}`).join('; ')}`)
  }
  for (const s of found.pathSummaries) {
    lines.push(`${s.repo}: ${s.commits} of his commits change files matching ${terms.paths.join(', ')}, from ${s.first} to ${s.last}`)
  }
  lines.push('\nHis commits:')
  for (const h of found.hits) {
    lines.push(`- sha ${shortSha(h.sha)} | ${h.repo} | ${h.date} | ${h.subject}`)
    lines.push(`  matched in: ${h.reasons.join(', ')}${h.paths.length ? ` | files: ${h.paths.join(', ')}` : ''}`)
    if (h.excerpt) lines.push(h.excerpt.split('\n').map(l => `    ${l}`).join('\n'))
  }
  return lines.join('\n')
}

/** Every fact the judge saw, for checking the draft's numbers against. */
function sourceText(found: SearchResult) {
  return [
    ...found.hits.map(h => `${h.repo} ${h.date} ${h.subject} ${h.paths.join(' ')} ${h.excerpt}`),
    ...found.pathSummaries.map(s => `${s.repo} ${s.commits} ${s.first} ${s.last}`),
    ...found.dependencies.map(d => `${d.repo} ${d.name} ${d.manifest}`),
  ].join('\n')
}

function nowText() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

function upsert(questionId: number, values: Partial<typeof repoSuggestions.$inferInsert> & { status: string }) {
  const at = nowText()
  useDb().insert(repoSuggestions).values({ questionId, ...values, createdAt: at, updatedAt: at })
    .onConflictDoUpdate({ target: repoSuggestions.questionId, set: { ...values, updatedAt: at } }).run()
}

export interface SuggestRunStats extends Record<string, unknown> {
  questions: number
  suggested: number
  none: number
  unchanged: number
  notSearchable: number
  failed: number
  aiCalls: number
  budgetStop?: boolean
  errors: string[]
  results: Array<{ questionId: number; subject: string | null; outcome: string; hits?: number; level?: string }>
  note?: string
}

/** Suggest for every pending knows or has_done question, or only questionIds when given. */
export async function runRepoSuggest(opts: { questionIds?: number[]; force?: boolean }, log: (m: string) => void): Promise<SuggestRunStats> {
  const stats: SuggestRunStats = { questions: 0, suggested: 0, none: 0, unchanged: 0, notSearchable: 0, failed: 0, aiCalls: 0, errors: [], results: [] }
  const db = useDb()
  const indexedRepos = db.select({ n: sql<number>`count(*)` }).from(repoSources).where(and(eq(repoSources.included, true), isNotNull(repoSources.indexedAt))).get()?.n ?? 0
  const indexedCommits = db.select({ n: sql<number>`count(*)` }).from(repoCommits).get()?.n ?? 0
  if (!indexedRepos || !indexedCommits) {
    stats.note = 'No repo is indexed yet, so there is nothing to search. Run repos:index first.'
    return stats
  }
  let rows = db.select().from(questions).where(and(
    eq(questions.status, 'pending'),
    inArray(questions.kind, ['knows', 'has_done']),
    eq(questions.answerType, 'yes_no'),
  )).all()
  if (opts.questionIds?.length) rows = rows.filter(q => opts.questionIds!.includes(q.id))
  stats.questions = rows.length
  const existing = new Map(db.select().from(repoSuggestions).where(inArray(repoSuggestions.questionId, rows.length ? rows.map(q => q.id) : [-1])).all().map(r => [r.questionId, r] as const))
  // Terms are cached per subject, so the same subject on two questions costs one call.
  const termsBySubject = new Map<string, { searchable: boolean; terms: TermSet }>()
  for (const r of existing.values()) {
    if (r.subject && r.termsJson) {
      try {
        termsBySubject.set(r.subject.toLowerCase(), JSON.parse(r.termsJson))
      }
      catch {}
    }
  }

  for (const q of rows) {
    const subject = (q.subject ?? q.question).trim()
    const prev = existing.get(q.id)
    try {
      let t = termsBySubject.get(subject.toLowerCase())
      if (!t || opts.force) {
        const out = await aiStructured(TermsSchema, {
          purpose: 'repo_terms',
          model: fallbackModel(),
          prompt: termsPrompt(q),
          maxTokens: 800,
          effort: 'low',
          ref: { type: 'question', id: q.id },
        })
        stats.aiCalls++
        t = { searchable: out.searchable, terms: cleanTerms({ code: out.code, paths: specificPaths(out.paths, subject), packages: out.packages }) }
        termsBySubject.set(subject.toLowerCase(), t)
      }
      // The rules version rides along in terms_json, so a hit set found under newer rules is judged again.
      const termsJson = JSON.stringify({ searchable: t.searchable, terms: t.terms, rules: SEARCH_RULES })
      // Files, folders, and packages only this subject produces (schema.graphql, shopify.app.toml)
      // are searched whatever Claude gave, so path evidence never depends on it naming them.
      // Signatures follow the subject alone: words in the question text name other technologies too.
      const searchTerms = withSignatures(t.searchable ? t.terms : { code: [], paths: [], packages: [] }, subject)
      const empty = !searchTerms.code.length && !searchTerms.paths.length && !searchTerms.packages.length
      if (empty) {
        upsert(q.id, { status: 'none', subject, termsJson, level: null, draft: null, evidenceJson: null, commitShasJson: '[]', error: null })
        stats.notSearchable++
        stats.results.push({ questionId: q.id, subject, outcome: 'not searchable in code' })
        continue
      }
      // Only the subject's own words, named terms, and signatures make a hit (subjectAnchors).
      const found = await searchEvidence(searchTerms, log, { anchors: { subject, text: `${subject}\n${q.question}` } })
      stats.errors.push(...found.errors)
      const hitShas = found.hits.map(h => h.sha).sort()
      if (!hitShas.length) {
        upsert(q.id, { status: 'none', subject, termsJson, level: null, draft: null, evidenceJson: null, commitShasJson: '[]', error: null })
        stats.none++
        stats.results.push({ questionId: q.id, subject, outcome: 'no matching commits', hits: 0 })
        continue
      }
      // Keep a standing suggestion while every commit it cites is still found. Judge again otherwise.
      // A result from older search rules stands only while the hit set is exactly the same: the old
      // rules let generic words in, so a changed set is judged again even when its citations survive.
      if (!opts.force && prev && prev.subject === subject) {
        const cited = parseEvidence(prev.evidenceJson).map(e => e.sha)
        const sameSet = JSON.stringify(hitShas) === (prev.commitShasJson ?? '')
        const sameRules = rulesOf(prev.termsJson) === SEARCH_RULES
        const keep = sameRules
          ? (prev.status === 'suggested' && cited.length && cited.every(s => hitShas.includes(s))) || (prev.status === 'none' && sameSet)
          : (prev.status === 'suggested' || prev.status === 'none') && sameSet
        if (keep) {
          if (!sameRules) db.update(repoSuggestions).set({ termsJson }).where(eq(repoSuggestions.questionId, q.id)).run()
          stats.unchanged++
          stats.results.push({ questionId: q.id, subject, outcome: 'unchanged', hits: hitShas.length })
          continue
        }
      }
      const verdict = await aiStructured(JudgeSchema, {
        purpose: 'repo_judge',
        system: judgeSystem(),
        prompt: judgePrompt(q, searchTerms, found),
        maxTokens: 1500,
        effort: 'low',
        ref: { type: 'question', id: q.id },
      })
      stats.aiCalls++
      const byPrefix = (sha: string): CommitHit | undefined => {
        const s = sha.trim().toLowerCase()
        return s.length >= 7 ? found.hits.find(h => h.sha.startsWith(s)) : undefined
      }
      const evidence: RepoEvidence[] = []
      for (const e of verdict.evidence) {
        const h = byPrefix(e.sha)
        if (!h || evidence.some(x => x.sha === h.sha)) continue
        const line = scrubDashes(e.line.trim()).slice(0, 160) || h.subject
        evidence.push({ repo: h.repo, sha: h.sha, url: h.url, date: h.date, line })
        if (evidence.length >= 5) break
      }
      const draft = scrubDashes(verdict.draft.trim()).slice(0, DRAFT_MAX)
      const invented = unsupportedNumbers(draft, sourceText(found))
      if (verdict.level === 'None' || !evidence.length || !draft || invented.length) {
        const why = invented.length ? `draft named numbers the commits do not show: ${invented.join(', ')}` : verdict.reason
        upsert(q.id, { status: 'none', subject, termsJson, level: null, draft: null, evidenceJson: null, commitShasJson: JSON.stringify(hitShas), error: invented.length ? why : null })
        stats.none++
        stats.results.push({ questionId: q.id, subject, outcome: `judged no evidence (${why.slice(0, 120)})`, hits: hitShas.length })
        log(`question ${q.id} (${subject}): ${hitShas.length} hits, no suggestion: ${why}`)
        continue
      }
      upsert(q.id, { status: 'suggested', subject, termsJson, level: verdict.level, draft, evidenceJson: JSON.stringify(evidence), commitShasJson: JSON.stringify(hitShas), error: null })
      stats.suggested++
      stats.results.push({ questionId: q.id, subject, outcome: 'suggested', hits: hitShas.length, level: verdict.level })
      log(`question ${q.id} (${subject}): ${verdict.level} from ${evidence.length} commits`)
    }
    catch (e: any) {
      if (e instanceof AiBudgetExceeded) {
        stats.budgetStop = true
        log(`stopped: ${e.message}`)
        break
      }
      const msg = String(e?.message ?? e).slice(0, 300)
      // A failed rerun keeps a standing suggestion. Only the error is noted.
      upsert(q.id, prev?.status === 'suggested' ? { status: 'suggested', error: msg } : { status: 'error', subject, error: msg })
      stats.failed++
      stats.errors.push(`question ${q.id}: ${msg}`)
      stats.results.push({ questionId: q.id, subject, outcome: 'failed' })
    }
  }
  return stats
}
