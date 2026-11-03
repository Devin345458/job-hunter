// Measures the GitHub evidence keyword search on a copy of a production snapshot (it migrates the
// copy, so never point it at a live database), without diffs (a snapshot carries no repo clones;
// the chat searches without diffs too).
//
//   npx tsx --tsconfig scripts/eval/tsconfig.json scripts/eval/keyword-evidence.ts <snapshotCopy.db> <tag>
//
// Runs searchEvidence() exactly as repos:suggest does (withSignatures over the subject and the
// question) for the ten subjects in keyword-subjects.ts and for every knows or has_done question
// with search terms cached in repo_suggestions (production's repo_terms output). Writes the hit
// lists to data/eval/keyword/<tag>.json (gitignored: commit messages are private) and prints them.
// Compare two tags with keyword-diff.mjs.

import { mkdirSync, writeFileSync } from 'node:fs'
import { setupGlobals } from './globals'
import { SUBJECTS } from './keyword-subjects'

const [dbPath, tag] = process.argv.slice(2)
if (!dbPath || !tag) {
  console.error('usage: keyword-evidence.ts <snapshotCopy.db> <tag>')
  process.exit(2)
}
await setupGlobals({ databasePath: dbPath, anthropicApiKey: '', aiModel: 'none', aiFallbackModel: 'none', dailyAiBudgetUsd: '0', schedulerEnabled: 'false', demoToolPath: '' })
const { useDb } = await import('../../server/utils/db')
const search = await import('../../server/utils/repos/search')

const sqlite = useDb().$client
const commits = new Map((sqlite.prepare('SELECT repo, sha, message, paths_json AS pathsJson FROM repo_commits').all() as Array<{ repo: string; sha: string; message: string; pathsJson: string | null }>).map(c => [`${c.repo}@${c.sha}`, c] as const))

interface Case { id: string; subject: string; question: string; terms: { code: string[]; paths: string[]; packages: string[] }; searchable: boolean }
const cases: Case[] = SUBJECTS.map((s, i) => ({ id: `S${i + 1}`, subject: s.subject, question: s.question, terms: s.terms, searchable: true }))
const rows = sqlite.prepare(`SELECT q.id, q.status, q.subject, q.question, s.terms_json AS termsJson FROM questions q JOIN repo_suggestions s ON s.question_id = q.id
  WHERE q.kind IN ('knows', 'has_done') AND s.terms_json IS NOT NULL ORDER BY q.id`).all() as Array<{ id: number; status: string; subject: string | null; question: string; termsJson: string }>
for (const r of rows) {
  const t = JSON.parse(r.termsJson) as { searchable: boolean; terms: Case['terms'] }
  cases.push({ id: `Q${r.id}`, subject: (r.subject ?? r.question).trim(), question: r.question, terms: t.terms, searchable: t.searchable })
}

const out: any[] = []
for (const c of cases) {
  const text = `${c.subject}\n${c.question}`
  const terms = search.withSignatures(c.searchable ? c.terms : { code: [], paths: [], packages: [] }, text)
  if (!terms.code.length && !terms.paths.length && !terms.packages.length) {
    out.push({ ...c, hits: [], skipped: 'no terms' })
    continue
  }
  // As repos:suggest calls it. Code from before the anchor rule (main at 12e7613) ignores anchors.
  const found = await search.searchEvidence(terms, () => {}, { diffs: false, anchors: { subject: c.subject, text } })
  const hits = found.hits.map((h: any) => {
    const m = commits.get(`${h.repo}@${h.sha}`)
    return { key: `${h.repo}@${h.sha}`, repo: h.repo, date: h.date, reasons: h.reasons, subject: h.subject, paths: h.paths, files: (JSON.parse(m?.pathsJson ?? '[]') as string[]).slice(0, 6), message: (m?.message ?? '').replace(/\s+/g, ' ').slice(0, 300) }
  })
  out.push({ id: c.id, subject: c.subject, question: c.question, terms, anchors: (found as any).anchors ?? null, hits, pathSummaries: found.pathSummaries.length, dependencies: found.dependencies.length })
  console.log(`\n=== ${c.id} "${c.subject}": ${hits.length} hits`)
  for (const h of hits) console.log(`  ${h.reasons.join('+')} ${h.repo} ${h.date} | ${h.subject.slice(0, 110)} | ${(h.paths.length ? h.paths : h.files).slice(0, 3).join(' ')}`)
}
mkdirSync('data/eval/keyword', { recursive: true })
writeFileSync(`data/eval/keyword/${tag}.json`, JSON.stringify(out, null, 2))
console.log(`\nwrote data/eval/keyword/${tag}.json: ${out.length} cases, ${out.reduce((n, c) => n + c.hits.length, 0)} hits`)
