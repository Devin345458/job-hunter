// Unit tests for the skill catalog (server/utils/skill-catalog.ts): the distill and review at ask
// time, the word match fallback, the never-merge rules, the tidy, the bootstrap plan, and applying
// an approved catalog.
//
//   npm run test:catalog
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

const dir = mkdtempSync(join(tmpdir(), 'skill-catalog-test-'))

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

interface StubCall { text: string; review: boolean }
const calls: StubCall[] = []
let respond: (call: StubCall) => unknown = () => ({ skills: [] })

function result(structured: unknown) {
  return [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { model: 'claude-haiku-5-5', content: [] } },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify(structured),
      structured_output: structured,
      total_cost_usd: 0.001,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: { 'claude-haiku-5-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 } },
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
    const system = JSON.stringify(options?.systemPrompt ?? '')
    const call = { text: `${system}\n${JSON.stringify(message).replace(/\\n/g, '\n').replace(/\\"/g, '"')}`, review: system.includes('You review new skills') }
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

type Pick = string | { name: string; question?: string; scope?: string; kind?: string }

/**
 * The stub's distill answer: each requirement's subject to "S<n>" or a new skill, and its review
 * answer: each proposal's name to "new" or "S<n>"/"P<k>" (default "new").
 */
function stub(distill: Record<string, Pick>, review: Record<string, string> = {}, moves: Array<{ id: string; to: string }> = []) {
  return (call: StubCall) => {
    if (call.review) {
      const proposals = [...call.text.matchAll(/^P(\d+): (.+?) \((?:knows|has_done)\)/gm)]
      return { proposals: proposals.map(([, k, name]) => ({ proposal: `P${k}`, decision: review[name!] ?? 'new', name: '', question: '', scope: '', reason: 'stub' })), moves: moves.map(x => ({ ...x, reason: 'stub' })) }
    }
    const items = [...call.text.matchAll(/^((?:R|Q)\d+): (.+?) \| asked/gm)]
    return {
      skills: items.map(([, ref, subject]) => {
        const p = distill[subject!] ?? { name: subject! }
        return typeof p === 'string'
          ? { item: ref, skill: p, name: '', question: '', scope: '', kind: '', reason: 'stub' }
          : { item: ref, skill: 'new', name: p.name, question: p.question ?? `Have you worked with ${p.name}?`, scope: p.scope ?? `Covers ${p.name}.`, kind: p.kind ?? 'knows', reason: 'stub' }
      }),
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────

const db = () => m.useDb()

function ask(subject: string, kind: 'knows' | 'has_done' = 'knows', extra: Record<string, unknown> = {}) {
  return m.askQuestion({ question: kind === 'knows' ? `Have you used ${subject} in a real project?` : `Have you done ${subject}?`, kind, subject, answerType: 'yes_no', context: `An open job asks for ${subject}. Your answer goes into your knowledge base.`, ...extra })
}

function askChecked(subject: string, kind: 'knows' | 'has_done' = 'knows', extra: Record<string, unknown> = {}) {
  return m.askSkillQuestion({ question: kind === 'knows' ? `Have you used ${subject} in a real project?` : `Have you done ${subject}?`, kind, subject, answerType: 'yes_no', context: `An open job asks for ${subject}. Your answer goes into your knowledge base.`, ...extra })
}

const row = (id: number) => db().select().from(m.questions).where(m.eq(m.questions.id, id)).get()
const count = (): number => db().all(m.sql`select count(*) as n from questions`)[0].n
const answer = (id: number, value: string) => db().update(m.questions).set({ status: 'answered', answer: value, answeredAt: m.nowSql() }).where(m.eq(m.questions.id, id)).run()
const appSkip = (id: number) => db().update(m.questions).set({ status: 'skipped', context: 'Skipped by the app: a test reason.' }).where(m.eq(m.questions.id, id)).run()
const supervised = () => m.catalogEntry('using-ai-for-supervised-coding')

before(async () => {
  await setupGlobals(config as any)
  m = {
    ...(await import('../../server/utils/questions')),
    ...(await import('../../server/utils/skill-catalog')),
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
  respond = stub({})
})

// ── Tests ───────────────────────────────────────────────────

describe('at ask time', () => {
  test('an empty catalog makes no call: the word match decides, as before the catalog', async () => {
    respond = () => { throw new Error('the stub should not be called') }
    const q = await askChecked('AI-first')
    assert.equal(q.subject, 'AI-first')
    assert.equal(calls.length, 0)
  })

  test('a requirement is asked as its skill: the generic question, the skill name, "Asked as", and the knowledge key follow', async () => {
    m.ensureSeedSkills()
    respond = stub({ 'AI-first': 'S1' })
    const q = await askChecked('AI-first')
    assert.equal(calls.length, 1, 'distill only: no proposal, so no review')
    assert.equal(q.subject, 'Using AI for supervised coding')
    assert.equal(q.question, 'Have you used AI coding tools in your day-to-day development, reviewing what they produce?')
    assert.equal(q.kind, 'has_done')
    assert.match(q.context, /Asked as: AI-first\.$/)
    assert.equal(q.knowledgeKey, 'experience:Has done: Using AI for supervised coding')
    assert.equal(supervised().questionId, q.id)
  })

  test('another wording of the skill reuses its question and joins "Asked as"; a repeat makes no call', async () => {
    m.ensureSeedSkills()
    respond = stub({ 'AI-first': 'S1', 'AI-collaborative': 'S1' })
    const first = await askChecked('AI-first')
    const before = count()
    const second = await askChecked('AI-collaborative', 'has_done')
    assert.equal(second.id, first.id)
    assert.equal(count(), before)
    assert.match(row(first.id).context, /Asked as: AI-first, AI-collaborative\.$/)
    calls.length = 0
    assert.equal((await askChecked('AI-collaborative')).id, first.id)
    assert.equal(calls.length, 0, 'the stored mapping answered it')
  })

  test('a new skill goes to the review, which adds it; its question is the generic one', async () => {
    m.ensureSeedSkills()
    respond = stub({ 'Ruby on Rails': { name: 'Ruby on Rails', question: 'Have you built web applications with Ruby on Rails?' } })
    const q = await askChecked('Ruby on Rails')
    assert.equal(calls.length, 2, 'distill and review')
    assert.equal(calls[1]!.review, true)
    assert.equal(q.question, 'Have you built web applications with Ruby on Rails?')
    assert.equal(m.catalogEntry('ruby-on-rails').questionId, q.id)
  })

  test('the review maps a proposal that rewords an existing skill onto it', async () => {
    m.ensureSeedSkills()
    respond = stub({ 'AI-first': 'S1', 'AI pair programming': { name: 'AI pair programming', kind: 'has_done' } }, { 'AI pair programming': 'S1' })
    const first = await askChecked('AI-first')
    const got = await askChecked('AI pair programming')
    assert.equal(got.id, first.id)
    assert.equal(m.catalogEntry('ai-pair-programming'), null, 'no entry was added')
  })

  test('a failed distill falls back to the word match and stores nothing', async () => {
    m.ensureSeedSkills()
    const existing = ask('Delivery guarantees and idempotency', 'has_done')
    respond = () => new Error('Claude Code exited with code 1')
    const got = await askChecked('Idempotency and delivery guarantees', 'has_done')
    assert.equal(got.id, existing.id, 'the word match decided')
    assert.deepEqual(m.phrasingDecisions(), {})
  })

  test('a failed review stores nothing either', async () => {
    m.ensureSeedSkills()
    const distill = stub({ 'Ruby on Rails': { name: 'Ruby on Rails' } })
    respond = call => call.review ? new Error('Claude Code exited with code 1') : distill(call)
    const got = await askChecked('Ruby on Rails')
    assert.equal(got.subject, 'Ruby on Rails')
    assert.equal(m.catalogEntry('ruby-on-rails'), null)
    assert.deepEqual(m.phrasingDecisions(), {})
  })

  test('a budget-stopped distill (the subscription limit) falls back and never blocks asking', async () => {
    m.ensureSeedSkills()
    respond = () => 'limit'
    const got = await askChecked('Retries and backoff', 'has_done')
    assert.equal(got.status, 'pending')
    assert.equal(got.subject, 'Retries and backoff')
    const again = await m.distillSkills([{ subject: 'Rate limiting', kind: 'has_done', question: 'Have you built rate limiting?' }])
    assert.match(again.error ?? '', /limit/i)
    assert.equal(calls.length, 1, 'the pause stops the next call before it starts')
  })
})

describe('what never merges, whatever Claude says', () => {
  test('two different tools: a requirement for Vue mapped to the React skill gets its own skill', async () => {
    m.ensureSeedSkills()
    respond = stub({ React: { name: 'React' } })
    const react = await askChecked('React')
    respond = stub({ Vue: 'S3' })
    const vue = await askChecked('Vue')
    assert.notEqual(vue.id, react.id)
    assert.equal(vue.subject, 'Vue')
  })

  test('the review cannot map one tool onto another either', async () => {
    m.ensureSeedSkills()
    respond = stub({ Docker: { name: 'Docker' } })
    const docker = await askChecked('Docker')
    respond = stub({ Kubernetes: { name: 'Kubernetes' } }, { Kubernetes: 'S3' })
    const k8s = await askChecked('Kubernetes')
    assert.notEqual(k8s.id, docker.id)
  })

  test('interest is never the skill of having done it', async () => {
    m.ensureSeedSkills()
    respond = stub({ 'AI products interest': 'S2' })
    const q = await askChecked('AI products interest', 'has_done', { question: 'Are you interested in working on AI products?', context: 'Acme asks for: Genuine interest in AI products. The knowledge base does not say.' })
    assert.notEqual(q.subject, 'Using AI in unsupervised processes')
  })

  test('a list of tools against one tool stays apart, but a list against a general skill is the model\'s call', async () => {
    m.ensureSeedSkills()
    respond = stub({ 'Python FastAPI': { name: 'Python FastAPI' } })
    const fastapi = await askChecked('Python FastAPI')
    respond = stub({ 'FastAPI or Flask': 'S3', 'Claude Code or Cursor': 'S1' })
    assert.notEqual((await askChecked('FastAPI or Flask')).id, fastapi.id)
    assert.equal((await askChecked('Claude Code or Cursor')).subject, 'Using AI for supervised coding')
  })
})

describe('the tidy', () => {
  test('a newer open question on a skill is merged into the skill\'s question', async () => {
    const older = ask('AI-assisted')
    const newer = ask('AI coding')
    m.ensureSeedSkills()
    m.linkSkillQuestion(supervised(), older.id)
    respond = stub({ 'AI-assisted': 'S1', 'AI coding': 'S1' })
    const r = await m.tidyKnowsQuestions()
    assert.equal(r.merged, 1)
    assert.match(row(newer.id).context, new RegExp(`^Merged into question #${older.id}`))
    calls.length = 0
    await m.tidyKnowsQuestions()
    assert.equal(calls.length, 0, 'a second tidy asks nothing')
  })
})

describe('the bootstrap plan', () => {
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
    const j = ask('IaC')
    const k = ask('Rust')
    return { a, b, c, d, e, f, g, h, i, j, k }
  }

  const answers = (s: ReturnType<typeof seed>) => stub({
    'AI-assisted': 'S1',
    'AI coding': 'S1',
    'AI-first': 'S1',
    'Modern agentic coding tools': 'S1',
    'Kotlin': { name: 'Kotlin' },
    'Kotlin for Android': { name: 'Kotlin for Android' },
    'React': { name: 'React' },
    'Vue': { name: 'Frontend frameworks' },
    'Infrastructure-as-code': { name: 'Infrastructure as code', kind: 'has_done' },
    'IaC': { name: 'IaC tooling' },
    'Rust': { name: 'Rust' },
  }, { 'Kotlin for Android': 'P1', 'IaC tooling': 'P5', 'Frontend frameworks': 'P3' }, [{ id: `Q${s.h.id}`, to: 'P3' }])

  test('writes nothing, and decides each skill in code', async () => {
    const s = seed()
    respond = answers(s)
    const before = JSON.stringify(db().all(m.sql`select * from questions order by id`))
    const plan = await m.bootstrapCatalog({ batch: 6 })
    assert.equal(plan.error, null)
    assert.equal(JSON.stringify(db().all(m.sql`select * from questions order by id`)), before)
    assert.equal(db().all(m.sql`select count(*) as n from app_settings`)[0].n, 0)
    assert.equal(calls.filter(c => !c.review).length, 2, 'two distill batches of 6')
    assert.equal(calls.filter(c => c.review).length, 1, 'one review')

    const sup = plan.entries.find((e: any) => e.name === 'Using AI for supervised coding')
    assert.equal(sup.canonicalId, s.c.id, 'his own answer is the canonical question')
    assert.deepEqual(sup.answerFrom, { id: s.c.id, answer: 'Yes' })
    assert.deepEqual(sup.members.filter((x: any) => x.action === 'merge').map((x: any) => x.id).sort(), [s.a.id, s.b.id, s.d.id].sort())
    assert.equal(sup.reword, false, 'an answered canonical keeps its wording')

    const kotlin = plan.entries.find((e: any) => e.name === 'Kotlin')
    assert.ok(kotlin.conflict, 'Yes and No in one skill is listed')
    assert.ok(kotlin.members.every((x: any) => x.action === 'keep'))

    const react = plan.entries.find((e: any) => e.name === 'React')
    assert.deepEqual(react.members.map((x: any) => x.id), [s.g.id], 'neither the review\'s mapping nor its move put Vue under React')
    assert.ok(plan.entries.some((e: any) => e.members.some((x: any) => x.id === s.h.id) && e.name !== 'React'), 'Vue was kept apart from React by code')
    assert.ok(plan.review.some((r: any) => /refused by code/.test(r.what)), 'the refused move is listed')

    const iac = plan.entries.find((e: any) => e.name === 'Infrastructure as code')
    assert.deepEqual(iac.members.map((x: any) => x.id).sort(), [s.i.id, s.j.id].sort())
    assert.equal(iac.canonicalId, s.i.id)
    assert.equal(iac.reword, true, 'an open canonical is reworded to the skill')
  })

  test('apply: rewords the open canonical, merges members, skips what changed, and maps every phrasing', async () => {
    const s = seed()
    respond = answers(s)
    const plan = await m.bootstrapCatalog({ batch: 6 })
    // Changed since the plan: one member answered, one gone, and an open canonical answered.
    answer(s.b.id, 'Yes')
    answer(s.i.id, 'Yes')
    db().run(m.sql`delete from questions where id = ${s.j.id}`)
    const applied = m.applyCatalogPlan(plan)
    assert.deepEqual(applied.merged.map((x: any) => x.id).sort(), [s.a.id, s.d.id].sort())
    assert.ok(applied.skipped.some((x: any) => x.id === s.b.id && /answered/.test(x.reason)))
    assert.ok(applied.skipped.some((x: any) => x.id === s.j.id && /gone/.test(x.reason)))
    assert.match(row(s.a.id).context, new RegExp(`^Merged into question #${s.c.id} `))
    assert.equal(m.appSkipNote(row(s.d.id))?.startsWith(`Merged into question #${s.c.id}`), true, 'listed under Skipped by the app')
    assert.equal(row(s.c.id).answer, 'Yes', 'his answer is untouched')
    const iac = row(s.i.id)
    assert.equal(iac.subject, 'Infrastructure-as-code', 'answered since the plan: its wording stays')
    assert.ok(applied.skipped.some((x: any) => x.id === s.j.id), 'its gone member is listed')
    // A wording seen in the plan finds its skill's question without a call.
    calls.length = 0
    respond = () => { throw new Error('the stub should not be called') }
    assert.equal((await askChecked('AI-assisted', 'has_done')).id, s.c.id)
    assert.equal(calls.length, 0)
  })

  test('the approved catalog applies once, and never while it is unapproved', async () => {
    const s = seed()
    respond = answers(s)
    const plan = await m.bootstrapCatalog({ batch: 6 })
    assert.equal(m.applyApprovedCatalogOnce(null).ran, false)
    assert.equal(m.applyApprovedCatalogOnce(plan).ran, false, 'approved is false')
    assert.equal(row(s.a.id).status, 'pending')
    assert.equal(m.applyApprovedCatalogOnce({ ...plan, approved: true }).ran, true)
    assert.equal(m.applyApprovedCatalogOnce({ ...plan, approved: true }).ran, false, 'runs once')
  })

  test('the reword scope: "combined" rewords only skills with more than one question, "none" rewords nothing', async () => {
    const s = seed()
    respond = answers(s)
    const plan = await m.bootstrapCatalog({ batch: 6 })
    const rust = plan.entries.find((e: any) => e.name === 'Rust')
    rust.reword = true
    rust.question = 'Have you built software in Rust?'
    m.applyCatalogPlan({ ...plan, rewordScope: 'combined' })
    assert.equal(row(s.k.id).question, 'Have you used Rust in a real project?', 'a one-question skill keeps its wording')
    assert.equal(row(s.i.id).subject, 'Infrastructure as code', 'a combined skill is reworded')
    assert.equal(row(s.i.id).knowledgeKey, 'experience:Has done: Infrastructure as code', 'the knowledge key follows the skill')
    assert.match(row(s.i.id).context, /Asked as: Infrastructure-as-code, IaC\.$/)
  })

  test('reword scope "all" rewords one-question skills too; "none" leaves every question as it was', async () => {
    const s = seed()
    respond = answers(s)
    const plan = await m.bootstrapCatalog({ batch: 6 })
    const rust = plan.entries.find((e: any) => e.name === 'Rust')
    rust.reword = true
    rust.question = 'Have you built software in Rust?'
    const before = row(s.i.id).subject
    m.applyCatalogPlan({ ...plan, rewordScope: 'none' })
    assert.equal(row(s.i.id).subject, before)
    db().run(m.sql`delete from app_settings`)
    m.applyCatalogPlan({ ...plan, rewordScope: 'all' })
    assert.equal(row(s.k.id).question, 'Have you built software in Rust?')
  })

  test('the core flag: stored per skill, listed first, and a missing skill is refused', async () => {
    m.ensureSeedSkills()
    respond = stub({ 'Ruby on Rails': { name: 'Ruby on Rails' } })
    await askChecked('Ruby on Rails')
    assert.equal(m.setSkillCore('ruby-on-rails', true).core, true)
    assert.equal(m.catalogEntry('ruby-on-rails').core, true)
    assert.equal(m.skillCatalogView()[0].slug, 'ruby-on-rails', 'core skills come first')
    assert.equal(m.setSkillCore('no-such-skill', true), null)
    assert.equal(m.setSkillCore('ruby-on-rails', false).core, false)
  })

  test('a failed call leaves no plan to apply', async () => {
    seed()
    respond = () => new Error('Claude Code exited with code 1')
    const plan = await m.bootstrapCatalog({ batch: 6 })
    assert.ok(plan.error)
  })
})

describe('folding a duplicate LLM skill into "Using AI in unsupervised processes"', () => {
  const S2 = 'using-ai-in-unsupervised-processes'
  /** The #153 shape (the seed skill's question) and a distill-made duplicate with its own open question (#427's shape). */
  async function duplicate() {
    m.ensureSeedSkills()
    respond = stub({ 'Integrating with LLMs': 'S2' })
    const canon = await askChecked('Integrating with LLMs', 'has_done')
    respond = stub({ 'AI/LLM applications': { name: 'AI/LLM applications', kind: 'has_done', question: 'Have you built anything using LLMs, agents, or RAG?' } })
    const dup = await askChecked('AI/LLM applications', 'has_done')
    const slug = m.skillMatch('AI/LLM applications').entry.slug
    return { canon, dup, slug, plan: { name: 'test folds', approved: true, folds: [{ from: slug, to: S2 }] } }
  }

  test('nothing happens while the folds are unapproved; approved, they apply once', async () => {
    const { dup, plan } = await duplicate()
    assert.equal(m.applySkillFoldsOnce(null).ran, false)
    assert.equal(m.applySkillFoldsOnce({ ...plan, approved: false }).ran, false)
    assert.equal(row(dup.id).status, 'pending')
    assert.equal(m.applySkillFoldsOnce(plan).ran, true)
    assert.equal(m.applySkillFoldsOnce(plan).ran, false, 'runs once')
  })

  test('the duplicate\'s open question merges into the skill\'s question, its wordings map to the skill, and its row stays', async () => {
    const { canon, dup, slug, plan } = await duplicate()
    assert.notEqual(dup.id, canon.id)
    const listed = m.applySkillFolds(plan, false)
    assert.equal(row(dup.id).status, 'pending', 'listing writes nothing')
    assert.deepEqual(listed.rows.filter((r: any) => r.action === 'merge').map((r: any) => r.id), [dup.id])
    m.applySkillFolds(plan, true)
    assert.equal(row(dup.id).status, 'skipped')
    assert.match(row(dup.id).context, new RegExp(`^Merged into question #${canon.id} `))
    assert.equal(m.skillMatch('AI/LLM applications').entry.slug, S2)
    assert.ok(!m.loadCatalog().some((e: any) => e.slug === slug), 'the folded skill leaves the prompts')
    assert.equal(m.catalogEntry(slug).slug, S2, 'its slug reads as the skill it was folded into')
    const stored = db().all(m.sql`select value_json from app_settings where key = ${`skill_catalog:${slug}`}`)
    assert.equal(stored.length, 1, 'the row stays')
    assert.equal(JSON.parse(stored[0].value_json).mergedInto, S2)
    assert.ok(m.catalogEntry(S2).phrasings.includes('AI/LLM applications'))
    calls.length = 0
    assert.equal((await askChecked('AI/LLM applications', 'has_done')).id, canon.id, 'the wording is asked as the skill\'s question')
    assert.equal(calls.length, 0)
  })

  test('production\'s shape: the duplicate merges into the skill\'s answered question', async () => {
    const { canon, dup, plan } = await duplicate()
    answer(canon.id, 'Yes')
    const r = m.applySkillFolds(plan, true)
    assert.deepEqual(r.rows.filter((x: any) => x.action === 'merge').map((x: any) => x.id), [dup.id])
    assert.equal(row(dup.id).status, 'skipped')
    assert.match(row(dup.id).context, new RegExp(`^Merged into question #${canon.id} `))
    assert.equal(row(canon.id).status, 'answered', 'the answer stays')
    assert.equal(m.skillMatch('AI/LLM applications').entry.slug, S2)
    assert.equal(m.canonicalQuestion(dup.id).id, canon.id)
  })

  test('a new proposal with the folded skill\'s name is the skill it was folded into', async () => {
    const { canon, plan } = await duplicate()
    m.applySkillFolds(plan, true)
    respond = stub({ 'Building LLM apps': { name: 'AI/LLM applications', kind: 'has_done' } })
    assert.equal((await askChecked('Building LLM apps', 'has_done')).id, canon.id)
    assert.equal(m.loadCatalog().filter((e: any) => e.name === 'AI/LLM applications').length, 0)
  })

  test('an answered duplicate, a seed skill, and a missing skill are never folded', async () => {
    const { dup, slug, plan } = await duplicate()
    answer(dup.id, 'Yes')
    const r = m.applySkillFolds({ folds: [...plan.folds, { from: 'using-ai-for-supervised-coding', to: S2 }, { from: 'no-such-skill', to: S2 }] }, true)
    assert.deepEqual(r.folded, [])
    assert.match(r.skipped.find((s: any) => s.slug === slug).reason, /answered/)
    assert.match(r.skipped.find((s: any) => s.slug === 'using-ai-for-supervised-coding').reason, /made by seed/)
    assert.match(r.skipped.find((s: any) => s.slug === 'no-such-skill').reason, /not in this catalog/)
    assert.equal(row(dup.id).status, 'answered')
    assert.equal(m.skillMatch('AI/LLM applications').entry.slug, slug, 'nothing re-mapped')
  })

  test('a blocking duplicate question is kept, and listed with the reason', async () => {
    const { dup, plan } = await duplicate()
    db().update(m.questions).set({ blocking: true }).where(m.eq(m.questions.id, dup.id)).run()
    const r = m.applySkillFolds(plan, true)
    assert.equal(row(dup.id).status, 'pending')
    assert.equal(r.rows.find((x: any) => x.id === dup.id).reason, 'an application waits on it')
  })

  test('the seed skill\'s scope comes from code, and the app repo gate reads the wordings a question was asked as', async () => {
    const { canon } = await duplicate()
    const e = m.catalogEntry(S2)
    m.saveEntry({ ...e, scope: 'an old scope' })
    assert.match(m.loadCatalog().find((x: any) => x.slug === S2).scope, /^Covers building AI into software/)
    const texts = m.appRepoScopeTexts(row(canon.id))
    assert.ok(texts.includes('Integrating with LLMs'), 'its "Asked as" wording')
    assert.ok(texts.includes('Using AI in unsupervised processes'), 'its skill name')
    assert.deepEqual(m.appRepoScopeTexts({ ...row(canon.id), kind: 'fact' }), [], 'only skill and experience questions')
  })
})
