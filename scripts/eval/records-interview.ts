// Draft from my records against other drafts for the same questions, judged blind on Devin's house
// style. Runs the app's own draftFromRecords() (server/utils/draft-from-records.ts) on a copy of a
// production snapshot, on Devin's subscription through the Agent SDK (the token comes from the
// worktree .env and is never printed), with his local memory server, then has a separate judge call
// score each app draft and the other draft for the same question on the rubric for the question's
// depth (answerRubric in server/utils/draft-from-records.ts): a core catalog skill on Opening,
// Result, Structure, Judgment, Spoken and calibrated; any other question on Direct answer, Scope,
// Skills shown, Short and spoken, Calibration. The judge is not told which is which. Each pair is
// judged twice, once in each order, and the two scores are averaged. Hard fails (codeHardFails, by
// depth): more sentences or paragraphs than the depth allows, over its characters, a dash, or a
// semicolon (code), and a tool list (the judge). The ship bar: no hard fail, nothing under 3, an
// average of 4 or more. What code sees the style leaves out (a date,
// a file or code name, a sentence that opens with context, a sentence over 30 words; styleFaults())
// is printed for both, with a count per side. The judge cannot see the records, so the
// "no record supports it" and "names a client" fails are left to the app's own guards and are not
// scored for either.
//
//   env -u ANTHROPIC_BASE_URL npx tsx --tsconfig scripts/eval/tsconfig.json scripts/eval/records-interview.ts \
//     <snapshotCopy.db> <otherDrafts.json> <out.json> [questionIds]
//
// otherDrafts.json: { "<id>": "<draft text>", ... }, or the out.json of an earlier run (its app
// drafts are the other side, which compares a change before and after). An id with no other draft
// is drafted and coached, not judged. Prints per-question scores, lengths, the averages, and every
// app draft with its "To make this stronger" questions. RECORDS_DRAFT_DEBUG=1 also prints each
// sentence Claude wrote with the check that kept, trimmed, or dropped it (never set in production).

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
const localRaw = JSON.parse(readFileSync(localPath, 'utf8'))
// An earlier run's out.json: its app drafts are the other side.
const local: Record<string, string> = Array.isArray(localRaw)
  ? Object.fromEntries(localRaw.filter((r: any) => typeof r?.app === 'string' && r.app).map((r: any) => [String(r.id), r.app]))
  : localRaw
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
  // EVAL_MEMORY_URL=off drafts without past sessions (when the laptop's memory server does not answer).
  memoryMcpUrl: process.env.EVAL_MEMORY_URL === 'off' ? '' : (process.env.EVAL_MEMORY_URL || 'http://127.0.0.1:7391/mcp'),
  memoryMcpHostHeader: '',
})
const mem = await import('../../server/utils/memory')
// The laptop daemon is shared with every Claude session on it and took 28 seconds to open a
// session on 2026-11-04; production's 10 seconds would leave memory out of every draft here.
Object.assign(mem.MEMORY_LIMITS as any, { connectMs: 90_000, totalMs: 240_000 })
const { draftFromRecords, answerRubric, DEPTH_DIMENSIONS, DEPTH_LIMITS, answerSentenceCount, codeHardFails, clearsBar, paragraphCount, styleFaults } = await import('../../server/utils/draft-from-records')
const { answerDepthFor } = await import('../../server/utils/skill-catalog')
const { aiStructured } = await import('../../server/utils/ai')

type Depth = keyof typeof DEPTH_DIMENSIONS
type Dim = typeof DEPTH_DIMENSIONS[Depth][number]
/** Characters, paragraphs, sentences after the level, and what the style leaves out that code sees. */
const shape = (text: string) => ({ chars: text.length, paragraphs: paragraphCount(text), sentences: answerSentenceCount(text), faults: styleFaults(text) })

const judgeShape = (depth: Depth) => z.object({
  answers: z.array(z.object({
    label: z.enum(['A', 'B']),
    scores: z.array(z.object({
      dimension: z.enum(DEPTH_DIMENSIONS[depth]),
      score: z.number().int(),
      quote: z.string(),
    })).describe('All five dimensions.'),
    toolList: z.boolean().describe('True when the answer lists tools or skills instead of saying what he did with them.'),
    why: z.string().describe('One or two lines on what earns or costs the scores.'),
  })),
})

const judgeSystem = (depth: Depth) => `You are an experienced hiring manager. A software developer gives a written answer to an employer's screening question; a recruiter's software reads it first, then a person skims it.
${answerRubric(depth)}
Say whether each answer is a tool list. You cannot check whether the claims are true; score each answer as written, on its own merits, against the style. The order the answers appear in means nothing.`

function avg(xs: number[]): number {
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : 0
}

type Scores = Record<string, number>

async function judge(id: number, question: string, requirement: string | null, app: string, localText: string, depth: Depth) {
  const DIMS: readonly string[] = DEPTH_DIMENSIONS[depth]
  const runs: Array<{ order: string; app: Scores; local: Scores; appTools: boolean; localTools: boolean; appWhy: string; localWhy: string }> = []
  for (const appFirst of [true, false]) {
    const a = appFirst ? app : localText
    const b = appFirst ? localText : app
    const out = await aiStructured(judgeShape(depth), {
      purpose: 'eval_records_judge',
      system: judgeSystem(depth),
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
  const mean = (k: 'app' | 'local') => Object.fromEntries(DIMS.map(d => [d, avg(runs.map(r => r[k][d]!))])) as Scores
  const fails = (text: string, tools: boolean) => [...codeHardFails(text, DEPTH_LIMITS[depth].maxChars, depth), ...(tools ? ['A tool list'] : [])]
  const appFails = fails(app, runs.every(r => r.appTools))
  const localFails = fails(localText, runs.every(r => r.localTools))
  const app_ = mean('app')
  const local_ = mean('local')
  const ships = (sc: Scores, f: string[]) => clearsBar(DIMS.map(d => ({ score: sc[d]! })), f, depth)
  return { runs, app: app_, local: local_, appFails, localFails, appShips: ships(app_, appFails), localShips: ships(local_, localFails), total: (sc: Scores) => avg(DIMS.map(d => sc[d]!)) }
}

const results: any[] = []
for (const id of ids) {
  const q = useDb().select().from((await import('../../server/db/schema')).questions).all().find(r => r.id === id)
  if (!q) {
    console.error(`question ${id} is not in the snapshot`)
    continue
  }
  const depth: Depth = answerDepthFor(q).depth
  console.log(`\n=== ${id} ${q.subject}: drafting (depth ${depth})`)
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
    console.log(`drafted in ${seconds} seconds; no other draft to judge against`)
    results.push({ id, subject: q.subject, question: q.question, depth, seconds, steps, memory: res.memory, app: res.draft.text, appChars: res.draft.text.length, appShape: shape(res.draft.text), level: res.draft.level, adjacentOnly: !!res.draft.adjacentOnly, sentences: res.draft.sentences.map(s => ({ text: s.text, sources: s.sources.map(x => `${x.kind}: ${x.label}${x.detail ? ` (${x.detail})` : ''}`) })), coach: res.draft.coach ?? null, reply: res.reply, unjudged: true })
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
  const verdict = await judge(id, q.question, requirement, res.draft.text, localText, depth)
  results.push({
    id,
    subject: q.subject,
    question: q.question,
    depth,
    seconds,
    steps,
    memory: res.memory,
    app: res.draft.text,
    appChars: res.draft.text.length,
    appShape: shape(res.draft.text),
    level: res.draft.level,
    sentences: res.draft.sentences.map(s => ({ text: s.text, sources: s.sources.map(x => `${x.kind}: ${x.label}${x.detail ? ` (${x.detail})` : ''}`) })),
    coach: res.draft.coach ?? null,
    reply: res.reply,
    local: localText,
    localShape: shape(localText),
    judge: verdict,
    appTotal: verdict.total(verdict.app),
    localTotal: verdict.total(verdict.local),
  })
  writeFileSync(outPath, JSON.stringify(results, null, 2))
}

console.log('\n\n######## Results')
const line = (sc: Scores) => Object.entries(sc).map(([d, v]) => `${d.split(' ')[0]} ${v}`).join(' / ')
for (const r of results) {
  if (r.error) {
    console.log(`\n${r.id} ${r.subject}: no draft (${r.seconds} s): ${r.error}`)
    continue
  }
  if (r.unjudged) {
    console.log(`\n${r.id} ${r.subject} (depth ${r.depth}, ${r.seconds} s, level ${r.level ?? 'none'}, ${r.appChars} chars, ${r.appShape.paragraphs} paragraphs, ${r.appShape.sentences} sentences${r.appShape.faults.length ? `, ${r.appShape.faults.join('; ')}` : ''}, not judged: no other draft)`)
    console.log(`  REPLY: ${r.reply}`)
    console.log(`  APP DRAFT: ${r.app}`)
    for (const qq of r.coach?.questions ?? []) console.log(`  STRONGER: ${qq}`)
    if (r.coach) console.log(`  COACH: ${r.coach.scores.map((x: any) => `${x.dimension} ${x.score}`).join(', ')}; average ${r.coach.average}; ${r.coach.ships ? 'clears the bar' : 'under the bar'}${r.coach.rewritten ? '; rewritten once' : ''}`)
    continue
  }
  const len = (sh: ReturnType<typeof shape>) => `${sh.chars} chars, ${sh.paragraphs} paragraphs, ${sh.sentences} sentences${sh.faults.length ? `, ${sh.faults.join('; ')}` : ''}`
  console.log(`\n${r.id} ${r.subject} (depth ${r.depth}, ${r.seconds} s, memory ${r.memory}, level ${r.level ?? 'none'})`)
  console.log(`  app   ${r.appTotal}  ${line(r.judge.app)}  ${r.judge.appShips ? 'SHIPS' : 'under the bar'}${r.judge.appFails.length ? ` (hard fails: ${r.judge.appFails.join('; ')})` : ''}  [${len(r.appShape)}]`)
  console.log(`  other ${r.localTotal}  ${line(r.judge.local)}  ${r.judge.localShips ? 'SHIPS' : 'under the bar'}${r.judge.localFails.length ? ` (hard fails: ${r.judge.localFails.join('; ')})` : ''}  [${len(r.localShape)}]`)
  console.log(`  APP DRAFT: ${r.app}`)
  console.log(`  OTHER DRAFT: ${r.local}`)
  for (const qq of r.coach?.questions ?? []) console.log(`  STRONGER: ${qq}`)
  if (r.coach) console.log(`  COACH: ${r.coach.scores.map((x: any) => `${x.dimension} ${x.score}`).join(', ')}; average ${r.coach.average}; ${r.coach.ships ? 'clears the bar' : 'under the bar'}${r.coach.rewritten ? '; rewritten once' : ''}`)
}
const ok = results.filter(r => !r.error && !r.unjudged)
// Per dimension within each depth (the two depths score different dimensions).
const dimAvg = (k: 'app' | 'local') => (['short', 'core'] as const).filter(dp => ok.some(r => r.depth === dp))
  .map(dp => `${dp}: ${DEPTH_DIMENSIONS[dp].map(d => `${d} ${avg(ok.filter(r => r.depth === dp).map(r => r.judge[k][d]))}`).join(', ')}`).join('; ')
console.log(`\nAverages over ${ok.length} questions: app ${avg(ok.map(r => r.appTotal))}, other ${avg(ok.map(r => r.localTotal))}`)
console.log(`Per dimension, app: ${dimAvg('app')}`)
console.log(`Per dimension, other: ${dimAvg('local')}`)
console.log(`Length, app: ${avg(ok.map(r => r.appShape.chars))} chars, ${avg(ok.map(r => r.appShape.sentences))} sentences; other: ${avg(ok.map(r => r.localShape.chars))} chars, ${avg(ok.map(r => r.localShape.sentences))} sentences`)
const faultCount = (k: 'appShape' | 'localShape') => ok.reduce((n, r) => n + r[k].faults.length, 0)
console.log(`Style faults code sees (dates, code names, sentences that open with context, sentences over 30 words): app ${faultCount('appShape')}, other ${faultCount('localShape')}`)
console.log(`Clear the ship bar: app ${ok.filter(r => r.judge.appShips).length} of ${ok.length}, other ${ok.filter(r => r.judge.localShips).length} of ${ok.length}`)
writeFileSync(outPath, JSON.stringify(results, null, 2))
