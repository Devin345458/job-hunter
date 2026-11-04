// Checks the counts and the scope guard behind "Draft from my records" (server/utils/records-footprint.ts)
// on a copy of a production snapshot, without calling Claude:
//
//   npx tsx --tsconfig scripts/eval/tsconfig.json scripts/eval/records-footprint.ts <snapshotCopy.db>
//
// Prints the count record and the roles for a few subjects, then runs the word-overlap check and the
// scope guard over fixed sentences and exits 1 when any verdict differs from the expected one.

import { setupGlobals } from './globals'

const [dbPath] = process.argv.slice(2)
if (!dbPath) {
  console.error('usage: records-footprint.ts <snapshotCopy.db>')
  process.exit(2)
}
await setupGlobals({ databasePath: dbPath, anthropicApiKey: '', aiModel: 'none', aiFallbackModel: 'none', dailyAiBudgetUsd: '0', schedulerEnabled: 'false', demoToolPath: '' })
const fp = await import('../../server/utils/records-footprint')
const { loadKnowledge } = await import('../../server/utils/knowledge')

const entries = loadKnowledge()
for (const subject of ['Docker containerization', 'Incident management, logging, monitoring, and observability', 'GitHub', 'Payments and reconciliation']) {
  const anchors = fp.draftAnchors(subject, subject)
  const f = fp.subjectFootprint(subject, anchors)
  console.log(`\n=== ${subject}\n${f ? fp.footprintText(f) : '(no matching commits)'}`)
  for (const r of fp.roleMentions(entries, subject, anchors)) console.log(`role: ${r.entry.key} (${r.period}): ${r.lines.join(' / ')}`)
}

const subject = 'Docker containerization'
const f = fp.subjectFootprint(subject, fp.draftAnchors(subject, subject))
if (!f) {
  console.error('\nNo Docker commits in this snapshot; the scope cases need them.')
  process.exit(1)
}
const roundDown = fp.roundedDown(f.projects)!
const latest = f.perYear[f.perYear.length - 1]!
const A = { kind: 'aggregate' as const, text: fp.footprintText(f), footprint: f }
const S = { kind: 'said' as const, text: 'my experience with docker containers (which is extensive I use them all day every day)' }
const role = { kind: 'knowledge' as const, text: 'Acme - Senior Developer\nOct 2021 - Present | Remote\n- Deployed a self-hosted Sentry instance across 50 projects.' }
const summary = { kind: 'knowledge' as const, text: 'Professional Summary\nSoftware developer with over 8 years of experience.' }
const cases: Array<[string, any[], boolean]> = [
  [`Since ${f.firstYear} I have set up or changed the Docker setup in more than ${roundDown} projects.`, [A], true],
  [`I have changed the Docker setup in more than ${f.projects + 8} projects.`, [A], false],
  [`I have changed the Docker setup in ${f.projects} projects.`, [A], true],
  [`I have changed the Docker setup in ${roundDown} projects.`, [A], false],
  [`I worked on Docker in ${latest.projects} projects in ${latest.year}.`, [A], true],
  [`I worked on Docker in ${latest.projects} projects.`, [A], latest.projects === f.projects],
  ['I use Docker every day.', [A], false],
  ['Yes, every day.', [S], true],
  [`I use Docker daily in more than ${roundDown} projects.`, [S, A], true],
  ['Every Laravel project I work on runs in Docker Compose.', [A, role], false],
  [`Since ${Number(f.firstYear) - 3} I have used Docker.`, [A], false],
  ['Since 2021 I have used Sentry.', [role], true],
  ['I maintained a self-hosted Sentry instance across 50 projects.', [role], true],
  ['I have used Docker for five years.', [A], false],
  ['I have over 8 years of experience.', [summary], true],
  ['I regularly upgrade PHP base images.', [S], true],
  [`I have made more than ${fp.roundedDown(f.commits) ?? 1} commits.`, [A], false],
]
let failed = 0

// The word-overlap check over the union of a sentence's records: a grouped sentence in plain words
// passes when its commits name the tools; an invented one, or plain words with no tool behind them, fails.
const { recordsSupportShare, RECORDS_LIMITS } = await import('../../server/utils/draft-from-records')
const { useDb } = await import('../../server/utils/db')
const commit = (like: string) => {
  const row = useDb().$client.prepare('SELECT repo, message FROM repo_commits WHERE message LIKE ? LIMIT 1').get(`%${like}%`) as { repo: string; message: string } | undefined
  return row ? `${row.repo}\n${row.message}` : ''
}
const docker = [A.text, commit('thecodingmachine v5 image'), commit('local clamd behind the clamav'), commit('Run on PHP 8.5 and add the S3')]
const worktrees = [commit('isolated stack per worktree'), commit('parameterize docker + vite HMR')]
const overlap: Array<[string, string[], boolean]> = [
  ['That work includes writing Dockerfiles and Compose files, upgrading PHP base images, and adding local stand-ins for S3 storage and a virus scanner.', docker, true],
  ['For a reporting and analytics application, I set up isolated environments per branch, each with its own database and hostnames.', worktrees, true],
  ['I designed a Kafka event bus for real-time fraud detection across microservices.', docker, false],
  ['I added local stand-ins for S3 storage and a virus scanner.', [commit('thecodingmachine v5 image')], false],
]
console.log(`\n=== word overlap (passes at ${RECORDS_LIMITS.minSupport})`)
for (const [sentence, recs, ok] of overlap) {
  if (recs.some(r => !r)) {
    console.log(`SKIP a cited commit is not in this snapshot: ${sentence}`)
    continue
  }
  const share = recordsSupportShare(sentence, recs.join('\n'))
  const pass = (share >= RECORDS_LIMITS.minSupport) === ok
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'} expected ${ok ? 'kept' : 'dropped'} (${share.toFixed(2)}): ${sentence}`)
}

console.log('\n=== scope guard (ok = passes the guard)')
for (const [sentence, records, ok] of cases) {
  const found = fp.unsupportedScope(sentence, records)
  const pass = (found.length === 0) === ok
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'} expected ${ok ? 'ok' : 'flag'}${found.length ? ` ${JSON.stringify(found)}` : ''}: ${sentence}`)
}
console.log(`\n${failed ? `${failed} not as expected` : 'all as expected'}`)
process.exit(failed ? 1 : 0)
