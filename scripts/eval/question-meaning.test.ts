// Unit tests for the question meaning check (server/utils/question-meaning.ts) and the one-time
// repair that groups existing questions by meaning.
//
//   npm run test:meaning
//
// Claude is a stub: the Agent SDK's query() is replaced (setAgentTestHooks), so no Claude Code
// process starts and no request leaves the machine. Each test says what the stub answers. The app's
// server code runs outside Nitro through scripts/eval/globals.ts, on a fresh database file in a
// temporary directory.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { setupGlobals } from './globals'

const dir = mkdtempSync(join(tmpdir(), 'question-meaning-test-'))

const config: Record<string, unknown> = {
  databasePath: join(dir, 'job-hunter.db'),
  anthropicApiKey: '',
  aiModel: 'claude-opus-5-5',
  aiFallbackModel: 'claude-haiku-4-5',
  aiStepModels: '',
  aiStepBackends: '',
  claudeCodeOauthToken: 'sk-ant-oat01-TEST-ONLY-token-not-real',
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

interface StubCall { options: any; text: string }
const calls: StubCall[] = []
/** What Claude answers: the structured output, or an Error to fail the call, or 'limit' for a subscription limit. */
let respond: (call: StubCall) => unknown = () => ({ decisions: [] })

function result(structured: unknown) {
  return [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { model: 'claude-haiku-4-5', content: [] } },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify(structured),
      structured_output: structured,
      total_cost_usd: 0.001,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: { 'claude-haiku-4-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 } },
    },
  ]
}

const LIMIT = [
  { type: 'system', subtype: 'init' },
  { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' } },
  { type: 'assistant', error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: 'You\'ve hit your 5-hour limit' }] } },
  { type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'You\'ve hit your 5-hour limit', total_cost_usd: 0, usage: {}, modelUsage: {} },
  new Error('Claude Code returned an error result: You\'ve hit your 5-hour limit'),
]

function stubQuery({ prompt, options }: { prompt: any; options?: any }) {
  const iter = (async function* () {
    let message: any = null
    if (typeof prompt === 'string') message = { message: { role: 'user', content: prompt } }
    else for await (const msg of prompt) message = msg
    const call = { options, text: `${JSON.stringify(options?.systemPrompt ?? '')}\n${JSON.stringify(message)}` }
    calls.push(call)
    const answer = respond(call)
    const msgs = answer === 'limit' ? LIMIT : answer instanceof Error ? [{ type: 'system', subtype: 'init' }, answer] : result(answer)
    for (const msg of msgs) {
      if (msg instanceof Error) throw msg
      yield msg
    }
  })() as any
  iter.close = () => {}
  return iter
}

/** The stub's decision for each new item: maps the item's subject to "Q<id>", "N<k>", or "none". */
function decide(bySubject: Record<string, string>) {
  return (call: StubCall) => {
    const items = [...call.text.matchAll(/N(\d+): (.+?) \| asked/g)]
    return { decisions: items.map(([, n, subject]) => ({ item: `N${n}`, match: bySubject[subject!] ?? 'none', reason: 'stub' })) }
  }
}

// ── Helpers ─────────────────────────────────────────────────

function db() {
  return m.useDb()
}

function ask(subject: string, kind: 'knows' | 'has_done' = 'knows', extra: Record<string, unknown> = {}) {
  return m.askQuestion({ question: kind === 'knows' ? `Have you used ${subject} in a real project?` : `Have you done ${subject}?`, kind, subject, answerType: 'yes_no', context: `An open job asks for ${subject}. Your answer goes into your knowledge base.`, ...extra })
}

function askChecked(subject: string, kind: 'knows' | 'has_done' = 'knows', extra: Record<string, unknown> = {}) {
  return m.askSkillQuestion({ question: kind === 'knows' ? `Have you used ${subject} in a real project?` : `Have you done ${subject}?`, kind, subject, answerType: 'yes_no', context: `An open job asks for ${subject}. Your answer goes into your knowledge base.`, ...extra })
}

function row(id: number) {
  return db().select().from(m.questions).where(m.eq(m.questions.id, id)).get()
}

function answer(id: number, value: string) {
  db().update(m.questions).set({ status: 'answered', answer: value, answeredAt: m.nowSql() }).where(m.eq(m.questions.id, id)).run()
}

function appSkip(id: number) {
  db().update(m.questions).set({ status: 'skipped', context: 'Skipped by the app: a test reason.' }).where(m.eq(m.questions.id, id)).run()
}

function count(): number {
  return db().all(m.sql`select count(*) as n from questions`)[0].n
}

function decisions(): Record<string, { match: string }> {
  return m.meaningDecisions()
}

before(async () => {
  await setupGlobals(config as any)
  m = {
    ...(await import('../../server/utils/questions')),
    ...(await import('../../server/utils/question-meaning')),
    ...(await import('../../server/utils/agent-backend')),
    ...(await import('../../server/utils/ai')),
    ...(await import('../../server/utils/review')),
  }
  const orm = await import('drizzle-orm')
  m.sql = orm.sql
  m.eq = orm.eq
  m.questions = (await import('../../server/db/schema')).questions
  m.useDb = (globalThis as any).useDb
  m.setAgentTestHooks({ query: stubQuery as any })
})

after(() => {
  m.setAgentTestHooks({})
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  calls.length = 0
  m.resetAiAccountStops()
  db().run(m.sql`delete from questions`)
  db().run(m.sql`delete from app_settings`)
  db().run(m.sql`delete from ai_calls`)
  db().run(m.sql`delete from task_queue`)
  respond = () => ({ decisions: [] })
})

// ── Tests ───────────────────────────────────────────────────

describe('the meaning check', () => {
  test('Claude names the existing question: the new wording reuses it, and the decision is stored', async () => {
    const assisted = ask('AI-assisted')
    respond = decide({ 'AI-first': `Q${assisted.id}` })
    const before = count()
    const got = await askChecked('AI-first')
    assert.equal(got.id, assisted.id)
    assert.equal(count(), before, 'no question was created')
    assert.equal(calls.length, 1)
    assert.match(calls[0]!.text, /question_same_subject|EXISTING QUESTIONS/)
    assert.equal(decisions()[m.meaningKey('AI-first')]?.match, `Q${assisted.id}`)
  })

  test('a stored decision asks nothing: the same subject again, asked the other way, makes no call', async () => {
    const assisted = ask('AI-assisted')
    respond = decide({ 'AI-first': `Q${assisted.id}` })
    await askChecked('AI-first')
    assert.equal(calls.length, 1)
    const again = await askChecked('AI-first', 'has_done')
    assert.equal(again.id, assisted.id)
    assert.equal(calls.length, 1, 'the second ask used the stored decision')
  })

  test('the exact checks come first: the same skill with a qualifier makes no call', async () => {
    const assisted = ask('AI-assisted')
    respond = () => { throw new Error('the stub should not be called') }
    const got = await askChecked('Use AI-assisted')
    assert.equal(got.id, assisted.id)
    assert.equal(calls.length, 0)
  })

  test('Claude says none: a new question, even where the word match would have merged', async () => {
    const existing = ask('Delivery guarantees and idempotency', 'has_done')
    assert.equal(m.sameSkill('Idempotency and delivery guarantees', existing.subject), true, 'control: the word match reads these as one')
    respond = decide({})
    const got = await askChecked('Idempotency and delivery guarantees', 'has_done')
    assert.notEqual(got.id, existing.id)
    assert.equal(calls.length, 1)
    assert.equal(decisions()['idempotency and delivery guarantees']?.match, 'none')
  })

  test('a failed call falls back to the word match and stores nothing', async () => {
    const existing = ask('Delivery guarantees and idempotency', 'has_done')
    respond = () => new Error('Claude Code exited with code 1')
    const got = await askChecked('Idempotency and delivery guarantees', 'has_done')
    assert.equal(got.id, existing.id, 'the word match decided')
    assert.equal(calls.length, 1)
    assert.equal(decisions()['idempotency and delivery guarantees'], undefined)
  })

  test('a budget-stopped call (the subscription limit) falls back to the word match and never blocks asking', async () => {
    const existing = ask('Delivery guarantees and idempotency', 'has_done')
    respond = () => 'limit'
    const got = await askChecked('Idempotency and delivery guarantees', 'has_done')
    assert.equal(got.id, existing.id)
    const check = await m.checkSameMeaning([{ subject: 'Retries and backoff', kind: 'has_done', question: 'Have you built retries?' }])
    assert.match(check.error ?? '', /limit/i, 'the pause stops the next call before it starts')
    assert.equal(calls.length, 1, 'no process was started while the pause holds')
    const fresh = await askChecked('Retries and backoff', 'has_done')
    assert.equal(fresh.status, 'pending', 'still asked')
    assert.equal(Object.keys(decisions()).length, 0)
  })

  test('items in one call can match each other: the second new wording reuses the first one\'s question', async () => {
    ask('Docker')
    respond = decide({ 'AI-native': 'none', 'AI-collaborative': 'N1' })
    const check = await m.checkSameMeaning([
      { subject: 'AI-native', kind: 'knows', question: 'Have you used AI-native in a real project?' },
      { subject: 'AI-collaborative', kind: 'knows', question: 'Have you used AI-collaborative in a real project?' },
    ])
    assert.equal(check.called, true)
    assert.equal(calls.length, 1, 'one call for both')
    const first = ask('AI-native')
    const second = ask('AI-collaborative')
    assert.equal(second.id, first.id)
  })
})

describe('what never merges, whatever Claude says', () => {
  test('two different tools: React and Vue', async () => {
    const react = ask('React')
    respond = decide({ Vue: `Q${react.id}` })
    const vue = await askChecked('Vue')
    assert.notEqual(vue.id, react.id)
    assert.equal(decisions()['vue']?.match, 'none')
  })

  test('two different tools: Docker and Kubernetes', async () => {
    const docker = ask('Docker')
    respond = decide({ Kubernetes: `Q${docker.id}` })
    assert.notEqual((await askChecked('Kubernetes')).id, docker.id)
  })

  test('a question naming several tools and a question about one of them', async () => {
    const fastapi = ask('Python FastAPI')
    respond = decide({ 'FastAPI or Flask': `Q${fastapi.id}` })
    assert.notEqual((await askChecked('FastAPI or Flask')).id, fastapi.id)
  })

  test('interest against having done it', async () => {
    const done = ask('Fintech and payments', 'has_done', { context: 'Toast asks for: Fintech and payments experience. The knowledge base does not say.' })
    respond = decide({ 'Fintech and payments interest': `Q${done.id}` })
    const interest = await askChecked('Fintech and payments interest', 'has_done', { question: 'Are you interested in fintech and payments?', context: 'Privacy asks for: Interest in fintech and payments. The knowledge base does not say.' })
    assert.notEqual(interest.id, done.id)
  })

  test('a fact question is never a match: only skill and experience questions are listed', async () => {
    const fact = m.askQuestion({ question: 'Are you legally authorized to work in the United States?', kind: 'fact', subject: 'US work authorization', answerType: 'yes_no' })
    ask('Docker')
    respond = decide({ 'Work authorization in the US': `Q${fact.id}` })
    const got = await askChecked('Work authorization in the US', 'has_done')
    assert.notEqual(got.id, fact.id)
    assert.equal(got.kind, 'has_done')
    assert.doesNotMatch(calls[0]!.text, new RegExp(`Q${fact.id}\\b`), 'the fact question is not in the list')
  })

  test('the guard holds for the tidy too: a stored decision naming a different tool is not merged', async () => {
    const react = ask('React')
    const vue = ask('Vue')
    respond = decide({ Vue: `Q${react.id}` })
    await m.tidyKnowsQuestions()
    assert.equal(row(vue.id).status, 'pending')
  })
})

describe('the tidy', () => {
  test('merges an open question into an older one Claude says asks the same claim, and keeps the older wording', async () => {
    const assisted = ask('AI-assisted')
    const coding = ask('AI coding')
    respond = decide({ 'AI coding': `Q${assisted.id}` })
    const r = await m.tidyKnowsQuestions()
    assert.equal(r.merged, 1)
    assert.equal(row(coding.id).status, 'skipped')
    assert.match(row(coding.id).context, new RegExp(`^Merged into question #${assisted.id}`))
    assert.equal(row(assisted.id).subject, 'AI-assisted', 'not renamed after the merged wording')
    calls.length = 0
    await m.tidyKnowsQuestions()
    assert.equal(calls.length, 0, 'a second tidy asks nothing')
  })

  test('never merges into a newer open question', async () => {
    const older = ask('AI coding')
    const newer = ask('AI-assisted')
    respond = decide({ 'AI coding': `Q${newer.id}`, 'AI-assisted': `Q${older.id}` })
    await m.tidyKnowsQuestions()
    assert.equal(row(older.id).status, 'pending')
    assert.equal(row(newer.id).status, 'skipped')
  })
})

describe('the one-time repair', () => {
  function seed() {
    const a = ask('AI-assisted')
    const b = ask('AI coding')
    const c = ask('AI-first')
    answer(c.id, 'Yes')
    const d = ask('Modern agentic coding tools', 'has_done')
    appSkip(d.id)
    const e = ask('Kotlin')
    answer(e.id, 'Yes')
    const f = ask('Kotlin for Android')
    answer(f.id, 'No')
    const g = ask('React')
    const h = ask('Vue')
    const i = ask('Infrastructure-as-code')
    answer(i.id, 'Yes')
    const j = ask('IaC')
    answer(j.id, 'Yes')
    const k = ask('Rust')
    return { a, b, c, d, e, f, g, h, i, j, k }
  }

  /** The grouping call's answer, and the second reading's (no removals unless given). */
  const groups = (s: ReturnType<typeof seed>, removals: Array<{ id: string; reason: string }> = []) => (call: StubCall) => call.text.includes('You check proposed groups') ? { removals } : ({
    groups: [
      { claim: 'using AI to build software', ids: [`Q${s.a.id}`, `Q${s.b.id}`, `Q${s.c.id}`, `Q${s.d.id}`] },
      { claim: 'Kotlin', ids: [`Q${s.e.id}`, `Q${s.f.id}`] },
      { claim: 'front end frameworks', ids: [`Q${s.g.id}`, `Q${s.h.id}`] },
      { claim: 'infrastructure as code', ids: [`Q${s.i.id}`, `Q${s.j.id}`] },
    ],
  })

  test('the plan writes nothing', async () => {
    const s = seed()
    respond = groups(s)
    const before = JSON.stringify(db().all(m.sql`select * from questions order by id`))
    const settings = JSON.stringify(db().all(m.sql`select key, value_json from app_settings order by key`))
    const plan = await m.planMeaningRepair()
    assert.equal(plan.error, null)
    assert.equal(JSON.stringify(db().all(m.sql`select * from questions order by id`)), before)
    assert.equal(JSON.stringify(db().all(m.sql`select key, value_json from app_settings order by key`)), settings)
  })

  test('canonical is his own answer; open and app-skipped members merge into it; answered ones and conflicts stay', async () => {
    const s = seed()
    respond = groups(s)
    const plan = await m.planMeaningRepair()
    const ai = plan.groups.find((g: any) => g.claim === 'using AI to build software')
    assert.equal(ai.canonicalId, s.c.id, 'the answered question is the canonical one')
    assert.deepEqual(ai.members.filter((x: any) => x.action === 'merge').map((x: any) => x.id).sort(), [s.a.id, s.b.id, s.d.id].sort())
    const kotlin = plan.groups.find((g: any) => g.claim === 'Kotlin')
    assert.ok(kotlin.conflict, 'Yes and No in one group is listed')
    assert.ok(kotlin.members.every((x: any) => x.action === 'keep'))
    const fe = plan.groups.find((g: any) => g.claim === 'front end frameworks')
    assert.equal(fe.members.find((x: any) => x.id === s.h.id).action, 'keep', 'React and Vue are kept apart by code')
    const iac = plan.groups.find((g: any) => g.claim === 'infrastructure as code')
    assert.equal(iac.canonicalId, s.i.id)
    assert.equal(iac.members.find((x: any) => x.id === s.j.id).action, 'keep', 'a second answered question is never merged')
    assert.ok(plan.standalone.includes(s.k.id))

    const r = await m.mergeSameMeaningOnce()
    assert.equal(r.ran, true)
    for (const id of [s.a.id, s.b.id, s.d.id]) {
      assert.equal(row(id).status, 'skipped')
      assert.match(row(id).context, new RegExp(`^Merged into question #${s.c.id} `))
      assert.equal(m.appSkipNote(row(id))?.startsWith(`Merged into question #${s.c.id}`), true, 'listed under Skipped by the app')
    }
    assert.equal(row(s.c.id).answer, 'Yes')
    assert.equal(row(s.e.id).answer, 'Yes')
    assert.equal(row(s.f.id).answer, 'No')
    assert.equal(row(s.j.id).status, 'answered')
    assert.equal(row(s.h.id).status, 'pending')

    // A new wording of the merged claim now finds the canonical question without a call.
    calls.length = 0
    respond = () => { throw new Error('the stub should not be called') }
    assert.equal((await askChecked('AI coding')).id, s.c.id)
    assert.equal(calls.length, 0)

    const again = await m.mergeSameMeaningOnce()
    assert.equal(again.ran, false, 'runs once')
  })

  test('the second reading takes a member out of its group before anything merges', async () => {
    const s = seed()
    respond = groups(s, [{ id: `Q${s.b.id}`, reason: 'a narrower question' }])
    const plan = await m.planMeaningRepair()
    assert.equal(calls.length, 2, 'the grouping and the second reading')
    assert.deepEqual(plan.removed, [{ id: s.b.id, reason: 'a narrower question' }])
    const ai = plan.groups.find((g: any) => g.claim === 'using AI to build software')
    assert.equal(ai.members.some((x: any) => x.id === s.b.id), false)
    assert.ok(plan.standalone.includes(s.b.id))
    await m.mergeSameMeaningOnce()
    assert.equal(row(s.b.id).status, 'pending', 'never merged')
  })

  test('a failed second reading stops the repair: nothing merges unchecked', async () => {
    const s = seed()
    const grouping = groups(s)
    respond = call => call.text.includes('You check proposed groups') ? new Error('Claude Code exited with code 1') : grouping(call)
    const r = await m.mergeSameMeaningOnce()
    assert.equal(r.ran, false)
    assert.equal(row(s.a.id).status, 'pending')
  })

  test('a failed grouping call sets no marker, so the next run tries again', async () => {
    seed()
    respond = () => new Error('Claude Code exited with code 1')
    const r = await m.mergeSameMeaningOnce()
    assert.equal(r.ran, false)
    assert.ok(r.error)
    assert.equal(db().all(m.sql`select count(*) as n from app_settings where key = 'question_meaning_repair'`)[0].n, 0)
  })
})
