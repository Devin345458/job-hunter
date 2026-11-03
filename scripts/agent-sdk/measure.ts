// Measures what one Agent SDK call costs this machine, with the real Claude Code binary and no real
// token: the binary talks to the local fake API (fake-api.ts) instead of Anthropic.
//
//   npx tsx --tsconfig scripts/eval/tsconfig.json scripts/agent-sdk/measure.ts [sequential] [maxParallel]
//
// Reports, per call: total time, time from spawning the process to its first message, and time to
// its first API request; and, with several calls at once (each answer held for 4 seconds so the
// processes overlap), peak memory (RSS) and CPU per process and in total. Uses the same code path
// as the app (runAgentQuery in server/utils/agent-backend.ts), on a throwaway database.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupGlobals } from '../eval/globals'
import { startFakeApi } from './fake-api'

const sequential = Number(process.argv[2]) || 8
const maxParallel = Number(process.argv[3]) || 6
const TOKEN = 'sk-ant-oat01-MEASURE-ONLY-not-a-real-token-000000'
const dir = mkdtempSync(join(tmpdir(), 'agent-measure-'))
const config: Record<string, unknown> = {
  databasePath: join(dir, 'job-hunter.db'),
  anthropicApiKey: '',
  aiModel: 'claude-opus-5-5',
  aiFallbackModel: 'claude-haiku-4-5',
  claudeCodeOauthToken: TOKEN,
  claudeCodePath: '',
  agentConcurrency: '8',
  agentUid: '10003',
  dailyAiBudgetUsd: '10',
  schedulerEnabled: 'false',
  demoToolPath: '',
}
await setupGlobals(config as any)
const { runAgentQuery, setAgentTestHooks, claudeCodeBinary } = await import('../../server/utils/agent-backend')
if (!claudeCodeBinary()) throw new Error('Claude Code binary not found')

const schema = { type: 'object', properties: { answer: { type: 'string' }, score: { type: 'number' } }, required: ['answer', 'score'] }
const prompt = [{ type: 'text', text: `Instructions and knowledge base. ${'Lorem ipsum dolor sit amet. '.repeat(400)}`, cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'The posting.' }]

const api = await startFakeApi({ structured: { answer: 'ok', score: 1 }, expectedToken: TOKEN })
const pids = new Set<number>()
setAgentTestHooks({
  extraEnv: { ANTHROPIC_BASE_URL: api.url },
  onSpawn: (s) => {
    if (s.pid) pids.add(s.pid)
  },
})

function sample(): Array<{ pid: number; rssMb: number; cpu: number }> {
  const live = [...pids]
  if (!live.length) return []
  try {
    const out = execFileSync('ps', ['-o', 'pid=,rss=,%cpu=', '-p', live.join(',')], { encoding: 'utf8' })
    return out.trim().split('\n').filter(Boolean).map((l) => {
      const [pid, rss, cpu] = l.trim().split(/\s+/)
      return { pid: Number(pid), rssMb: Number(rss) / 1024, cpu: Number(cpu) }
    })
  }
  catch {
    return [] // none alive
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 0
}

// ── Sequential: overhead per call ──
const rows: Array<{ total: number; startup: number | null; firstRequest: number }> = []
for (let i = 0; i < sequential; i++) {
  const before = api.requests.length
  const t0 = Date.now()
  const r = await runAgentQuery({ purpose: 'enrich', model: 'claude-sonnet-5-5', system: 'Answer.', prompt: prompt as any, jsonSchema: schema, foreground: true })
  if (!r.ok) throw new Error(`call failed: ${r.kind} ${r.message}`)
  const req = api.requests.slice(before).find(q => q.path.startsWith("/v1/messages"))
  rows.push({ total: Date.now() - t0, startup: r.startupMs, firstRequest: (req?.at ?? Date.now()) - t0 })
}
console.log(`\nSequential (${sequential} calls, fake API answers at once):`)
console.log(`  first call: ${rows[0]!.total} ms total`)
console.log(`  median of the rest: ${median(rows.slice(1).map(r => r.total))} ms total, ${median(rows.slice(1).map(r => r.startup ?? 0))} ms from spawn to first message`)
console.log(`  all: ${rows.map(r => r.total).join(', ')} ms`)

// ── Parallel: memory and CPU per process ──
api.options.latencyMs = 4000
console.log('\nParallel (each answer held 4 s so processes overlap):')
for (const k of [1, 2, 4, maxParallel].filter((v, i, a) => a.indexOf(v) === i && v <= maxParallel)) {
  pids.clear()
  let peakTotal = 0
  let peakPer = 0
  let peakCpu = 0
  const cpuSamples: number[] = []
  const timer = setInterval(() => {
    const s = sample()
    if (!s.length) return
    peakTotal = Math.max(peakTotal, s.reduce((a, x) => a + x.rssMb, 0))
    peakPer = Math.max(peakPer, ...s.map(x => x.rssMb))
    const cpu = s.reduce((a, x) => a + x.cpu, 0)
    peakCpu = Math.max(peakCpu, cpu)
    cpuSamples.push(cpu)
  }, 100)
  const t0 = Date.now()
  const results = await Promise.all(Array.from({ length: k }, () => runAgentQuery({ purpose: 'enrich', model: 'claude-sonnet-5-5', system: 'Answer.', prompt: prompt as any, jsonSchema: schema, foreground: false })))
  clearInterval(timer)
  const failed = results.filter(r => !r.ok).length
  const alive = sample().length
  console.log(`  ${k} at once: ${Date.now() - t0} ms wall, peak RSS ${peakPer.toFixed(0)} MB per process, ${peakTotal.toFixed(0)} MB total; CPU peak ${peakCpu.toFixed(0)}% (100% = one core), median ${median(cpuSamples).toFixed(0)}% while waiting; ${failed} failed; ${alive} still running after the calls returned`)
}

await api.close()
rmSync(dir, { recursive: true, force: true })
