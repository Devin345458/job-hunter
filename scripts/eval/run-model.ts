// One model, three AI steps, the app's own code paths, against a copy of the production database.
// Started by scripts/eval/run.mjs, one process per model, because useDb() and useAI() are module
// singletons.
//
//   npx tsx --tsconfig scripts/eval/tsconfig.json scripts/eval/run-model.ts \
//     <model> <dbCopy> <outJson> <capUsd> <toolShimDir> <jobIds comma separated>
//
// Steps per job:
// - enrich: extractPosting() on the stored posting text, then buildCompensation(). The posting
//   fetch (resolvePosting) is skipped so every model reads the same text. Nothing is written to jobs.
// - match: scoreJobs({ jobIds: [id], fresh: true }), which runs the private scoreSkills() call on
//   the stored requirements_json, then composes and writes the score into the copy.
// - gaps: analyzeGaps() on an application for the job (one is inserted into the copy when the job
//   has none). Questions it inserts are recorded and then deleted, so every job and every model
//   starts from the same questions table.
//
// Fallback is off (aiFallbackModel equals aiModel), so a model failure shows as an error. The
// app's daily budget check is the hard stop: the budget is set to today's spend already in the
// copy plus this model's cap.
//
// The API key arrives in NUXT_ANTHROPIC_API_KEY from the launcher. It is never printed or written.

import { AsyncLocalStorage } from 'node:async_hooks'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setupGlobals } from './globals'

const [model, dbPath, outPath, capArg, toolShimDir, idsArg] = process.argv.slice(2)
if (!model || !dbPath || !outPath || !capArg || !toolShimDir || !idsArg) {
  console.error('usage: run-model.ts <model> <dbCopy> <outJson> <capUsd> <toolShimDir> <jobIds>')
  process.exit(2)
}
if (!process.env.NUXT_ANTHROPIC_API_KEY) {
  console.error('NUXT_ANTHROPIC_API_KEY is not set')
  process.exit(2)
}
const jobIds = idsArg.split(',').map(Number).filter(Boolean)
const cap = Number(capArg)

const config = {
  databasePath: dbPath,
  anthropicApiKey: process.env.NUXT_ANTHROPIC_API_KEY,
  aiModel: model,
  aiFallbackModel: model,
  dailyAiBudgetUsd: '1000000',
  schedulerEnabled: 'false',
  demoToolPath: toolShimDir,
  demosEnabled: 'false',
  realSubmitEnabled: 'false',
  memoryMcpUrl: '',
}
await setupGlobals(config)

const { useAI, aiSpentToday } = await import('../../server/utils/ai')
const { PRICES, usageCost } = await import('../../server/utils/model')
const { extractPosting } = await import('../../server/utils/enrich/extract')
const { buildCompensation } = await import('../../server/utils/compensation')
const { scoreJobs } = await import('../../server/utils/scoring')
const { analyzeGaps } = await import('../../server/utils/demo/gaps')
const { loadKnowledge } = await import('../../server/utils/knowledge')
const { mapPool } = await import('../../server/utils/job-sources/http')
const { useDb } = await import('../../server/utils/db')
const { availableToolchains } = await import('../../server/utils/demo/exec')
const { jobs, applications, questions } = await import('../../server/db/schema')
const { eq, gt, inArray, desc, sql } = await import('drizzle-orm')

if (!PRICES[model]) throw new Error(`No price for ${model} in server/utils/model.ts`)

// ── Budget: today's spend already in the copy plus this model's cap ──
const baselineSpend = aiSpentToday()
config.dailyAiBudgetUsd = String(baselineSpend + cap)

// ── Measurement wrapper on the app's own client ──
interface Ctx { step: string; jobId: number }
const als = new AsyncLocalStorage<Ctx>()

interface CallRecord {
  step: string
  jobId: number
  requestedModel: string
  servedModel: string | null
  effort: string | null
  latencyMs: number
  stopReason: string | null
  usage: Record<string, number | null> | null
  costUsd: number
  parsedNull: boolean
  parsed: unknown
  text: string | null
  error: string | null
}
const calls: CallRecord[] = []

function costOf(m: string, u: any): number {
  return u ? usageCost(m, u) : 0
}

const client = useAI() as any
const messages = client.beta.messages
// The SDK's parse() calls create() on the same object; only the outermost call is recorded.
const inside = new AsyncLocalStorage<boolean>()
for (const method of ['parse', 'create'] as const) {
  const original = messages[method].bind(messages)
  messages[method] = (params: any, options: any) => {
    if (inside.getStore()) return original(params, options)
    const ctx = als.getStore() ?? { step: 'unknown', jobId: 0 }
    const started = performance.now()
    const promise = inside.run(true, () => original(params, options))
    return promise.then((r: any) => {
      calls.push({
        ...ctx,
        requestedModel: params.model,
        servedModel: r?.model ?? null,
        effort: params.output_config?.effort ?? null,
        latencyMs: Math.round(performance.now() - started),
        stopReason: r?.stop_reason ?? null,
        usage: r?.usage ? {
          input_tokens: r.usage.input_tokens ?? null,
          output_tokens: r.usage.output_tokens ?? null,
          cache_read_input_tokens: r.usage.cache_read_input_tokens ?? null,
          cache_creation_input_tokens: r.usage.cache_creation_input_tokens ?? null,
        } : null,
        costUsd: costOf(r?.model || params.model, r?.usage),
        parsedNull: method === 'parse' ? r?.parsed_output == null : false,
        parsed: method === 'parse' ? r?.parsed_output ?? null : null,
        text: method === 'create' ? (r?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') : null,
        error: null,
      })
      return r
    }, (e: any) => {
      calls.push({
        ...ctx,
        requestedModel: params.model,
        servedModel: null,
        effort: params.output_config?.effort ?? null,
        latencyMs: Math.round(performance.now() - started),
        stopReason: null,
        usage: null,
        costUsd: 0,
        parsedNull: false,
        parsed: null,
        text: null,
        error: `${e?.constructor?.name ?? 'Error'}: ${e?.status ?? ''} ${String(e?.message ?? e).slice(0, 400)}`,
      })
      throw e
    })
  }
}

const out: any = {
  model,
  startedAt: new Date().toISOString(),
  baseUrlHost: (() => { try { return new URL(client.baseURL).host } catch { return String(client.baseURL) } })(),
  baselineSpend,
  capUsd: cap,
  toolchains: await availableToolchains(),
  enrich: {} as Record<number, unknown>,
  match: {} as Record<number, unknown>,
  gaps: {} as Record<number, unknown>,
  calls,
  stoppedBy: null as string | null,
}
console.log(`[${model}] api host ${out.baseUrlHost}, toolchains ${out.toolchains.map((t: any) => t.id).join(',') || 'none'}, ${jobIds.length} jobs, cap $${cap}`)

function save() {
  mkdirSync(dirname(outPath), { recursive: true })
  out.finishedAt = new Date().toISOString()
  out.spentUsd = calls.reduce((s, c) => s + c.costUsd, 0)
  writeFileSync(outPath, JSON.stringify(out, null, 2))
}

const db = useDb()
const rows = db.select().from(jobs).where(inArray(jobs.id, jobIds)).all()
const byId = new Map(rows.map(r => [r.id, r]))
const ordered = jobIds.map(id => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r)
const entries = loadKnowledge()

function errText(e: any) {
  return `${e?.constructor?.name ?? 'Error'}: ${String(e?.message ?? e).slice(0, 400)}`
}

// ── Step 1: enrich ──
await mapPool(ordered, 4, async (job) => {
  if (out.stoppedBy) return
  await als.run({ step: 'enrich', jobId: job.id }, async () => {
    const started = performance.now()
    try {
      const ex = await extractPosting(job, job.postingText!, entries)
      const comp = buildCompensation(ex.compensation, job.postingText!)
      out.enrich[job.id] = { ok: true, ms: Math.round(performance.now() - started), extraction: ex.compensation, requirements: ex.requirements, comp }
    }
    catch (e: any) {
      if (/budget/i.test(String(e?.message))) out.stoppedBy = `budget during enrich #${job.id}`
      out.enrich[job.id] = { ok: false, ms: Math.round(performance.now() - started), error: errText(e) }
    }
  })
  console.log(`[${model}] enrich #${job.id} ${(out.enrich[job.id] as any).ok ? 'ok' : (out.enrich[job.id] as any).error}`)
})
save()

// ── Step 2: match ──
await mapPool(ordered, 4, async (job) => {
  if (out.stoppedBy) return
  await als.run({ step: 'match', jobId: job.id }, async () => {
    const started = performance.now()
    try {
      const stats = await scoreJobs({ jobIds: [job.id], fresh: true, log: () => {} })
      const row = db.select({ b: jobs.scoreBreakdown, scoredAt: jobs.scoredAt }).from(jobs).where(eq(jobs.id, job.id)).get()
      const breakdown = row?.b ? JSON.parse(row.b) : null
      const ok = stats.scored === 1 && !stats.failed
      if (stats.budgetStopped) out.stoppedBy = `budget during match #${job.id}`
      out.match[job.id] = { ok, ms: Math.round(performance.now() - started), stats, breakdown: ok ? breakdown : null }
    }
    catch (e: any) {
      out.match[job.id] = { ok: false, ms: Math.round(performance.now() - started), error: errText(e) }
    }
  })
  console.log(`[${model}] match #${job.id} ${(out.match[job.id] as any).ok ? 'ok' : JSON.stringify((out.match[job.id] as any).stats?.errors ?? (out.match[job.id] as any).error)}`)
})
save()

// ── Step 3: gap analysis, one job at a time from the same questions baseline ──
for (const job of ordered) {
  if (out.stoppedBy) break
  let app = db.select().from(applications).where(eq(applications.jobId, job.id)).orderBy(desc(applications.id)).limit(1).get()
  const insertedApp = !app
  if (!app) app = db.insert(applications).values({ jobId: job.id, status: 'draft' }).returning().get()
  const qBaseline = db.select({ m: sql<number>`coalesce(max(${questions.id}), 0)` }).from(questions).get()!.m
  await als.run({ step: 'gaps', jobId: job.id }, async () => {
    const started = performance.now()
    try {
      const gap = await analyzeGaps(app!.id)
      out.gaps[job.id] = { ok: true, ms: Math.round(performance.now() - started), applicationId: app!.id, insertedApp, gap }
    }
    catch (e: any) {
      if (/budget/i.test(String(e?.message))) out.stoppedBy = `budget during gaps #${job.id}`
      out.gaps[job.id] = { ok: false, ms: Math.round(performance.now() - started), error: errText(e) }
    }
  })
  const created = db.select().from(questions).where(gt(questions.id, qBaseline)).all()
  ;(out.gaps[job.id] as any).questionsCreated = created.map(q => ({ kind: q.kind, subject: q.subject, question: q.question, context: q.context }))
  db.delete(questions).where(gt(questions.id, qBaseline)).run()
  console.log(`[${model}] gaps #${job.id} ${(out.gaps[job.id] as any).ok ? 'ok' : (out.gaps[job.id] as any).error}`)
}

save()
console.log(`[${model}] done, $${out.spentUsd.toFixed(4)} spent${out.stoppedBy ? `, stopped: ${out.stoppedBy}` : ''}`)
process.exit(0)
