// Lists what the one-time LLM skill fold (APPROVED_LLM_SKILL_FOLDS in
// server/utils/skill-catalog-folds.ts, applySkillFolds() in server/utils/skill-catalog.ts) would do
// on a COPY of a production snapshot, without a Claude call:
//
//   npx tsx --tsconfig scripts/eval/tsconfig.json scripts/eval/llm-skill-repair.ts <snapshotCopy.db> [--apply]
//
// Prints one row per question and wording (id, wording, from skill, to skill, what happens), the
// folds it skips and why, the distill-made AI skills the plan leaves out (so a fresh snapshot shows
// any production has that the plan does not name), and the plan against the answer key
// (llmDuplicates in fixtures/skill-catalog-key.json). With --apply it applies the folds to the copy
// whatever the plan's approved flag says, as production will once it is approved. Exits 1 when the
// plan disagrees with the key.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setupGlobals } from './globals'

const args = process.argv.slice(2)
const dbPath = args.find(a => !a.startsWith('--'))
if (!dbPath) {
  console.error('usage: llm-skill-repair.ts <snapshotCopy.db> [--apply]')
  process.exit(2)
}
if (/\/qa\d*\/prod\.db$/.test(resolve(dbPath))) {
  console.error('That is an original snapshot; pass a copy.')
  process.exit(2)
}
const ROOT = resolve(new URL('.', import.meta.url).pathname, '../..')
const KEY = JSON.parse(readFileSync(join(ROOT, 'scripts/eval/fixtures/skill-catalog-key.json'), 'utf8'))
await setupGlobals({ databasePath: dbPath, anthropicApiKey: '', aiModel: 'none', aiFallbackModel: 'none', dailyAiBudgetUsd: '0', schedulerEnabled: 'false', demoToolPath: '' })
const sc = await import('../../server/utils/skill-catalog')
const { APPROVED_LLM_SKILL_FOLDS: plan } = await import('../../server/utils/skill-catalog-folds')
const { useDb } = await import('../../server/utils/db')
useDb().$client.prepare(`update task_queue set status = 'canceled' where status in ('queued', 'running')`).run()

const apply = args.includes('--apply')
const result = sc.applySkillFolds(plan, apply)
const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim()
console.log(`${plan.name} (approved: ${plan.approved})${apply ? ', applied to this copy' : ', not applied'}\n`)
console.log('| Id | Wording | From skill | To skill | What happens |')
console.log('|---|---|---|---|---|')
for (const r of result.rows) {
  const what = r.action === 'merge' ? `merged into #${r.toQuestion}` : r.action === 'phrasing' ? 'wording maps to the skill' : `kept: ${r.reason}`
  console.log(`| ${r.id != null ? `#${r.id}` : 'none'} | ${cell(r.wording)} | ${cell(r.fromSkill)} | ${cell(r.toSkill)} | ${what} |`)
}
console.log(`\nFolded: ${result.folded.join(', ') || 'none'}`)
for (const s of result.skipped) console.log(`Skipped ${s.slug}: ${s.reason}`)
if (apply) console.log(`Applications pointed at the merged questions' target: ${result.repointed.length ? result.repointed.join(', ') : 'none'}`)

// Distill-made skills about building AI that the plan does not name: candidates to review.
const AI = /\bllms?\b|large language models?|\bgenai\b|generative ai|\brag\b|\bai sdks?\b|foundation models?|model apis?|\bagentic\b|\bagents?\b|\bopenai\b|\banthropic\b|\bclaude\b|\bprompt/i
const named = new Set(plan.folds.map(f => f.from))
const others = sc.loadCatalog().filter(e => e.source === 'distill' && !named.has(e.slug) && [e.name, ...e.phrasings].some(t => AI.test(t)))
console.log(`\nDistill-made AI skills the plan leaves out (${others.length}):`)
for (const e of others) console.log(`  ${e.slug}: "${e.name}" (question #${e.questionId ?? 'none'}; asked as ${e.phrasings.map(p => `"${p}"`).join(', ')})`)

// The plan against the key: what should fold does, what should stay does.
let bad = 0
const key = KEY.llmDuplicates as { to: string; fold: string[]; keep: string[]; undecided: string[] }
const foldedHere = new Set(apply ? result.folded : result.folded)
const present = new Set(sc.loadCatalog().map(e => e.slug).concat(result.folded))
for (const slug of key.fold) {
  if (!present.has(slug) && !result.skipped.some(s => s.slug === slug)) continue
  const ok = foldedHere.has(slug)
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} folds ${slug} into ${key.to}`)
}
for (const slug of [...key.keep, ...key.undecided]) {
  const ok = !foldedHere.has(slug)
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} leaves ${slug} alone${key.undecided.includes(slug) ? ' (Devin decides)' : ''}`)
}
if (bad) {
  console.error(`\n${bad} folds differ from the key`)
  process.exit(1)
}
console.log('\nthe plan matches the key')
