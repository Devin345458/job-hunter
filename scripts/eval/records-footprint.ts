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
// Counts across his commits are a script's: they pick the stories and never support a claim
// (Devin, 2026-11-05). A count, a "since", or a frequency stands only on his words or his knowledge base.
const kbDocker = { kind: 'knowledge' as const, text: 'Docker\nSince 2022 I have written or changed the Docker setup in more than 50 projects.' }
const dailyCommit = { kind: 'commit' as const, text: 'Stop runs cleanly when Claude is out of credit\nA credit error stops the run the way the daily budget does.' }
const capCommit = { kind: 'commit' as const, text: 'Subscription limit: this app\'s own daily and 7-day cap on Claude subscription use' }
const cases: Array<[string, any[], boolean]> = [
  [`Since ${f.firstYear} I have set up or changed the Docker setup in more than ${roundDown} projects.`, [A], false],
  [`I have changed the Docker setup in more than ${f.projects + 8} projects.`, [A], false],
  [`I have changed the Docker setup in ${f.projects} projects.`, [A], false],
  [`I have changed the Docker setup in ${roundDown} projects.`, [A], false],
  [`I worked on Docker in ${latest.projects} projects in ${latest.year}.`, [A], false],
  [`I worked on Docker in ${latest.projects} projects.`, [A], false],
  ['I have worked on Docker in dozens of projects.', [A], false],
  ['I have changed the Docker setup in fifty projects.', [A], false],
  ['I have changed the Docker setup in more than 50 projects.', [kbDocker], true],
  ['I have changed the Docker setup in fifty projects.', [kbDocker], true],
  ['Since 2022 I have changed the Docker setup in more than 50 projects.', [kbDocker], true],
  ['I have changed the Docker setup in more than 60 projects.', [kbDocker], false],
  ['I use Docker every day.', [A], false],
  ['Yes, every day.', [S], true],
  [`I use Docker daily in more than ${roundDown} projects.`, [S, A], false],
  ['I use Docker daily.', [S, A], true],
  ['Every Laravel project I work on runs in Docker Compose.', [A, role], false],
  [`Since ${Number(f.firstYear) - 3} I have used Docker.`, [A], false],
  [`Since ${f.firstYear} I have used Docker.`, [A], false],
  ['Since 2021 I have used Sentry.', [role], true],
  ['I maintained a self-hosted Sentry instance across 50 projects.', [role], true],
  ['I have used Docker for five years.', [A], false],
  ['I have over 8 years of experience.', [summary], true],
  ['I regularly upgrade PHP base images.', [S], true],
  [`I have made more than ${fp.roundedDown(f.commits) ?? 1} commits.`, [A], false],
  // A system's daily budget is a feature, not how often he works, when the cited commit says it too.
  ['Its background Claude steps stop cleanly at a daily budget or when credit runs out.', [dailyCommit], true],
  ['A daily and 7-day cap on subscription use puts stopped items back in the queue for later.', [capCommit], true],
  ['Its background Claude steps stop cleanly at a daily budget.', [A], false],
  ['I use Docker daily.', [dailyCommit], false],
  ['I check the daily reports every day.', [dailyCommit], false],
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
const docker = [commit('thecodingmachine v5 image'), commit('local clamd behind the clamav'), commit('Run on PHP 8.5 and add the S3')]
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
// Candidate stories: the subject's busiest projects, each with commits whose whole messages the draft reads.
console.log('\n=== candidate stories (Accessibility)')
const a11y = fp.subjectFootprint('Accessibility', fp.draftAnchors('Accessibility', 'Have you used Accessibility in a real project?'))
for (const st of a11y?.stories ?? []) console.log(`${st.repo}: ${st.commits} commits, ${st.picks.length} read whole (${st.picks.map(p => p.title.slice(0, 50)).join(' | ')})`)
const storiesOk = !!a11y && a11y.stories.length > 0 && a11y.stories.every(st => st.picks.length > 0)
if (!storiesOk) failed++
console.log(`${storiesOk ? 'PASS' : 'FAIL'} every candidate story has commits to read`)

// The records budget: whole, then shortened, then left out, in budgetRank order; ids numbered again.
const { fitRecordBudget } = await import('../../server/utils/draft-from-records')
const big = 'x'.repeat(4000)
const fitted = fitRecordBudget([
  { id: 'S1', kind: 'said', text: 'I ran the audit.' },
  { id: 'C1', kind: 'commit', text: big, short: 'short one', story: 1 },
  { id: 'C2', kind: 'commit', text: big, short: 'short two', story: 1 },
  { id: 'C3', kind: 'commit', text: 'other commit', story: null },
  { id: 'M1', kind: 'memory', text: big, short: 'excerpt', full: true },
], 1100)
const budgetOk = fitted.records.map(r => `${r.id}:${r.text.length}`).join(' ') === 'S1:16 C1:4000 C2:9 C3:12 M1:7' && fitted.cut.join(', ') === '2 shortened'
if (!budgetOk) failed++
console.log(`\n=== records budget\n${budgetOk ? 'PASS' : 'FAIL'} ${fitted.records.map(r => `${r.id}:${r.text.length}`).join(' ')} (cut: ${fitted.cut.join(', ')}, ${fitted.tokens} tokens)`)

// GitHub code search: every query, the longest search word plus its repo: qualifiers, stays under
// GitHub's 1,024 characters (CHAT_SEARCH_LIMITS.maxQueryChars), over this snapshot's switched-on repos.
const { repoBatches, CHAT_SEARCH_LIMITS } = await import('../../server/utils/repos/chat-search')
const names = (useDb().$client.prepare('SELECT full_name FROM repo_sources WHERE included = 1 ORDER BY commit_count DESC').all() as Array<{ full_name: string }>).map(r => r.full_name)
const word = '"@axe-core/playwright"'
const queries = repoBatches(names, CHAT_SEARCH_LIMITS.maxQueryChars - word.length - 1).map(b => `${word} ${b.map(n => `repo:${n}`).join(' ')}`)
const longest = Math.max(...queries.map(q => q.length))
const covered = new Set(queries.flatMap(q => q.split(' ').filter(t => t.startsWith('repo:')))).size
const queryOk = longest <= 1024 && covered === names.length
if (!queryOk) failed++
console.log(`\n=== code search query length\n${queryOk ? 'PASS' : 'FAIL'} ${names.length} repos in ${queries.length} queries, longest ${longest} characters (GitHub refuses over 1,024)`)

// Answer depth (Devin, 2026-11-05): a core catalog skill gets the full answer in paragraphs, every
// other skill 2 or 3 sentences; repos:suggest drops any sentence that states a script's count.
const dr = await import('../../server/utils/draft-from-records')
const sg = await import('../../server/utils/repos/suggest')
const { answerDepthFor } = await import('../../server/utils/skill-catalog')
const qc = await import('../../server/utils/question-chat')
const qRow = (id: number) => useDb().$client.prepare('SELECT id, kind, subject FROM questions WHERE id = ?').get(id) as any
const s4 = 'Yes, I built it. I designed the parts. I measured it. I moved the work.'
const depthCases: Array<[string, boolean]> = [
  ['a core draft keeps its paragraphs', dr.joinDraft([{ text: 'A.', paragraph: 1 }, { text: 'B.', paragraph: 1 }, { text: 'C.', paragraph: 2 }, { text: 'D.' }, { text: 'E.', paragraph: 1 }], 'core') === 'A. B.\n\nC. D. E.'],
  ['a short draft is one paragraph', dr.joinDraft([{ text: 'A.', paragraph: 1 }, { text: 'B.', paragraph: 3 }], 'short') === 'A. B.'],
  ['four sentences fail the short limit', dr.codeHardFails(s4, 600, 'short').some(f => f.startsWith('More than 3 sentences'))],
  ['four sentences pass the core limit', !dr.codeHardFails(s4, 1300, 'core').length],
  ['five paragraphs fail the core limit', dr.codeHardFails('A.\n\nB.\n\nC.\n\nD.\n\nE.', 1300, 'core').some(f => f.startsWith('More than 4 paragraphs'))],
  ['the ship bar needs every dimension of the depth', !dr.clearsBar([{ score: 5 }, { score: 5 }], [], 'core') && dr.clearsBar([5, 5, 4, 4, 4].map(score => ({ score })), [], 'core')],
  ['suggest drops a sentence with a commit count', sg.withoutScriptCounts('I built the GraphQL client. I changed it in 37 commits across 4 projects.') === 'I built the GraphQL client.'],
  ['suggest keeps paragraphs', sg.withoutScriptCounts('I built it.\n\nIt has two parts. I ran it every day.') === 'I built it.\n\nIt has two parts.'],
  ['a four-sentence short draft is over the depth', !sg.fitsDepth(s4, 'short') && sg.fitsDepth(s4, 'core')],
  ['#143 Using AI for supervised coding is core', !qRow(143) || answerDepthFor(qRow(143)).depth === 'core'],
  ['#116 GraphQL is short', !qRow(116) || answerDepthFor(qRow(116)).depth === 'short'],
  ['a form field question is short', answerDepthFor({ id: -1, kind: 'form_field', subject: 'Using AI for supervised coding' }).depth === 'short'],
  ['a level with a short qualifier counts with the next sentence', dr.answerSentenceCount('Some, on the client side. I used GraphQL in one integration. I wired it into shipping. I have not built a server.') === 3],
  ['the chat draft rules give a core skill the full answer', (() => { const t = qc.draftShape('core', 1200, 'his words'); return t.includes('full version') && t.includes('never over 1200 characters') && t.includes('paragraphs') })()],
  ['the chat draft rules give any other skill 2 or 3 sentences', (() => { const t = qc.draftShape('short', 5000, 'his words'); return t.includes('Two or three sentences') && t.includes('never over 600 characters') })()],
  ['a form field limit wins in the chat draft rules', qc.draftShape('core', 500, 'his words').includes('never over 500 characters')],
  ['a real first sentence still counts', dr.answerSentenceCount('Some, I used GraphQL to query a store API for a client. I have not built a server.') === 2 && !dr.isLevelOnly('Yes, I built 3 apps.')],
]
console.log('\n=== answer depth')
for (const [name, ok] of depthCases) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
}

// Finding nothing is not a No: a No only when Devin said it (an answer, a negative entry, his words).
const { devinSaidNo } = await import('../../server/utils/draft-from-records')
const gql = { id: 0, kind: 'knows', subject: 'GraphQL', question: 'Have you used GraphQL in a real project?', answer: null, knowledgeKey: null, status: 'pending' } as any
const kb = [...entries]
const saidNoCases: Array<[string, any, any[], string[], boolean]> = [
  ['nothing said, no entry', gql, kb, [], false],
  ['his words say he has not', gql, kb, ['I have never used GraphQL.'], true],
  ['his words name it without a No', gql, kb, ['GraphQL came up at my last job.'], false],
  ['answered No before', { ...gql, answer: 'No' }, kb, [], true],
  ['a negative knowledge entry', gql, [...kb, { id: -1, category: 'skill', key: 'GraphQL', value: 'Does not know this: GraphQL.' }], [], true],
]
console.log('\n=== a No only when Devin said it')
for (const [label, q, es, said, want] of saidNoCases) {
  const got = devinSaidNo(q, es, said)
  if (got !== want) failed++
  console.log(`${got === want ? 'PASS' : 'FAIL'} ${label}: ${got}`)
}

console.log(`\n${failed ? `${failed} not as expected` : 'all as expected'}`)
process.exit(failed ? 1 : 0)
