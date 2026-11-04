// Checks the topic gate for this app's own repo (appRepoScope in server/utils/repos/search.ts) on a
// copy of a production snapshot, without calling Claude:
//
//   npx tsx --tsconfig scripts/eval/tsconfig.json scripts/eval/app-repo-topics.ts <snapshotCopy.db>
//
// Runs fixed subjects against the starting topics and exits 1 when any verdict differs from the
// expected one, then lists every knows and has_done question the gate opens for. With the repo
// indexed in the copy, it also prints this repo's hits for a few subjects, so a subject outside the
// topics (GraphQL, Shopify) shows none even where its commit messages say the word.

import { setupGlobals } from './globals'

const [dbPath] = process.argv.slice(2)
if (!dbPath) {
  console.error('usage: app-repo-topics.ts <snapshotCopy.db>')
  process.exit(2)
}
await setupGlobals({ databasePath: dbPath, anthropicApiKey: '', aiModel: 'none', aiFallbackModel: 'none', dailyAiBudgetUsd: '0', schedulerEnabled: 'false', demoToolPath: '' })
const search = await import('../../server/utils/repos/search')
const settings = await import('../../server/utils/repos/settings')
const { useDb } = await import('../../server/utils/db')

const topics = settings.DEFAULT_APP_REPO_TOPICS
const expected: Array<[string, string[] | null]> = [
  ['AI agents', ['AI agents and agentic workflows']],
  ['Internal agents and agent platforms', ['AI agents and agentic workflows']],
  ['AI agentic frameworks', ['AI agents and agentic workflows']],
  ['Concurrent agentic workflows', ['AI agents and agentic workflows']],
  ['LLM', ['LLM integration']],
  ['Integrating with LLMs', ['LLM integration']],
  ['LLM architecture, RAG, agents', ['LLM integration', 'AI agents and agentic workflows']],
  ['Anthropic Claude', ['Claude and the Anthropic API']],
  ['Prompt caching', ['prompt engineering and prompt caching']],
  ['Playwright', ['browser automation with Playwright']],
  ['Vue.js', ['Vue']],
  ['Vue 3 Composition API', ['Vue']],
  ['Nuxt 3', ['Nuxt']],
  ['Drizzle ORM', ['SQLite and Drizzle']],
  ['Docker and Kubernetes', ['Docker']],
  ['GraphQL', null],
  ['Shopify', null],
  ['Apache Airflow', null],
  ['REST API design', null],
  ['GitHub Actions', null],
  ['Structured content or content APIs for AI and search systems', null],
  ['Caching', null],
  ['Automation', null],
  ['Job boards', null],
  ['AI', null],
  ['React', null],
  ['Third-party vendor evaluation', null],
  ['LLM evaluation', ['AI evaluation', 'LLM integration']],
  ['AI tooling', null],
]
let bad = 0
for (const [subject, want] of expected) {
  const got = search.appRepoScope(subject, topics)?.topics.map(t => t.name).sort() ?? null
  const ok = JSON.stringify(got) === JSON.stringify(want ? [...want].sort() : null)
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${subject}: ${got ? got.join(', ') : 'no topic'}${ok ? '' : ` (expected ${want ? want.join(', ') : 'no topic'})`}`)
}

// The level cap: only this repo's commits behind a Yes on an "Up to Some experience" topic.
const levels: Array<[string, string, boolean, string]> = [
  ['Nuxt', 'Yes', true, 'Some experience'],
  ['Nuxt', 'Yes', false, 'Yes'],
  ['Drizzle ORM', 'Yes', true, 'Some experience'],
  ['AI agents', 'Yes', true, 'Yes'],
  ['Nuxt and AI agents', 'Yes', true, 'Yes'],
  ['Nuxt', 'Some experience', true, 'Some experience'],
  ['GraphQL', 'Yes', true, 'Yes'],
]
for (const [subject, level, only, want] of levels) {
  const got = search.appRepoLevel(level, search.appRepoScope(subject, topics), only)
  if (got !== want) bad++
  console.log(`${got === want ? 'ok  ' : 'FAIL'} level ${subject}, ${level}, ${only ? 'only this repo' : 'other records too'}: ${got}${got === want ? '' : ` (expected ${want})`}`)
}

const sqlite = useDb().$client
const rows = sqlite.prepare(`SELECT id, status, subject, question FROM questions WHERE kind IN ('knows', 'has_done') ORDER BY id`).all() as Array<{ id: number; status: string; subject: string | null; question: string }>
const open = rows.map(r => ({ r, scope: search.appRepoScope((r.subject ?? r.question).trim(), topics) })).filter(x => x.scope)
console.log(`\n${open.length} of ${rows.length} knows and has_done questions name a topic:`)
for (const { r, scope } of open) console.log(`  #${r.id} ${r.status} "${r.subject ?? r.question}": ${scope!.topics.map(t => `${t.name} (${t.cap})`).join(', ')}`)

const indexed = sqlite.prepare('SELECT count(*) AS n FROM repo_commits WHERE repo = ?').get(settings.APP_REPO) as { n: number }
const on = sqlite.prepare('SELECT included, indexed_at AS indexedAt FROM repo_sources WHERE full_name = ?').get(settings.APP_REPO) as { included: number; indexedAt: string | null } | undefined
if (indexed.n && on?.included && on.indexedAt) {
  console.log(`\nThis app's repo: ${indexed.n} commits indexed. Its hits by subject (no diffs, as the chat searches):`)
  for (const word of ['graphql', 'shopify']) {
    const n = sqlite.prepare('SELECT count(*) AS n FROM repo_commits WHERE repo = ? AND lower(message) LIKE ?').get(settings.APP_REPO, `%${word}%`) as { n: number }
    console.log(`  commit messages naming ${word}: ${n.n}`)
  }
  for (const subject of ['AI agents', 'GraphQL', 'Shopify', 'Vue']) {
    const text = `${subject}\nHave you used ${subject} in a real project?`
    const found = await search.searchEvidence(search.withSignatures({ code: [], paths: [], packages: [] }, subject), () => {}, { diffs: false, anchors: { subject, text } })
    const own = found.hits.filter(h => settings.isAppRepo(h.repo))
    console.log(`  ${subject}: ${found.hits.length} hits, ${own.length} from this app's repo${found.appRepo ? ` (topics: ${found.appRepo.topics.map(t => t.name).join(', ')}; cap ${found.appRepo.cap})` : ' (gate closed)'}`)
    for (const h of own) console.log(`    ${h.reasons.join('+')} ${h.date} ${h.subject.slice(0, 100)}${h.paths.length ? ` | ${h.paths.slice(0, 3).join(' ')}` : ''}`)
  }
}

if (bad) {
  console.error(`\n${bad} verdicts differ from the expected ones`)
  process.exit(1)
}
console.log('\nevery verdict matches')
