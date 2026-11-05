// Runs the one-time meaning repair's grouping (server/utils/question-meaning.ts, planMeaningRepair)
// on a COPY of a production snapshot and writes the proposed groups to a report Devin can read
// before the repair runs in production. Makes one real Claude call on the subscription token in .env
// (NUXT_CLAUDE_CODE_OAUTH_TOKEN), on the model production would use (NUXT_AI_MODEL, unless
// NUXT_AI_STEP_MODELS maps question_subject_groups). It writes to the copy: never point it at the
// live database.
//
//   npx tsx --tsconfig scripts/eval/tsconfig.json scripts/eval/meaning-groups.ts <snapshotCopy.db> <reportDir> [--apply] [--from <plan.json>]
//
// First it runs the one-time repairs production has already run (refileSubjectSectionsOnce, no
// Claude call), so the copy starts where production is. Then it plans the groups (or reads an
// earlier plan with --from, so a rerun makes no call), prints them, and writes plan.json and
// report.md to reportDir. With --apply it also merges the copy's questions as production would and
// sets the repair's marker, so learn:daily on the copy does not plan again.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setupGlobals } from './globals'

const args = process.argv.slice(2)
const fromAt = args.indexOf('--from')
const from = fromAt >= 0 ? args[fromAt + 1] ?? null : null
const [dbPath, reportDir] = args.filter((a, i) => !a.startsWith('--') && !(fromAt >= 0 && i === fromAt + 1))
const apply = args.includes('--apply')
if (!dbPath || !reportDir) {
  console.error('usage: meaning-groups.ts <snapshotCopy.db> <reportDir> [--apply] [--from <plan.json>]')
  process.exit(2)
}
if (/\/qa2\/prod\.db$/.test(resolve(dbPath))) {
  console.error('That is the original snapshot. Copy it first and pass the copy.')
  process.exit(2)
}

// The token and model settings from .env, never printed.
const env: Record<string, string> = {}
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
}
if (!from && !env.NUXT_CLAUDE_CODE_OAUTH_TOKEN) {
  console.error('NUXT_CLAUDE_CODE_OAUTH_TOKEN is not in .env; the grouping call needs it (or pass --from).')
  process.exit(2)
}

await setupGlobals({
  databasePath: dbPath,
  anthropicApiKey: '',
  aiModel: env.NUXT_AI_MODEL || 'claude-opus-5-5',
  aiFallbackModel: env.NUXT_AI_FALLBACK_MODEL || 'claude-haiku-4-5',
  aiStepModels: env.NUXT_AI_STEP_MODELS || '',
  aiStepBackends: '',
  claudeCodeOauthToken: env.NUXT_CLAUDE_CODE_OAUTH_TOKEN || '',
  claudeCodePath: env.NUXT_CLAUDE_CODE_PATH || '',
  agentConcurrency: '2',
  agentThinking: 'off',
  agentUid: '10003',
  dailyAiBudgetUsd: '10',
  backgroundBudgetShare: '0.7',
  subscriptionDailyLimitUsd: '15',
  subscriptionWeekLimitUsd: '105',
  schedulerEnabled: 'false',
  demoToolPath: '',
})
const qm = await import('../../server/utils/question-meaning')
const q = await import('../../server/utils/questions')
const { questions, aiCalls } = await import('../../server/db/schema')
const { sql, eq } = await import('drizzle-orm')
const db = (globalThis as any).useDb()

// A copied database carries queue items still marked queued or running; nothing here runs them,
// and a server started on the copy later must not either.
db.run(sql`update task_queue set status = 'canceled' where status in ('queued', 'running')`)

const sections = q.refileSubjectSectionsOnce(m => console.log(m))
if (!sections.ran) console.log('subject sections: already ran on this copy')

let plan: Awaited<ReturnType<typeof qm.planMeaningRepair>>
if (from) {
  plan = JSON.parse(readFileSync(from, 'utf8'))
  console.log(`plan read from ${from} (no Claude call)`)
}
else {
  const started = Date.now()
  plan = await qm.planMeaningRepair()
  const made = db.select().from(aiCalls).where(eq(aiCalls.purpose, qm.SUBJECT_GROUPS_PURPOSE)).all()
  console.log(`${made.length} calls in ${((Date.now() - started) / 1000).toFixed(0)} s: ${made.map((c: any) => `${c.model}, est. $${(c.estCostUsd ?? 0).toFixed(3)}, ${c.outputTokens} out${c.error ? `, error: ${c.error}` : ''}`).join('; ')}`)
}
if (plan.error) {
  console.error(`the grouping call failed: ${plan.error}`)
  process.exit(1)
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(join(reportDir, 'plan.json'), JSON.stringify(plan, null, 2))

const cell = (s: string | null | undefined) => (s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim()
const status = (m: { status: string; answer: string | null }) => m.status === 'answered' ? `answered ${m.answer}` : m.status === 'skipped' ? 'skipped by the app' : 'open'
const merges = plan.groups.flatMap(g => g.members.filter(m => m.action === 'merge'))
const conflicts = plan.groups.filter(g => g.conflict)
const kept = plan.groups.flatMap(g => g.members.filter(m => m.action === 'keep').map(m => ({ g, m })))
const subjects = new Map<number, string>(db.select({ id: questions.id, subject: questions.subject }).from(questions).all().map((r: any) => [r.id, r.subject]))

const lines: string[] = []
lines.push(`# Questions grouped by meaning (proposed)`, '')
lines.push(`Snapshot: ${resolve(dbPath)}. Model: ${plan.model}. ${plan.candidates} open, answered, and app-skipped skill and experience questions went in.`, '')
lines.push(`- ${plan.groups.length} groups.`)
lines.push(`- ${merges.length} questions would be merged into their group's question (status skipped, note "Merged into question #N").`)
lines.push(`- ${kept.length} grouped questions stay as they are (reason in the table).`)
lines.push(`- ${conflicts.length} groups hold two answers of yours that differ; nothing in them is merged.`)
lines.push(`- ${plan.removed.length} questions the second reading took out of a proposed group (listed below).`)
lines.push(`- ${plan.standalone.length} questions are in no group.`, '')
lines.push('Production plans again from its live questions when the repair runs (one call, the same prompt and rules), so its groups can differ in places from these.', '')
lines.push('| Group | Id | Subject | Status | Canonical | Action |', '|---|---|---|---|---|---|')
for (const g of plan.groups) {
  for (const m of g.members) {
    lines.push(`| ${cell(g.claim)} | #${m.id} | ${cell(m.subject)} | ${status(m)} | ${g.canonicalId != null ? `#${g.canonicalId}` : 'none'} | ${m.action === 'canonical' ? 'the one to answer' : m.action === 'merge' ? `merge into #${g.canonicalId}` : `keep: ${cell(m.reason)}`} |`)
  }
}
if (conflicts.length) {
  lines.push('', '## Answered differently (left alone)', '')
  for (const g of conflicts) lines.push(`- ${cell(g.claim)}: ${cell(g.conflict)}.`)
}
if (plan.removed.length) {
  lines.push('', '## Taken out by the second reading', '')
  for (const r of plan.removed) lines.push(`- #${r.id} ${cell(subjects.get(r.id))}: ${cell(r.reason)}.`)
}
lines.push('', '## In no group', '')
lines.push(plan.standalone.map(id => `#${id} ${cell(subjects.get(id))}`).join('; '))
writeFileSync(join(reportDir, 'report.md'), `${lines.join('\n')}\n`)

console.log(`\n${plan.groups.length} groups, ${merges.length} merges, ${kept.length} kept, ${conflicts.length} conflicts, ${plan.removed.length} taken out by the second reading, ${plan.standalone.length} in no group`)
for (const r of plan.removed) console.log(`  taken out: #${r.id} ${subjects.get(r.id)} (${r.reason})`)
for (const g of plan.groups) {
  console.log(`\n[${g.claim}] canonical ${g.canonicalId != null ? `#${g.canonicalId}` : 'none'}${g.conflict ? ` CONFLICT: ${g.conflict}` : ''}`)
  for (const m of g.members) console.log(`  #${m.id} ${m.subject} (${status(m)}): ${m.action}${m.reason ? ` (${m.reason})` : ''}`)
}
console.log(`\nreport: ${join(resolve(reportDir), 'report.md')}`)

if (apply) {
  const applied = qm.applyMeaningRepair(plan)
  const valueJson = JSON.stringify({ groups: plan.groups.length, merged: applied.merged, conflicts: conflicts.map(g => ({ claim: g.claim, conflict: g.conflict })), model: plan.model, appliedBy: 'scripts/eval/meaning-groups.ts' })
  db.run(sql`insert into app_settings (key, value_json, updated_at) values ('question_meaning_repair', ${valueJson}, datetime('now')) on conflict(key) do update set value_json = excluded.value_json`)
  console.log(`applied to the copy: ${applied.merged.length} merged, ${applied.repointed.length} waiting applications pointed at the canonical questions`)
}
