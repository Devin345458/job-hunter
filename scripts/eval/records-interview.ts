// Draft from my records against the local harness drafts, judged blind as interview answers.
// Runs the app's own draftFromRecords() (server/utils/draft-from-records.ts) on a copy of a
// production snapshot, on Devin's subscription through the Agent SDK (the token comes from the
// worktree .env and is never printed), with his local memory server, then has a separate judge call
// score each app draft and the local draft for the same question on the answer guide's rubric
// (Direct answer, Concrete evidence, Ownership and judgment, Outcome, Calibration; ANSWER_RUBRIC in
// server/utils/draft-from-records.ts) without saying which is which. Each pair is judged twice, once
// in each order, and the two scores are averaged. Hard fails: more than 6 sentences, over 1,200
// characters, or a dash (code), and a tool list (the judge). The ship bar: no hard fail, nothing
// under 3, an average of 4 or more. The judge cannot see the records, so the "no record supports
// it" and "names a client" fails are left to the app's own guards and are not scored for either.
//
//   env -u ANTHROPIC_BASE_URL npx tsx --tsconfig scripts/eval/tsconfig.json scripts/eval/records-interview.ts \
//     <snapshotCopy.db> <localDrafts.json> <out.json> [questionIds]
//
// localDrafts.json: { "<id>": "<local draft text>", ... }. Prints per-question scores, the averages,
// and every app draft with its "To make this stronger" questions. RECORDS_DRAFT_DEBUG=1 also prints
// each sentence Claude wrote with the check that kept, trimmed, or dropped it (never set in production).

import { readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { setupGlobals } from './globals'

const [dbPath, localPath, outPath, idsArg] = process.argv.slice(2)
if (!dbPath || !localPath || !outPath) {
  console.error('usage: records-interview.ts <snapshotCopy.db> <localDrafts.json> <out.json> [questionIds]')
  process.exit(2)
}
if (process.env.ANTHROPIC_BASE_URL) {
  console.error('ANTHROPIC_BASE_URL is set; run with it unset so calls go to the real models')
  process.exit(2)
}
const envToken = (() => {
  try {
    const line = readFileSync('.env', 'utf8').split('\n').find(l => l.startsWith('NUXT_CLAUDE_CODE_OAUTH_TOKEN='))
    return line ? line.slice('NUXT_CLAUDE_CODE_OAUTH_TOKEN='.length).trim().replace(/^["']|["']$/g, '') : ''
  }
  catch {
    return ''
  }
})()
if (!envToken) {
  console.error('NUXT_CLAUDE_CODE_OAUTH_TOKEN is not in .env')
  process.exit(2)
}
const local: Record<string, string> = JSON.parse(readFileSync(localPath, 'utf8'))
const ids = (idsArg ? idsArg.split(',') : Object.keys(local)).map(Number).filter(Boolean)

await setupGlobals({
  databasePath: dbPath,
  anthropicApiKey: '',
  claudeCodeOauthToken: envToken,
  claudeCodePath: '',
  agentConcurrency: '3',
  aiModel: 'claude-opus-5-5',
  aiFallbackModel: 'claude-haiku-4-5',
  aiStepModels: '',
  aiStepBackends: '',
  dailyAiBudgetUsd: '10',
  schedulerEnabled: 'false',
  demoToolPath: '',
  memoryMcpUrl: 'http://127.0.0.1:7391/mcp',
  memoryMcpHostHeader: '',
})
const mem = await import('../../server/utils/memory')
// The laptop daemon is shared with every Claude session on it and took 28 seconds to open a
// session on 2026-11-04; production's 10 seconds would leave memory out of every draft here.
Object.assign(mem.MEMORY_LIMITS as any, { connectMs: 90_000, totalMs: 240_000 })
const { draftFromRecords, ANSWER_RUBRIC, codeHardFails, clearsBar } = await import('../../server/utils/draft-from-records')
const { aiStructured } = await import('../../server/utils/ai')

const DIMS = ['Direct answer', 'Concrete evidence', 'Ownership and judgment', 'Outcome', 'Calibration'] as const
type Dim = typeof DIMS[number]

const JudgeShape = z.object({
  answers: z.array(z.object({
    label: z.enum(['A', 'B']),
    scores: z.array(z.object({
      dimension: z.enum(DIMS),
      score: z.number().int(),
      quote: z.string(),
    })).describe('All five dimensions.'),
    toolList: z.boolean().describe('True when the answer lists tools or skills instead of telling what he did with them.'),
    why: z.string().describe('One or two lines on what earns or costs the scores.'),
  })),
})

const JUDGE_SYSTEM = `You are an experienced hiring manager. A software developer gives a written answer to an employer's screening question; a recruiter's software reads it first, then a person skims it.
${ANSWER_RUBRIC}
Say whether each answer is a tool list. You cannot check whether the claims are true; score each answer as written, on its own merits. The order the answers appear in means nothing.`

function avg(xs: number[]): number {
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : 0
}

type Scores = Record<Dim, number>
const total = (s: Scores) => avg(DIMS.map(d => s[d]))

async function judge(id: number, question: string, requirement: string | null, app: string, localText: string) {
  const runs: Array<{ order: string; app: Scores; local: Scores; appTools: boolean; localTools: boolean; appWhy: string; localWhy: string }> = []
  for (const appFirst of [true, false]) {
    const a = appFirst ? app : localText
    const b = appFirst ? localText : app
    const out = await aiStructured(JudgeShape, {
      purpose: 'eval_records_judge',
      system: JUDGE_SYSTEM,
      prompt: `## The question\n${question}${requirement ? `\nRequirement from the posting: "${requirement}"` : ''}\n\n## Answer A\n${a}\n\n## Answer B\n${b}\n\nScore both answers.`,
      effort: 'medium',
      maxTokens: 2500,
      ref: { type: 'question', id },
    })
    const A = out.answers.find(x => x.label === 'A')
    const B = out.answers.find(x => x.label === 'B')
    if (!A || !B) throw new Error(`judge left out an answer for question ${id}`)
    const toScores = (x: typeof A) => Object.fromEntries(DIMS.map(d => [d, Math.min(5, Math.max(1, x.scores.find(y => y.dimension === d)?.score ?? 1))])) as Scores
    const appAns = appFirst ? A : B
    const localAns = appFirst ? B : A
    runs.push({ order: appFirst ? 'app first' : 'local first', app: toScores(appAns), local: toScores(localAns), appTools: appAns.toolList, localTools: localAns.toolList, appWhy: appAns.why, localWhy: localAns.why })
  }
  const mean = (k: 'app' | 'local') => Object.fromEntries(DIMS.map(d => [d, avg(runs.map(r => r[k][d]))])) as Scores
  const fails = (text: string, tools: boolean) => [...codeHardFails(text, 1200), ...(tools ? ['A tool list'] : [])]
  const appFails = fails(app, runs.every(r => r.appTools))
  const localFails = fails(localText, runs.every(r => r.localTools))
  const app_ = mean('app')
  const local_ = mean('local')
  const ships = (sc: Scores, f: string[]) => clearsBar(DIMS.map(d => ({ score: sc[d] })), f)
  return { runs, app: app_, local: local_, appFails, localFails, appShips: ships(app_, appFails), localShips: ships(local_, localFails) }
}

const results: any[] = []
for (const id of ids) {
  const q = useDb().select().from((await import('../../server/db/schema')).questions).all().find(r => r.id === id)
  if (!q) {
    console.error(`question ${id} is not in the snapshot`)
    continue
  }
  console.log(`\n=== ${id} ${q.subject}: drafting`)
  const t0 = performance.now()
  const steps: Array<{ step: string; label: string; at: number }> = []
  const res = await draftFromRecords(id, [], (step, label) => steps.push({ step, label, at: Math.round((performance.now() - t0) / 100) / 10 }))
  const seconds = Math.round((performance.now() - t0) / 100) / 10
  if (!res.ok || !res.draft) {
    console.log(`no draft: ${res.ok ? res.reply : res.message}`)
    results.push({ id, subject: q.subject, seconds, steps, error: res.ok ? res.reply : res.message, unjudged: true })
    continue
  }
  console.log(`drafted in ${seconds} seconds (${steps.map(s => `${s.step} at ${s.at}s`).join(', ')})`)
  const localText = local[String(id)]
  if (!localText) {
    // No local draft to compare: the draft and its coach pass only (the Some experience and No paths).
    console.log(`drafted in ${seconds} seconds; no local draft to judge against`)
    results.push({ id, subject: q.subject, question: q.question, seconds, steps, memory: res.memory, app: res.draft.text, appChars: res.draft.text.length, level: res.draft.level, coach: res.draft.coach ?? null, reply: res.reply, unjudged: true })
    writeFileSync(outPath, JSON.stringify(results, null, 2))
    continue
  }
  const requirement = (() => {
    try {
      return (globalThis as any).questionChatContext(id)?.requirement?.text ?? null
    }
    catch {
      return null
    }
  })()
  const verdict = await judge(id, q.question, requirement, res.draft.text, localText)
  results.push({
    id,
    subject: q.subject,
    question: q.question,
    seconds,
    steps,
    memory: res.memory,
    app: res.draft.text,
    appChars: res.draft.text.length,
    sentences: res.draft.sentences.map(s => ({ text: s.text, sources: s.sources.map(x => `${x.kind}: ${x.label}${x.detail ? ` (${x.detail})` : ''}`) })),
    coach: res.draft.coach ?? null,
    reply: res.reply,
    local: localText,
    judge: verdict,
    appTotal: total(verdict.app),
    localTotal: total(verdict.local),
  })
  writeFileSync(outPath, JSON.stringify(results, null, 2))
}

console.log('\n\n######## Results')
const line = (sc: Scores) => DIMS.map(d => `${d.split(' ')[0]} ${sc[d]}`).join(' / ')
for (const r of results) {
  if (r.error) {
    console.log(`\n${r.id} ${r.subject}: no draft (${r.seconds} s): ${r.error}`)
    continue
  }
  if (r.unjudged) {
    console.log(`\n${r.id} ${r.subject} (${r.seconds} s, level ${r.level ?? 'none'}, ${r.appChars} chars, not judged: no local draft)`)
    console.log(`  APP DRAFT: ${r.app}`)
    for (const qq of r.coach?.questions ?? []) console.log(`  STRONGER: ${qq}`)
    if (r.coach) console.log(`  COACH: ${r.coach.scores.map((x: any) => `${x.dimension} ${x.score}`).join(', ')}; average ${r.coach.average}; ${r.coach.ships ? 'clears the bar' : 'under the bar'}${r.coach.rewritten ? '; rewritten once' : ''}`)
    continue
  }
  console.log(`\n${r.id} ${r.subject} (${r.seconds} s, memory ${r.memory}, ${r.appChars} chars)`)
  console.log(`  app   ${r.appTotal}  ${line(r.judge.app)}  ${r.judge.appShips ? 'SHIPS' : 'under the bar'}${r.judge.appFails.length ? ` (hard fails: ${r.judge.appFails.join('; ')})` : ''}`)
  console.log(`  local ${r.localTotal}  ${line(r.judge.local)}  ${r.judge.localShips ? 'SHIPS' : 'under the bar'}${r.judge.localFails.length ? ` (hard fails: ${r.judge.localFails.join('; ')})` : ''}`)
  console.log(`  APP DRAFT: ${r.app}`)
  for (const qq of r.coach?.questions ?? []) console.log(`  STRONGER: ${qq}`)
  if (r.coach) console.log(`  COACH: ${r.coach.scores.map((x: any) => `${x.dimension} ${x.score}`).join(', ')}; average ${r.coach.average}; ${r.coach.ships ? 'clears the bar' : 'under the bar'}${r.coach.rewritten ? '; rewritten once' : ''}`)
}
const ok = results.filter(r => !r.error && !r.unjudged)
const dimAvg = (k: 'app' | 'local') => DIMS.map(d => `${d} ${avg(ok.map(r => r.judge[k][d]))}`).join(', ')
console.log(`\nAverages over ${ok.length} questions: app ${avg(ok.map(r => r.appTotal))}, local ${avg(ok.map(r => r.localTotal))}`)
console.log(`Per dimension, app: ${dimAvg('app')}`)
console.log(`Per dimension, local: ${dimAvg('local')}`)
console.log(`Clear the ship bar: app ${ok.filter(r => r.judge.appShips).length} of ${ok.length}, local ${ok.filter(r => r.judge.localShips).length} of ${ok.length}`)
writeFileSync(outPath, JSON.stringify(results, null, 2))
