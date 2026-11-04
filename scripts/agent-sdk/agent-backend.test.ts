// Unit tests for the agent backend (Devin's Claude subscription through the Claude Agent SDK).
//
//   npm run test:agent
//
// The SDK's query() is replaced by a stub, so no Claude Code process starts and no request leaves
// the machine, except the last test, which runs the real Claude Code binary against the local fake
// API in fake-api.ts (skipped when the binary is not installed). The app's server code runs outside
// Nitro through scripts/eval/globals.ts, on a fresh database file in a temporary directory.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { z } from 'zod'
import { setupGlobals } from '../eval/globals'
import { startFakeApi } from './fake-api'

const TOKEN = 'sk-ant-oat01-TEST-ONLY-token-aaaaBBBBccccDDDD-not-real'
const dir = mkdtempSync(join(tmpdir(), 'agent-backend-test-'))

const config: Record<string, unknown> = {
  databasePath: join(dir, 'job-hunter.db'),
  anthropicApiKey: '',
  aiModel: 'claude-opus-5-5',
  aiFallbackModel: 'claude-haiku-4-5',
  aiStepModels: 'enrich=claude-sonnet-5-5,match=claude-haiku-5-5',
  aiStepBackends: '',
  claudeCodeOauthToken: TOKEN,
  claudeCodePath: '',
  agentConcurrency: '4',
  agentThinking: 'off',
  agentUid: '10003',
  dailyAiBudgetUsd: '10',
  backgroundBudgetShare: '0.7',
  schedulerEnabled: 'false',
  demoToolPath: '',
}

let m: Record<string, any> = {}

// ── The stub SDK ────────────────────────────────────────────

interface StubCall { options: any; message: any }
const calls: StubCall[] = []
let script: (call: StubCall) => Promise<any[]> | any[] = () => []

function stubQuery({ prompt, options }: { prompt: any; options?: any }) {
  const iter = (async function* () {
    let message: any = null
    if (typeof prompt === 'string') message = { message: { role: 'user', content: prompt } }
    else for await (const msg of prompt) message = msg
    const call = { options, message }
    calls.push(call)
    for (const msg of await script(call)) {
      if (msg instanceof Error) throw msg
      yield msg
    }
  })() as any
  iter.close = () => {}
  return iter
}

const ok = (structured: unknown, extra: Record<string, unknown> = {}) => [
  { type: 'system', subtype: 'init' },
  { type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [] } },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify(structured),
    structured_output: structured,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 400, cacheCreationInputTokens: 0, costUSD: 0.0123 } },
    ...extra,
  },
]

const limited = (resetsAtSec?: number) => [
  { type: 'system', subtype: 'init' },
  { type: 'rate_limit_event', rate_limit_info: resetsAtSec ? { status: 'rejected', resetsAt: resetsAtSec, rateLimitType: 'five_hour' } : { status: 'rejected' } },
  { type: 'assistant', error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: 'You\'ve hit your 5-hour limit' }] } },
  { type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'You\'ve hit your 5-hour limit', total_cost_usd: 0, usage: {}, modelUsage: {} },
  new Error('Claude Code returned an error result: You\'ve hit your 5-hour limit'),
]

const Answer = z.object({ answer: z.string(), score: z.number() })

// Every request the app's API backend (the Anthropic client) would send goes through fetch.
let apiRequests = 0
const realFetch = globalThis.fetch

function db() {
  return m.useDb()
}

function rows(): any[] {
  return db().all(m.sql`select * from ai_calls order by id`)
}

before(async () => {
  await setupGlobals(config as any)
  m = { ...(await import('../../server/utils/ai')), ...(await import('../../server/utils/agent-backend')), ...(await import('../../server/utils/subscription-pause')), ...(await import('../../server/utils/queue')), ...(await import('../../server/utils/runs')) }
  m.sql = (await import('drizzle-orm')).sql
  m.runProblems = (await import('../../shared/utils/run-outcome')).runProblems
  m.itemOutcomeFromRun = (await import('../../server/utils/queue-run')).itemOutcomeFromRun
  Object.assign(m, await import('../../server/utils/subscription-budget'))
  m.perJobQueueCounts = (await import('../../server/utils/queue-jobs')).perJobQueueCounts
  m.matchStep = (await import('../../server/utils/queue-jobs')).matchStep
  m.runOutcome = (await import('../../shared/utils/run-outcome')).runOutcome
  m.queueItemText = (await import('../../shared/utils/queue-text')).queueItemText
  m.appLimitPauseText = (await import('../../shared/utils/subscription')).appLimitPauseText
  m.stopFor = (await import('../../server/utils/question-chat')).stopFor
  m.aiStageCosts = (await import('../../server/utils/ai-stages')).aiStageCosts
  m.useDb = (globalThis as any).useDb
  m.setAgentTestHooks({ query: stubQuery as any })
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    apiRequests++
    return realFetch(...args)
  }) as typeof fetch
})

after(() => {
  globalThis.fetch = realFetch
  m.setAgentTestHooks({})
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  calls.length = 0
  apiRequests = 0
  config.claudeCodeOauthToken = TOKEN
  config.anthropicApiKey = ''
  config.aiStepBackends = ''
  config.dailyAiBudgetUsd = '10'
  config.agentConcurrency = '4'
  config.agentThinking = 'off'
  config.subscriptionDailyLimitUsd = ''
  config.subscriptionWeekLimitUsd = ''
  m.resetAiAccountStops()
  db().run(m.sql`delete from app_settings where key in ('subscription_pause', 'subscription_limits')`)
  db().run(m.sql`delete from ai_calls`)
  db().run(m.sql`delete from task_queue`)
  script = () => ok({ answer: 'yes', score: 7 })
})

// ── Routing ─────────────────────────────────────────────────

describe('routing', () => {
  test('control: the fetch counter sees a request on the API key backend (so its zero elsewhere means something)', async () => {
    const api = await startFakeApi({})
    const saved = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_BASE_URL = api.url
    config.anthropicApiKey = 'sk-ant-api03-fake-for-the-control-test'
    config.aiStepBackends = '*=api'
    try {
      assert.equal(m.stepBackend('enrich'), 'api')
      await m.aiStructured(Answer, { purpose: 'enrich', prompt: 'x' }).catch(() => {})
      assert.ok(apiRequests > 0, 'the API key backend made a request through fetch')
      assert.equal(calls.length, 0, 'and no Agent SDK call')
      assert.equal(rows()[0]?.backend, 'api')
    }
    finally {
      if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = saved
      await api.close()
    }
  })

  test('every step runs on the subscription while the token is set', () => {
    for (const p of ['enrich', 'match_gaps', 'match', 'question_chat', 'tailor', 'repo_judge', 'learn_note']) assert.equal(m.stepBackend(p), 'agent', p)
  })

  test('without the token every step uses the API key, as before', () => {
    config.claudeCodeOauthToken = ''
    assert.equal(m.stepBackend('enrich'), 'api')
    assert.equal(m.stepBackend('tailor'), 'api')
  })

  test('a step mapped to api uses the key only while the key is set', () => {
    config.aiStepBackends = 'enrich=api'
    assert.equal(m.stepBackend('enrich'), 'agent', 'no key: stays on the subscription')
    config.anthropicApiKey = 'sk-ant-api03-test'
    assert.equal(m.stepBackend('enrich'), 'api')
    assert.equal(m.stepBackend('match'), 'agent')
    config.aiStepBackends = '*=api,tailor=agent'
    assert.equal(m.stepBackend('match'), 'api')
    assert.equal(m.stepBackend('tailor'), 'agent')
  })
})

// ── Calls on the subscription ───────────────────────────────

describe('aiStructured on the subscription', () => {
  test('returns the object validated by the zod schema and logs backend agent, $0 billed, the estimate kept', async () => {
    const out = await m.aiStructured(Answer, { purpose: 'enrich', system: 'Read the posting.', prompt: m.cachedPrompt(['Instructions.', 'Knowledge base.'], 'The posting.') })
    assert.deepEqual(out, { answer: 'yes', score: 7 })
    assert.equal(calls.length, 1)
    const r = rows()
    assert.equal(r.length, 1)
    assert.equal(r[0].backend, 'agent')
    assert.equal(r[0].cost_usd, 0)
    assert.equal(r[0].est_cost_usd, 0.0123)
    assert.equal(r[0].input_tokens, 1000)
    assert.equal(r[0].cache_read_tokens, 400)
    assert.equal(r[0].model, 'claude-sonnet-5-5')
    assert.equal(r[0].error, null)
    assert.equal(apiRequests, 0, 'nothing went to the API key')
  })

  test('runs with no tools, no MCP, no settings, no saved session, the step model, and a json_schema output', async () => {
    await m.aiStructured(Answer, { purpose: 'match', system: 'Score it.', prompt: 'Job text', effort: 'low' })
    const o = calls[0]!.options
    assert.deepEqual(o.tools, [])
    assert.deepEqual(o.mcpServers, {})
    assert.equal(o.strictMcpConfig, true)
    assert.deepEqual(o.settingSources, [])
    assert.equal(o.permissionMode, 'dontAsk')
    assert.equal(o.persistSession, false)
    assert.ok(o.maxTurns <= 4)
    assert.equal(o.model, 'claude-haiku-5-5', 'NUXT_AI_STEP_MODELS applies')
    assert.equal(o.effort, 'low')
    assert.deepEqual(o.systemPrompt, { type: 'custom', prompt: 'Score it.' })
    assert.equal(o.outputFormat.type, 'json_schema')
    assert.deepEqual(o.outputFormat.schema.required, ['answer', 'score'])
    assert.ok(o.cwd.includes(join(dir, 'agent', 'work')), 'throwaway cwd under dataDir()')
    assert.equal(o.abortController instanceof AbortController, true)
  })

  test('thinking is off for every step unless NUXT_AGENT_THINKING names it', async () => {
    await m.aiStructured(Answer, { purpose: 'tailor', prompt: 'x' })
    assert.deepEqual(calls[0]!.options.thinking, { type: 'disabled' })
    config.agentThinking = 'tailor,cover_letter'
    await m.aiStructured(Answer, { purpose: 'tailor', prompt: 'x' })
    await m.aiStructured(Answer, { purpose: 'enrich', prompt: 'x' })
    assert.deepEqual(calls[1]!.options.thinking, { type: 'adaptive' })
    assert.deepEqual(calls[2]!.options.thinking, { type: 'disabled' })
    config.agentThinking = 'on'
    assert.equal(m.agentThinking('match'), true)
  })

  test('keeps one cache breakpoint of its own, with the 1 hour lifetime Claude Code uses', async () => {
    await m.aiStructured(Answer, { purpose: 'enrich', prompt: m.cachedPrompt(['A '.repeat(10), 'B '.repeat(10), 'C '.repeat(10)], 'varying') })
    const content = calls[0]!.message.message.content
    const marked = content.filter((b: any) => b.cache_control)
    assert.equal(marked.length, 1)
    assert.deepEqual(marked[0].cache_control, { type: 'ephemeral', ttl: '1h' })
    assert.equal(content.indexOf(marked[0]), 2, 'the end of the stable part')
  })

  test('the daily dollar budget does not stop a subscription call', async () => {
    config.dailyAiBudgetUsd = '0.01'
    db().run(m.sql`insert into ai_calls (purpose, model, cost_usd) values ('enrich', 'claude-opus-5-5', 5)`)
    assert.throws(() => m.assertAiBudget(), m.AiBudgetExceeded, 'the API key is over budget')
    assert.equal(m.aiStopError('enrich'), null, 'the subscription step may still run')
    const out = await m.aiStructured(Answer, { purpose: 'enrich', prompt: 'x' })
    assert.equal(out.answer, 'yes')
    assert.equal(m.aiSpentToday(), 5, 'the subscription call added nothing to the API spend')
  })

  test('an answer that fails the zod schema throws and is logged as a schema error', async () => {
    script = () => ok({ answer: 'yes', score: 'high' })
    await assert.rejects(m.aiStructured(Answer, { purpose: 'enrich', prompt: 'x' }), /does not match its schema/)
    const r = rows()
    assert.equal(r.length, 1)
    assert.match(r[0].error, /^schema: /)
  })

  test('aiText returns the final text', async () => {
    script = () => [{ type: 'result', subtype: 'success', is_error: false, result: '  Dear hiring team.  ', total_cost_usd: 0.002, modelUsage: {} }]
    assert.equal(await m.aiText({ purpose: 'cover_letter', prompt: 'Write it.' }), 'Dear hiring team.')
    assert.equal(calls[0]!.options.outputFormat, undefined)
    assert.equal(calls[0]!.options.model, 'claude-opus-5-5')
  })

  test('a model the subscription cannot use is tried once on the fallback model', async () => {
    script = c => c.options.model === 'claude-opus-5-5'
      ? [{ type: 'assistant', error: 'model_not_found', message: { model: '<synthetic>', content: [] } }, { type: 'result', subtype: 'success', is_error: true, api_error_status: 404, result: 'model not found', modelUsage: {} }]
      : ok({ answer: 'fallback', score: 1 })
    const out = await m.aiStructured(Answer, { purpose: 'tailor', prompt: 'x' })
    assert.equal(out.answer, 'fallback')
    assert.deepEqual(calls.map(c => c.options.model), ['claude-opus-5-5', 'claude-haiku-4-5'])
    assert.match(rows()[0].error, /^unavailable: /)
  })
})

// ── Limits ──────────────────────────────────────────────────

describe('subscription limit', () => {
  test('pauses until the reset the SDK reports, with no fallback to the API key', async () => {
    const reset = Math.floor(Date.now() / 1000) + 2 * 3600
    script = () => limited(reset)
    const err = await m.aiStructured(Answer, { purpose: 'enrich', prompt: 'x' }).catch((e: unknown) => e)
    assert.ok(err instanceof m.AiSubscriptionLimit, 'AiSubscriptionLimit')
    assert.ok(err instanceof m.AiBudgetExceeded, 'callers stop their run as at the budget')
    assert.equal(Date.parse(err.until), reset * 1000 + 30_000)
    assert.match(err.message, /^Paused: your Claude subscription limit is reached, resumes at /)
    assert.equal(apiRequests, 0, 'no request to the API key')
    assert.match(rows()[0].error, /^subscription limit reached, paused until /)
    const pause = m.activeSubscriptionPause()
    assert.ok(pause?.reported)

    // While it holds, calls fail fast without starting a process, and per-job items stop before fetching.
    await assert.rejects(m.aiStructured(Answer, { purpose: 'tailor', prompt: 'y' }), m.AiSubscriptionLimit)
    assert.equal(calls.length, 1, 'no second process')
    assert.ok(m.aiStopError('enrich') instanceof m.AiSubscriptionLimit)
    assert.equal(m.subscriptionClaimMode(), 'paused')
    assert.equal(m.subscriptionClaimMode(Date.parse(err.until) + 10_000), 'foreground')
    assert.equal(m.subscriptionClaimMode(Date.parse(err.until) + 61_000), 'free')
  })

  test('without a reported reset it backs off 15 minutes, then 30', async () => {
    script = () => limited()
    const t0 = Date.now()
    const e1 = await m.aiStructured(Answer, { purpose: 'enrich', prompt: 'x' }).catch((e: unknown) => e)
    assert.ok(Math.abs(Date.parse(e1.until) - t0 - 15 * 60_000) < 5000)
    const s = m.recordSubscriptionLimit(null, null, Date.parse(e1.until) + 1000)
    assert.ok(Math.abs(Date.parse(s.until) - Date.parse(e1.until) - 1000 - 30 * 60_000) < 5000)
    assert.equal(s.strikes, 2)
  })

  test('a call that works again clears the pause', async () => {
    m.recordSubscriptionLimit(Date.now() - 1000, null) // already over
    db().run(m.sql`update app_settings set value_json = json_set(value_json, '$.until', ${new Date(Date.now() - 1000).toISOString()}) where key = 'subscription_pause'`)
    await m.aiStructured(Answer, { purpose: 'enrich', prompt: 'x' })
    assert.equal(m.subscriptionPauseState(), null)
  })

  test('a rejected token stops calls and shows as an account problem until a call works', async () => {
    script = () => [
      { type: 'assistant', error: 'authentication_failed', message: { model: '<synthetic>', content: [] } },
      { type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'Failed to authenticate. API Error: 401 OAuth token has expired.', modelUsage: {} },
    ]
    await assert.rejects(m.aiStructured(Answer, { purpose: 'enrich', prompt: 'x' }), m.AiTokenRejected)
    const p = m.aiAccountProblem()
    assert.equal(p?.kind, 'token')
    assert.match(p.message, /NUXT_CLAUDE_CODE_OAUTH_TOKEN/)
  })
})

// ── The queue at the limit ──────────────────────────────────

describe('queue', () => {
  test('an item a limit stopped goes back in the queue for the reset; claims respect the pause and the priority window', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600
    script = () => limited(reset)
    const hb = m.enqueue(m.HEARTBEAT_TASK, {}, { trigger: 'schedule' }).item
    const mine = m.enqueue('repos:suggest', {}, { trigger: 'manual' }).item
    const bulk = m.enqueue(m.ENRICH_ONE_TASK, { jobId: 1 }, { trigger: 'chained' }).item

    // Run "mine" the way the worker does: claim it, run it in its queue context, read the flag.
    const claimed = m.claimNext('test-owner', { only: ['repos:suggest'] })
    assert.equal(claimed.id, mine.id)
    const until = await m.runInQueueContext(claimed, async () => {
      await m.aiStructured(Answer, { purpose: 'repo_judge', prompt: 'x' }).catch(() => {})
      return m.currentQueueContext()?.subscriptionPausedUntil
    })
    assert.equal(Date.parse(until), reset * 1000 + 30_000)
    m.pauseItem(claimed.id, 'test-owner', until, { background: false })
    const back = m.getItem(mine.id)
    assert.equal(back.status, 'queued')
    assert.equal(back.attempts, 0, 'a limit is not counted as an attempt')
    assert.match(back.note, /^Paused: your Claude subscription limit is reached/)
    assert.ok(Math.abs(Date.parse(`${back.runAfter.replace(' ', 'T')}Z`) - Date.parse(until)) < 1000)

    // Paused: only tasks that never call Claude.
    const first = m.claimNext('w', { ai: 'paused' })
    assert.equal(first?.id, hb.id)
    assert.equal(m.claimNext('w', { ai: 'paused' }), null)
    // Right after the reset: Devin's item before the background one.
    m.useDb().run(m.sql`update task_queue set run_after = '2000-01-01 00:00:00' where status = 'queued'`)
    assert.equal(m.claimNext('w', { ai: 'foreground' })?.id, mine.id)
    assert.equal(m.claimNext('w', { ai: 'foreground' }), null, 'the per-job item waits out the window')
    assert.equal(m.claimNext('w', { ai: 'free' })?.id, bulk.id)
  })

  test('only work the limit stopped goes back; a task that caught the limit and finished stays done', async () => {
    const until = new Date(Date.now() + 3600_000).toISOString()
    const done = { status: 'done', result: { runId: 1, status: 'succeeded' } }
    assert.equal(m.pausedByLimit({ task: 'applications:prepare-one' }, done, until), false, 'finished anyway')
    assert.equal(m.pausedByLimit({ task: 'applications:prepare-one' }, done, undefined), false, 'no limit met')
    assert.equal(m.pausedByLimit({ task: 'applications:prepare-one' }, { status: 'failed', error: 'x' }, until), true, 'threw')
    assert.equal(m.pausedByLimit({ task: m.MATCH_ONE_TASK }, { status: 'done', result: { jobId: 1, outcome: 'budget' } }, until), true, 'per-job item stopped')
    assert.equal(m.pausedByLimit({ task: m.MATCH_ONE_TASK }, { status: 'done', result: { jobId: 1, outcome: 'scored' } }, until), false, 'per-job item finished')
    assert.equal(m.pausedByLimit({ task: m.APPROVE_TASK }, { status: 'failed', error: 'x' }, until), false, 'never an approval')
    assert.equal(m.pausedByLimit({ task: 'repos:suggest' }, 'waiting', until), false)

    // A real run: the task swallows the limit (as the condense step does) and returns normally.
    script = () => limited(Math.floor(Date.now() / 1000) + 3600)
    const swallowed = await m.runInQueueContext({ ...m.enqueue('applications:prepare-one', { applicationId: 1 }).item, attempts: 0 }, async () => {
      const res = await m.withRun('applications:prepare-one', 'manual', async () => {
        await m.aiStructured(Answer, { purpose: 'form_answers_condense', prompt: 'x' }).catch(() => null)
        return { applicationId: 1, status: 'proposed' }
      }, { lockKey: 'test-swallow' })
      return { outcome: m.itemOutcomeFromRun(res), until: m.currentQueueContext()?.subscriptionPausedUntil }
    })
    assert.ok(swallowed.until, 'the limit was met')
    assert.equal(m.pausedByLimit({ task: 'applications:prepare-one' }, swallowed.outcome, swallowed.until), false, 'the finished preparation is not run again')

    // The same task stopped by the limit: its run records the stop and it goes back.
    m.useDb().run(m.sql`delete from app_settings where key = 'subscription_pause'`)
    const stopped = await m.runInQueueContext({ ...m.enqueue('applications:prepare-one', { applicationId: 2 }).item, attempts: 0 }, async () => {
      const res = await m.withRun('applications:prepare-one', 'manual', async () => {
        await m.aiStructured(Answer, { purpose: 'tailor', prompt: 'x' })
        return { applicationId: 2, status: 'proposed' }
      }, { lockKey: 'test-stop' })
      return { outcome: m.itemOutcomeFromRun(res), until: m.currentQueueContext()?.subscriptionPausedUntil }
    })
    assert.equal(stopped.outcome.result.stoppedAtLimit, true)
    assert.equal(m.pausedByLimit({ task: 'applications:prepare-one' }, stopped.outcome, stopped.until), true)
  })

  test('a background item waits a minute longer after the reset', () => {
    const item = m.enqueue(m.MATCH_ONE_TASK, { jobId: 2 }, { trigger: 'chained' }).item
    m.claimNext('o', {})
    const until = new Date(Date.now() + 3600_000).toISOString()
    m.pauseItem(item.id, 'o', until, { background: true })
    const back = m.getItem(item.id)
    // run_after is stored to the second
    assert.ok(Math.abs(Date.parse(`${back.runAfter.replace(' ', 'T')}Z`) - (Date.parse(until) + 60_000)) < 1000)
  })

  test('a run the limit stopped reads paused, not failed', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600
    script = () => limited(reset)
    const item = m.enqueue('repos:suggest', {}, { trigger: 'manual' }).item
    const claimed = m.claimNext('o', { only: ['repos:suggest'] })
    const res = await m.runInQueueContext(claimed, () => m.withRun('repos:suggest', 'manual', async () => {
      await m.aiStructured(Answer, { purpose: 'repo_judge', prompt: 'x' })
      return { judged: 1 }
    }))
    assert.equal(res.status, 'succeeded')
    assert.equal(res.stats.stopReason, 'subscription')
    const problems = m.runProblems({ task: 'repos:suggest', status: 'succeeded', stats: res.stats })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /^paused: Claude subscription limit reached, resumes at (\w{3} )?\d{1,2}:\d{2}/)
    assert.ok(item)
  })
})

// ── This app's own limit on the subscription ────────────────

/** One call on the subscription that cost `usd` (the SDK's estimate), made `ago` before now ("-3 days"). */
function spend(usd: number, ago = '+0 seconds') {
  db().run(m.sql`insert into ai_calls (purpose, model, backend, est_cost_usd, cost_usd, created_at) values ('tailor', 'claude-sonnet-5-5', 'agent', ${usd}, 0, datetime('now', ${ago}))`)
}

/** Claims the item `enqueue()` just made and runs `fn` in its queue context, as the worker does. */
async function asItem<T>(task: string, payload: Record<string, unknown>, trigger: string, fn: () => Promise<T>): Promise<T> {
  const item = m.enqueue(task, payload, { trigger }).item
  const claimed = m.claimNext('limit-test', { only: [task] })
  assert.equal(claimed?.id, item.id)
  return m.runInQueueContext(claimed, fn)
}

const isoNear = (a: string, b: number, ms = 5000) => Math.abs(Date.parse(a) - b) < ms

describe('this app\'s subscription limit', () => {
  test('defaults to $15 a day and $105 (seven days of it) over 7 days; the environment is the first default and Settings win', () => {
    assert.deepEqual(m.subscriptionLimits(), { dailyUsd: 15, weekUsd: 105, fromSettings: false })
    config.subscriptionDailyLimitUsd = '20'
    assert.equal(m.subscriptionLimits().dailyUsd, 20)
    m.saveSubscriptionLimits({ dailyUsd: 5, weekUsd: 30 })
    assert.deepEqual(m.subscriptionLimits(), { dailyUsd: 5, weekUsd: 30, fromSettings: true })
    assert.throws(() => m.cleanLimit('0', 'daily limit'), /above \$0/)
    assert.throws(() => m.cleanLimit('abc', 'daily limit'), /above \$0/)
    assert.throws(() => m.cleanLimit('', 'daily limit'), /above \$0/)
    assert.throws(() => m.cleanLimit(10_001, '7-day limit'), /at most \$10,000/)
    assert.equal(m.cleanLimit('12.345', 'daily limit'), 12.35)
  })

  test('at the daily limit every call stops before a process starts, naming the limit and where to raise it', async () => {
    spend(15.5)
    const err = await m.aiStructured(Answer, { purpose: 'tailor', prompt: 'x' }).catch((e: unknown) => e)
    assert.ok(err instanceof m.AiAppLimitReached)
    assert.ok(err instanceof m.AiBudgetExceeded, 'callers stop their run as at the budget')
    assert.equal(err.kind, 'app_daily')
    assert.match(err.message, /^This app's daily Claude limit is reached \(est\. \$15\.50 of \$15\.00 today\)\. Claude calls resume at midnight\. Raise the limit in Settings > Claude usage/)
    assert.equal(err.until, m.nextMidnight())
    assert.ok(Date.parse(err.until) > Date.now() && Date.parse(err.until) <= Date.now() + 25 * 3600_000)
    assert.equal(calls.length, 0, 'no Claude Code process started')
    assert.equal(apiRequests, 0, 'nothing went to the API key instead')
    assert.ok(m.aiStopError('match_gaps') instanceof m.AiAppLimitReached, 'a per-job item checks it before fetching')
    assert.doesNotThrow(() => m.assertAiBudget(), 'the API key budget is a separate count')
    // The chat says it in its own words, with no API key advice.
    const chat = m.stopFor(err)
    assert.equal(chat.stop, 'budget')
    assert.match(chat.message, /daily Claude limit is reached .* paused until midnight\. Raise the limit in Settings > Claude usage/)
    assert.doesNotMatch(chat.message, /NUXT_DAILY_AI_BUDGET_USD/)
  })

  test('background work stops at 70% of the daily limit; what Devin starts can use the rest', async () => {
    spend(11) // 73% of $15
    // A chat or a draft (no queue item): runs.
    await m.aiStructured(Answer, { purpose: 'question_chat', prompt: 'x' })
    // Something Devin queued: runs.
    await asItem('repos:suggest', {}, 'manual', () => m.aiStructured(Answer, { purpose: 'repo_judge', prompt: 'x' }))
    assert.equal(calls.length, 2)
    // A per-job item (whoever queued it) and a scheduled step: stop.
    const bulk = await asItem(m.MATCH_ONE_TASK, { jobId: 1 }, 'manual', () => m.aiStructured(Answer, { purpose: 'match_gaps', prompt: 'x' }).catch((e: unknown) => e))
    assert.ok(bulk instanceof m.AiAppLimitReached)
    assert.equal(bulk.kind, 'app_background')
    assert.match(bulk.message, /^Background work paused at 70% of this app's daily Claude limit \(est\. \$11\.02 of \$15\.00 today\)\./, 'the $11 plus the two calls that went out')
    const scheduled = await asItem('learn:daily', {}, 'schedule', () => m.aiStructured(Answer, { purpose: 'learn', prompt: 'x' }).catch((e: unknown) => e))
    assert.ok(scheduled instanceof m.AiAppLimitReached)
    assert.equal(calls.length, 2, 'neither started a process')
    // The dashboard shows the background stop in amber.
    const view = m.subscriptionStatusView()
    assert.equal(view.stop?.kind, 'app_background')
    assert.equal(view.limits.backgroundSharePct, 70)
    assert.equal(view.spent.today.estUsd, 11 + 2 * 0.0123)
    assert.equal(m.appLimitPauseText(view.stop.kind, view.stop.until, { sharePct: 70 }), 'Paused: background work is at 70% of this app\'s daily Claude limit, resumes at midnight')
    assert.equal(m.queueSnapshot().backlog.budgetStopped, true, 'the backlog line says it resumes when the limit allows')
  })

  test('the 7-day limit stops every call until enough of the oldest spend leaves the window', async () => {
    spend(60, '-6 days')
    spend(60, '-2 days')
    const err = await m.aiStructured(Answer, { purpose: 'tailor', prompt: 'x' }).catch((e: unknown) => e)
    assert.ok(err instanceof m.AiAppLimitReached)
    assert.equal(err.kind, 'app_week')
    assert.match(err.message, /^This app's 7-day Claude limit is reached \(est\. \$120\.00 of \$105\.00 in the last 7 days\)\. Claude calls resume at (\w{3} )?\d{1,2}:\d{2} [AP]M\. Raise the limit in Settings > Claude usage/)
    // Dropping the call made 6 days ago leaves $60, under $105: that happens in one day.
    assert.ok(isoNear(err.until, Date.now() + 86_400_000), `until ${err.until}`)
    assert.equal(calls.length, 0)
    assert.equal(m.stopFor(err).stop, 'budget')
    assert.match(m.stopFor(err).message, /7-day Claude limit is reached .* paused until /)
    // A higher limit lets calls go out again at once.
    m.saveSubscriptionLimits({ dailyUsd: 15, weekUsd: 150 })
    await m.aiStructured(Answer, { purpose: 'tailor', prompt: 'x' })
    assert.equal(calls.length, 1)
  })

  test('an item the limit stopped goes back in the queue with the limit\'s note, after midnight, attempts not counted', async () => {
    spend(11)
    const item = m.enqueue(m.MATCH_ONE_TASK, { jobId: 9 }, { trigger: 'chained' }).item
    const claimed = m.claimNext('w', { only: [m.MATCH_ONE_TASK] })
    const r = await m.runInQueueContext(claimed, async () => {
      // As scoreOne does: the budget error ends the job 'budget', and it stays waiting.
      const outcome = await m.aiStructured(Answer, { purpose: 'match_gaps', prompt: 'x' })
        .then(() => ({ status: 'done', result: { jobId: 9, outcome: 'scored' } }))
        .catch((e: any) => ({ status: 'done', result: { jobId: 9, outcome: 'budget', error: e.message } }))
      const ctx = m.currentQueueContext()
      return { outcome, until: ctx.subscriptionPausedUntil, note: ctx.subscriptionStopNote, kind: ctx.subscriptionStopKind, background: m.isBackgroundWork() }
    })
    assert.equal(r.kind, 'app_background')
    assert.equal(r.until, m.nextMidnight())
    assert.equal(m.pausedByLimit(claimed, r.outcome, r.until), true)
    m.pauseItem(claimed.id, 'w', r.until, { background: r.background, note: r.note })
    const back = m.getItem(item.id)
    assert.equal(back.status, 'queued')
    assert.equal(back.attempts, 0, 'a limit is not counted as an attempt')
    assert.equal(back.note, 'Paused: background work is at 70% of this app\'s daily Claude limit, resumes at midnight')
    assert.ok(isoNear(`${back.runAfter.replace(' ', 'T')}Z`, Date.parse(r.until) + 60_000, 1500), 'background work waits a minute past midnight')
    assert.match(m.queueItemText({ status: 'queued', label: 'Score a job', step: null, note: back.note, attempts: 0 }), /^Paused: Score a job; background work is at 70%/)
    // A step waiting on per-job items does not wait for one the limit put back.
    assert.deepEqual(m.perJobQueueCounts([m.MATCH_ONE_TASK]), { running: 0, due: 0, deferred: 1, note: back.note })
    // An item queued for later without a limit's note is still waited for.
    const later = m.enqueue(m.ENRICH_ONE_TASK, { jobId: 10 }, { trigger: 'chained', runAfter: new Date(Date.now() + 3600_000) }).item
    assert.deepEqual(m.perJobQueueCounts([m.ENRICH_ONE_TASK]), { running: 0, due: 1, deferred: 0, note: null })
    db().run(m.sql`delete from task_queue where id = ${later.id}`)
    // Raising the limit in Settings lets it run now.
    m.saveSubscriptionLimits({ dailyUsd: 50, weekUsd: 200 })
    assert.equal(m.releaseAppLimitItems(), 1)
    const released = m.getItem(item.id)
    assert.equal(released.note, null)
    assert.equal(m.perJobQueueCounts([m.MATCH_ONE_TASK]).due, 1)
  })

  test('a run the limit stopped reads partial with the reason; a manual step whose per-job items it stopped finishes', async () => {
    spend(16)
    const res = await asItem('repos:suggest', {}, 'manual', async () => {
      const run = await m.withRun('repos:suggest', 'manual', async () => {
        await m.aiStructured(Answer, { purpose: 'repo_judge', prompt: 'x' })
        return { judged: 1 }
      })
      return { run, until: m.currentQueueContext().subscriptionPausedUntil }
    })
    assert.equal(res.run.status, 'succeeded', 'paused, not failed')
    assert.equal(res.run.stats.stopReason, 'app_daily')
    const problems = m.runProblems({ task: 'repos:suggest', status: 'succeeded', stats: res.run.stats })
    assert.deepEqual(problems, ['paused: this app\'s daily Claude limit reached, continues after midnight'])
    assert.equal(m.runOutcome({ task: 'repos:suggest', status: 'succeeded', stats: res.run.stats }, problems), 'partial')
    const outcome = m.itemOutcomeFromRun(res.run)
    assert.equal(outcome.result.stoppedAtLimit, true)
    assert.equal(m.pausedByLimit({ task: 'repos:suggest' }, outcome, res.until), true, 'the item goes back for midnight')
    // The 7-day stop names when it lifts.
    const week = m.runProblems({ task: 'jobs:match', status: 'succeeded', stats: { budgetStopped: true, stopReason: 'app_week', pausedUntil: new Date(Date.now() + 3600_000).toISOString() } })
    assert.match(week[0], /^paused: this app's 7-day Claude limit reached, resumes at (\w{3} )?\d{1,2}:\d{2}/)

    // Score matches started by hand at the background share: its per-job items stop (they are
    // background work) and go back for midnight; the step stops waiting for them and reads partial.
    db().run(m.sql`delete from ai_calls`)
    db().run(m.sql`delete from task_queue`)
    spend(11)
    m.enqueue(m.MATCH_ONE_TASK, { jobId: 5 }, { trigger: 'chained', runAfter: new Date(Date.now() + 3600_000) })
    db().run(m.sql`update task_queue set note = 'Paused: background work is at 70% of this app''s daily Claude limit, resumes at midnight'`)
    const step = await asItem('jobs:match', {}, 'manual', async () => {
      const run = await m.withRun('jobs:match', 'manual', log => m.matchStep({}, log))
      return { run, until: m.currentQueueContext().subscriptionPausedUntil }
    })
    assert.equal(step.run.status, 'succeeded')
    assert.equal(step.run.stats.budgetStopped, true)
    assert.equal(step.run.stats.stopReason, 'app_background')
    assert.ok(step.run.stats.errors.some((e: string) => e.startsWith('Paused: background work is at 70%')))
    assert.equal(step.until, undefined, 'the step itself met no stop')
    assert.equal(m.pausedByLimit({ task: 'jobs:match' }, m.itemOutcomeFromRun(step.run), step.until), false, 'so it finishes instead of waiting until midnight')
  })

  test('the Where it went table adds API dollars and the subscription estimate, and says which rows hold subscription calls', () => {
    spend(1.25) // purpose tailor: Prepare after Apply, on the subscription
    db().run(m.sql`insert into ai_calls (purpose, model, backend, cost_usd, est_cost_usd) values ('tailor', 'claude-sonnet-5-5', 'api', 0.5, 0)`)
    db().run(m.sql`insert into ai_calls (purpose, model, backend, cost_usd, est_cost_usd) values ('enrich', 'claude-sonnet-5-5', 'api', 0.25, 0)`)
    const costs = m.aiStageCosts()
    const prepare = costs.stages.find((s: any) => s.key === 'prepare')
    const read = costs.stages.find((s: any) => s.key === 'read')
    assert.deepEqual(prepare.today, { costUsd: 1.75, calls: 2, subscriptionCalls: 1 })
    assert.deepEqual(read.today, { costUsd: 0.25, calls: 1, subscriptionCalls: 0 })
    // The rows add up to the subscription bar plus the API key's spend.
    const total = costs.stages.reduce((n: number, s: any) => n + s.today.costUsd, 0)
    assert.equal(Math.round(total * 100) / 100, Math.round((m.subscriptionSpend().today.estUsd + m.aiSpentToday()) * 100) / 100)
  })

  test('an approval is never stopped by the limit and never put back', async () => {
    spend(16)
    await asItem(m.APPROVE_TASK, { applicationId: 1 }, 'manual', () => m.aiStructured(Answer, { purpose: 'form_answers', prompt: 'x' }))
    assert.equal(calls.length, 1, 'the call inside the approval went out')
    assert.equal(m.pausedByLimit({ task: m.APPROVE_TASK }, { status: 'failed', error: 'x' }, new Date(Date.now() + 3600_000).toISOString()), false)
  })
})

// ── Concurrency ─────────────────────────────────────────────

describe('concurrency', () => {
  test('at most NUXT_AGENT_CONCURRENCY processes at once, and a call Devin waits on goes before background calls', async () => {
    config.agentConcurrency = '2'
    let running = 0
    let peak = 0
    const order: string[] = []
    script = async (c) => {
      running++
      peak = Math.max(peak, running)
      order.push(c.message.message.content)
      await new Promise(r => setTimeout(r, 60))
      running--
      return ok({ answer: 'a', score: 1 })
    }
    const run = (name: string, foreground: boolean) => m.runAgentQuery({ purpose: 'enrich', model: 'claude-sonnet-5-5', system: '', prompt: name, jsonSchema: { type: 'object' }, foreground })
    const all = [run('bg1', false), run('bg2', false), run('bg3', false), run('bg4', false)]
    await new Promise(r => setTimeout(r, 10))
    all.push(run('fg', true))
    await Promise.all(all)
    assert.equal(peak, 2)
    assert.deepEqual(order.slice(0, 3), ['bg1', 'bg2', 'fg'])
    assert.deepEqual(m.agentSlots(), { running: 0, waiting: 0, max: 2 })
  })
})

// ── The token stays secret ──────────────────────────────────

describe('token', () => {
  test('reaches the SDK only as CLAUDE_CODE_OAUTH_TOKEN in the child environment, and never logs, errors, rows, or API views', async () => {
    const logged: string[] = []
    const saved = { log: console.log, warn: console.warn, error: console.error }
    for (const k of ['log', 'warn', 'error'] as const) console[k] = (...a: unknown[]) => logged.push(a.map(String).join(' '))
    process.env.ANTHROPIC_BASE_URL = 'http://proxy.invalid'
    process.env.NUXT_GITHUB_TOKEN = 'ghp_should_not_leak'
    let err: any
    try {
      await m.aiStructured(Answer, { purpose: 'enrich', prompt: 'x' })
      script = () => [new Error(`spawn failed: env CLAUDE_CODE_OAUTH_TOKEN=${TOKEN} rejected`)]
      err = await m.aiStructured(Answer, { purpose: 'tailor', prompt: 'y' }).catch((e: unknown) => e)
    }
    finally {
      Object.assign(console, saved)
      delete process.env.ANTHROPIC_BASE_URL
      delete process.env.NUXT_GITHUB_TOKEN
    }
    const { env, ...rest } = calls[0]!.options
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN)
    assert.ok(!JSON.stringify(rest).includes(TOKEN), 'not in any other option (argv is built from these)')
    for (const key of Object.keys(env)) {
      if (key === 'CLAUDE_CODE_OAUTH_TOKEN') continue
      assert.ok(!String(env[key]).includes(TOKEN), key)
    }
    assert.equal(env.ANTHROPIC_BASE_URL, undefined, 'the server environment is not inherited')
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
    assert.equal(env.NUXT_GITHUB_TOKEN, undefined)
    assert.ok(err instanceof Error)
    assert.ok(!String(err.message).includes(TOKEN), 'error message')
    assert.ok(!logged.join('\n').includes(TOKEN), 'console output')
    assert.ok(!JSON.stringify(rows()).includes(TOKEN), 'ai_calls')
    assert.ok(rows().some(r => String(r.error).includes('[token]')), 'redacted, not dropped')
    const views = JSON.stringify([(globalThis as any).aiStageCosts(), m.aiAccountProblem(), m.subscriptionPauseView(), m.queueSnapshot()])
    assert.ok(!views.includes(TOKEN), 'dashboard API views')
  })
})

// ── The real binary against the fake API ────────────────────

describe('real Claude Code binary', () => {
  test('one structured call: token sent as a Bearer header only, never in argv; the process exits', async (t) => {
    if (!m.claudeCodeBinary()) return t.skip('Claude Code binary not installed')
    const api = await startFakeApi({ expectedToken: TOKEN })
    const spawned: Array<{ pid?: number; args: string[]; env: Record<string, string | undefined> }> = []
    m.setAgentTestHooks({ extraEnv: { ANTHROPIC_BASE_URL: api.url }, onSpawn: (s: any) => spawned.push(s) })
    try {
      const out = await m.aiStructured(Answer, { purpose: 'enrich', system: 'Answer.', prompt: m.cachedPrompt(['Stable.'], 'Varying.') })
      assert.equal(typeof out.answer, 'string')
      assert.equal(typeof out.score, 'number')
      assert.equal(spawned.length, 1)
      assert.ok(!spawned[0]!.args.join(' ').includes(TOKEN), 'argv')
      assert.equal(spawned[0]!.env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN)
      const msgs = api.requests.filter(r => r.path.startsWith('/v1/messages'))
      assert.equal(msgs.length, 1)
      assert.equal(msgs[0]!.auth, 'Bearer')
      assert.ok(msgs[0]!.sentExpectedToken)
      assert.ok(!JSON.stringify(msgs[0]!.body).includes(TOKEN), 'not in the request body')
      assert.equal(msgs[0]!.body.max_tokens, 16000, 'the output cap reaches the request (Claude Code defaults to 128000)')
      assert.equal(msgs[0]!.body.model, 'claude-sonnet-5-5', 'the step model from NUXT_AI_STEP_MODELS')
      // Sonnet 5.5 thinks adaptively whatever the option says, as it does on the API key path.
      assert.equal(msgs[0]!.body.thinking?.type, 'adaptive')
      // On the fallback model the setting decides: off sends disabled (the API key path sends no
      // thinking there), on lets Claude Code add its thinking budget. Both, so the check can tell.
      await m.aiStructured(Answer, { purpose: 'enrich', model: 'claude-haiku-4-5', prompt: 'Haiku, off.' })
      config.agentThinking = 'enrich'
      await m.aiStructured(Answer, { purpose: 'enrich', model: 'claude-haiku-4-5', prompt: 'Haiku, on.' })
      const [, off, on] = api.requests.filter(r => r.path.startsWith('/v1/messages'))
      assert.equal(off!.body.model, 'claude-haiku-4-5')
      assert.deepEqual(off!.body.thinking, { type: 'disabled' })
      assert.equal(on!.body.thinking?.type, 'enabled')
      const breakpoints = JSON.stringify(msgs[0]!.body).match(/"cache_control"/g)?.length ?? 0
      assert.ok(breakpoints <= 4, `at most 4 cache breakpoints (saw ${breakpoints})`)
      assert.deepEqual(msgs[0]!.body.tools.map((x: any) => x.name).filter((n: string) => n !== 'DeferredToolPlaceholder'), ['StructuredOutput'])
      const pid = spawned[0]!.pid!
      assert.throws(() => process.kill(pid, 0), 'the process has exited')
    }
    finally {
      m.setAgentTestHooks({ query: stubQuery as any })
      await api.close()
    }
  })
})
