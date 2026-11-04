// Draft from my records against the local harness drafts, judged blind as interview answers.
// Runs the app's own draftFromRecords() (server/utils/draft-from-records.ts) on a copy of a
// production snapshot, on Devin's subscription through the Agent SDK (the token comes from the
// worktree .env and is never printed), with his local memory server, then has a separate judge call
// score each app draft and the local draft for the same question on the five interview dimensions
// (Substance, Structure, Relevance, Credibility, Differentiation) without saying which is which.
// Each pair is judged twice, once in each order, and the two scores are averaged.
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
const { draftFromRecords } = await import('../../server/utils/draft-from-records')
const { aiStructured } = await import('../../server/utils/ai')

const JudgeShape = z.object({
  answers: z.array(z.object({
    label: z.enum(['A', 'B']),
    scores: z.object({
      substance: z.number().int(),
      structure: z.number().int(),
      relevance: z.number().int(),
      credibility: z.number().int(),
      differentiation: z.number().int(),
    }),
    why: z.string().describe('One or two lines on what earns or costs each score.'),
  })),
})

const JUDGE_SYSTEM = `You are an experienced hiring manager and interview coach. A software developer gives a written answer to an employer's screening question. Score each answer 1 to 5 on five dimensions, as an interviewer hearing it:
- Substance: specifics, what the candidate did and why, measured results, trade-offs.
- Structure: a clear arc (situation and stakes, action, result, lesson) where every sentence moves it forward.
- Relevance: it answers what was asked.
- Credibility: concrete figures and constraints a listener believes; no vague or inflated claims.
- Differentiation: an earned insight or a detail only someone who did the work would know.
Calibration: 2 is vague (any candidate could say it); 3 is competent but generic (a figure or two, a mechanical list of work); 4 is a real story with the candidate's decisions and a measured result; 5 adds stakes, the reasoning behind the choices, and a lesson only this person could tell.
You cannot check whether the claims are true; score the answer as written. Score each answer on its own merits; the order they appear in means nothing.`

function avg(xs: number[]): number {
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : 0
}

type Scores = { substance: number; structure: number; relevance: number; credibility: number; differentiation: number }
const total = (s: Scores) => avg([s.substance, s.structure, s.relevance, s.credibility, s.differentiation])

async function judge(id: number, question: string, app: string, localText: string) {
  const runs: Array<{ order: string; app: Scores; local: Scores; appWhy: string; localWhy: string }> = []
  for (const appFirst of [true, false]) {
    const a = appFirst ? app : localText
    const b = appFirst ? localText : app
    const out = await aiStructured(JudgeShape, {
      purpose: 'eval_records_judge',
      system: JUDGE_SYSTEM,
      prompt: `## The question\n${question}\n\n## Answer A\n${a}\n\n## Answer B\n${b}\n\nScore both answers.`,
      effort: 'medium',
      maxTokens: 2000,
      ref: { type: 'question', id },
    })
    const A = out.answers.find(x => x.label === 'A')
    const B = out.answers.find(x => x.label === 'B')
    if (!A || !B) throw new Error(`judge left out an answer for question ${id}`)
    const appAns = appFirst ? A : B
    const localAns = appFirst ? B : A
    runs.push({ order: appFirst ? 'app first' : 'local first', app: appAns.scores, local: localAns.scores, appWhy: appAns.why, localWhy: localAns.why })
  }
  const dims: Array<keyof Scores> = ['substance', 'structure', 'relevance', 'credibility', 'differentiation']
  const mean = (k: 'app' | 'local') => Object.fromEntries(dims.map(d => [d, avg(runs.map(r => r[k][d]))])) as Scores
  return { runs, app: mean('app'), local: mean('local') }
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
    results.push({ id, subject: q.subject, seconds, steps, error: res.ok ? res.reply : res.message })
    continue
  }
  console.log(`drafted in ${seconds} seconds (${steps.map(s => `${s.step} at ${s.at}s`).join(', ')})`)
  const localText = local[String(id)]!
  const verdict = await judge(id, q.question, res.draft.text, localText)
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
for (const r of results) {
  if (r.error) {
    console.log(`\n${r.id} ${r.subject}: no draft (${r.error})`)
    continue
  }
  const line = (s: Scores) => `S ${s.substance} / St ${s.structure} / R ${s.relevance} / C ${s.credibility} / D ${s.differentiation}`
  console.log(`\n${r.id} ${r.subject} (${r.seconds} s, memory ${r.memory}, ${r.appChars} chars)`)
  console.log(`  app   ${r.appTotal}  ${line(r.judge.app)}`)
  console.log(`  local ${r.localTotal}  ${line(r.judge.local)}`)
  console.log(`  APP DRAFT: ${r.app}`)
  for (const qq of r.coach?.questions ?? []) console.log(`  STRONGER: ${qq}`)
  if (r.coach) console.log(`  COACH: ${r.coach.scores.map((s: any) => `${s.dimension} ${s.score}`).join(', ')}`)
}
const ok = results.filter(r => !r.error)
console.log(`\nAverages over ${ok.length} questions: app ${avg(ok.map(r => r.appTotal))}, local ${avg(ok.map(r => r.localTotal))}`)
writeFileSync(outPath, JSON.stringify(results, null, 2))
