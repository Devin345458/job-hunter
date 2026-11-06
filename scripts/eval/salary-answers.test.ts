// Salary fields are answered per job from Devin's minimum, never from stale text:
// - "Do you accept the posted range?" is Yes when the top of what the job posts reaches his
//   minimum, and otherwise waits on a question for that one application (never No, never shared);
// - a salary expectation says his minimum (or a higher target), never the old Target Salary text;
// - an answer to the same label on another form (question #335 for Samsara) answers nothing else.
//
//   npm run test:salary
//
// No Claude call: the harness has no API key and no subscription token, so any call would fail
// the test. The app's server code runs outside Nitro through scripts/eval/globals.ts, on a fresh
// database file in a temporary directory.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { setupGlobals } from './globals'

const dir = mkdtempSync(join(tmpdir(), 'salary-test-'))
const config: Record<string, unknown> = {
  databasePath: join(dir, 'job-hunter.db'),
  anthropicApiKey: '',
  claudeCodeOauthToken: '',
  aiModel: 'claude-opus-5-5',
  aiFallbackModel: 'claude-haiku-4-5',
  dailyAiBudgetUsd: '10',
  schedulerEnabled: 'false',
  demoToolPath: '',
}

let m: Record<string, any> = {}
let s: Record<string, any> = {}

before(async () => {
  await setupGlobals(config as any)
  m = {
    ...(await import('../../server/utils/facts')),
    ...(await import('../../server/utils/apply/answers')),
    ...(await import('../../server/utils/db')),
    ...(await import('../../server/utils/questions')),
    eq: (await import('drizzle-orm')).eq,
  }
  s = await import('../../server/db/schema')
})

after(() => rmSync(dir, { recursive: true, force: true }))

const MINIMUM = { category: 'preference', key: 'Minimum Total Compensation', value: '$160,000 a year in total compensation (base, bonus, equity, and benefits) is the lowest he would accept. (Answer to: What is the lowest total yearly compensation you would accept?)', source: 'user_answer' }
const TARGET = { category: 'preference', key: 'Target Salary', value: '$150,000+ USD', source: 'inferred' }

const SAMSARA = '[Compensation] Do you accept the listed salary range for this position?'
const CIRCLECI = 'Are your salary expectations for this role within the posted salary band (if applicable)?'

function comp(min: number | null, max: number | null, over: Record<string, unknown> = {}) {
  return { currency: 'USD', baseMin: min, baseMax: max, basePeriod: 'year', baseQuote: '', baseAnnualMin: min, baseAnnualMax: max, bonus: null, equity: null, benefits: [], totalEstimateMin: min, totalEstimateMax: max, confidence: 'stated', notes: '', extractedAt: '', ...over }
}

function inBand(c: unknown, label = SAMSARA, options: string[] = ['Yes', 'No']) {
  const field = { label, type: options.length ? 'select' : 'text', options }
  const v = m.resolveFacts([MINIMUM, TARGET], { comp: c })
  const def = m.matchFact(field)
  assert.equal(def?.key, 'work.salary_in_band', `"${label}" reads as the posted range question`)
  return m.resolveField(def, field, v).res
}

describe('the posted range question, per job', () => {
  test('a range above his minimum is Yes', () => {
    const res = inBand(comp(165000, 225000))
    assert.equal(res.kind, 'value')
    assert.equal(res.value, 'Yes')
    assert.match(res.detail, /tops out at \$225,000, at or above your minimum of \$160,000/)
  })

  test('a range that straddles his minimum is Yes (its top reaches it)', () => {
    const res = inBand(comp(150000, 200000), CIRCLECI, [])
    assert.equal(res.kind, 'value')
    assert.equal(res.value, 'Yes')
  })

  test('a range whose top is exactly his minimum is Yes', () => {
    assert.equal(inBand(comp(140000, 160000)).value, 'Yes')
  })

  test('a range under his minimum is never No: nothing is derived, the application asks', () => {
    const res = inBand(comp(120000, 150000))
    assert.equal(res.kind, 'blank')
  })

  test('no posted range is never No: nothing is derived', () => {
    assert.equal(inBand(null).kind, 'blank')
    assert.equal(inBand(comp(null, null, { confidence: 'not_stated' })).kind, 'blank')
  })

  test('pay in another currency is not compared', () => {
    assert.equal(inBand(comp(200000, 250000, { currency: 'CAD' })).kind, 'blank')
  })

  test('the total counts when the posting adds to base (compParts)', () => {
    // $150,000 base plus a $15,000 bonus tops out at $165,000.
    const res = inBand(comp(140000, 150000, { bonus: { description: 'bonus', estimatedAnnual: 15000, quote: '' } }))
    assert.equal(res.value, 'Yes')
    assert.match(res.detail, /posted total pay tops out at \$165,000/)
  })

  test("an application's own question reads as the posted range fact, for both production labels", async () => {
    const { cleanFieldLabel } = await import('../../shared/utils/plain-text')
    for (const [label, company, id] of [[SAMSARA, 'Samsara', 94], [CIRCLECI, 'CircleCI', 44]] as const) {
      const subject = m.inBandQuestionSubject(cleanFieldLabel(label), company, id)
      assert.equal(m.factForQuestion({ kind: 'form_field', subject, question: cleanFieldLabel(label) })?.key, 'work.salary_in_band', subject)
      assert.equal(m.isApplicationOnlySubject(subject), true)
    }
    assert.equal(m.isApplicationOnlySubject(SAMSARA), false, 'the label-keyed question (#335) is not application-only')
  })

  test('without the job (questions.ts, the tidy) the posted range fact is absent', () => {
    const v = m.resolveFacts([MINIMUM, TARGET])
    assert.equal(v['work.salary_in_band'], undefined)
  })
})

describe('which labels are which', () => {
  test('salary expectation labels stay the salary fact', () => {
    for (const label of ['What are your salary expectations?', 'What are your hourly/salary expectations?', 'What is your minimum required yearly salary (in USD) to consider this position?']) {
      assert.equal(m.matchFact({ label, type: 'text' })?.key, 'work.salary', label)
    }
  })

  test('a list of pay ranges is the salary expectation, not a yes or no', () => {
    const field = { label: 'Please select the salary range that best aligns with your base salary expectations for this role:', type: 'select', options: ['$150,000 \u2013 $160,000', '$160,000 \u2013 $170,000', '$200,000+'] }
    assert.equal(m.matchFact(field)?.key, 'work.salary')
  })

  test('"Competitive compensation and benefits" (a what-matters checkbox) is no pay fact', () => {
    assert.equal(m.matchFact({ label: 'Competitive compensation and benefits', type: 'checkbox' }), null)
  })
})

describe('the salary expectation', () => {
  const facts = (entries: any[]) => m.resolveFacts(entries)
  const answer = (entries: any[], field: any) => m.resolveField(m.matchFact(field), field, facts(entries)).res

  test('his minimum wins over a lower target, never the old Target Salary text', () => {
    const res = answer([TARGET, MINIMUM], { label: 'What are your salary expectations?', type: 'text' })
    assert.equal(res.value, '$160,000 or more base')
    assert.equal(res.detail, 'preference/Minimum Total Compensation')
  })

  test('a target above his minimum is the figure', () => {
    const res = answer([{ ...TARGET, value: '$180,000' }, MINIMUM], { label: 'What are your salary expectations?', type: 'text' })
    assert.equal(res.value, '$180,000 or more base')
  })

  test('a minimum label gets the figure alone; a total label says total', () => {
    assert.equal(answer([TARGET, MINIMUM], { label: 'What is your minimum required yearly salary (in USD) to consider this position?', type: 'text' }).value, '$160,000')
    assert.equal(answer([TARGET, MINIMUM], { label: 'What is your desired salary range for this role, including base and any variable or on-target earnings?', type: 'text' }).value, '$160,000 or more in total compensation')
  })

  test('a number field gets the number', () => {
    assert.equal(answer([TARGET, MINIMUM], { label: 'What are your salary expectations?', type: 'number' }).value, '160000')
  })

  test('a list of ranges gets the one that holds his minimum, picked in code', () => {
    const res = answer([TARGET, MINIMUM], { label: 'Please select the salary range that best aligns with your base salary expectations for this role:', type: 'select', options: ['$150,000 \u2013 $160,000', '$160,000 \u2013 $170,000', '$170,000 - $180,000', '$200,000+', 'Prefer to discuss during the interview process'] })
    assert.equal(res.kind, 'value')
    assert.equal(res.value, '$160,000 \u2013 $170,000')
  })

  test('a Target Salary with no dollar figure (a stray "Yes") is no figure', () => {
    const v = facts([{ ...TARGET, value: 'Yes. (Answer to: Do you accept the listed salary range for this position?)' }])
    assert.equal(v['work.salary'], undefined)
  })

  test('the answered pay floor question counts when the knowledge base has none', () => {
    const v = m.resolveFacts([TARGET], { answered: (kind: string, subject: string) => kind === 'preference' && subject === 'compensation floor' ? '170000' : null })
    assert.equal(v['work.salary'].value, '$170,000 or more base')
  })
})

describe('refreshing stored answers', () => {
  const db = () => m.useDb()
  const ids: Record<string, { job: number; app: number }> = {}
  let shared = 0

  function addApp(name: string, c: unknown) {
    const job = db().insert(s.jobs).values({ source: 'test', sourceId: name, title: 'Senior Engineer', company: name, compJson: c ? JSON.stringify(c) : null }).returning().get()
    const fields = [
      { id: 'f1', selector: '#f1', label: SAMSARA, type: 'select', required: true, options: ['Yes', 'No'], maxLength: null, section: null, isEeo: false },
      { id: 'f2', selector: '#f2', label: 'What are your salary expectations?', type: 'text', required: true, maxLength: null, section: null, isEeo: false },
    ]
    const snapshot = { url: 'https://example.com', finalUrl: 'https://example.com', atsType: 'greenhouse', title: null, fields, capturedAt: '', requiresAccount: false, blockers: [] }
    // As stored before: the range field waits on the shared label question, the expectation reads Target Salary.
    const answers = [
      { fieldId: 'f1', label: SAMSARA, value: 'Yes', source: 'question', sourceDetail: `question #${shared}: Yes`, confidence: 'high', needsQuestionId: null, filled: true, fillError: null },
      { fieldId: 'f2', label: 'What are your salary expectations?', value: '$150,000+ USD', source: 'knowledge', sourceDetail: 'preference/Target Salary', confidence: 'high', needsQuestionId: null, filled: true, fillError: null },
    ]
    const app = db().insert(s.applications).values({ jobId: job.id, status: 'proposed', formSnapshotJson: JSON.stringify(snapshot), answersJson: JSON.stringify(answers) }).returning().get()
    ids[name] = { job: job.id, app: app.id }
  }

  const stored = (name: string) => JSON.parse(db().select().from(s.applications).all().find((a: any) => a.id === ids[name]!.app).answersJson)

  before(() => {
    db().insert(s.knowledgeEntries).values([MINIMUM, TARGET]).run()
    // Question #335 as production holds it: Devin's Yes for Samsara, keyed by the label alone.
    shared = db().insert(s.questions).values({ question: SAMSARA, kind: 'form_field', subject: SAMSARA, status: 'answered', answer: 'Yes', answerType: 'yes_no', dedupeKey: m.dedupeKeyOf('form_field', SAMSARA) }).returning().get().id
    addApp('Above', comp(165000, 225000))
    addApp('Straddle', comp(150000, 200000))
    addApp('Under', comp(120000, 150000))
    addApp('NoRange', null)
  })

  test('one pass answers every pay field per job and asks for each application on its own', async () => {
    const r = await m.refreshPayAnswersWhenChanged()
    assert.equal(r.ran, true)
    assert.deepEqual(r.failed, [])

    for (const name of ['Above', 'Straddle']) {
      const [range, salary] = stored(name)
      assert.equal(range.value, 'Yes', `${name}: Yes from the posted pay`)
      assert.equal(range.needsQuestionId, null)
      assert.match(range.sourceDetail, /tops out at/)
      assert.equal(salary.value, '$160,000 or more base', `${name}: the expectation is his minimum`)
    }

    const asked: number[] = []
    for (const name of ['Under', 'NoRange']) {
      const [range, salary] = stored(name)
      assert.equal(range.value, null, `${name}: the shared Yes (#${shared}) does not fill it, and No is never sent`)
      assert.notEqual(range.needsQuestionId, shared)
      const q = db().select().from(s.questions).all().find((x: any) => x.id === range.needsQuestionId)
      assert.equal(q.status, 'pending')
      assert.equal(q.applicationId, ids[name]!.app)
      assert.match(q.subject, new RegExp(`\\(${name}, application #${ids[name]!.app}\\)$`))
      assert.match(q.context, /for this application only/)
      // The tidy reads it as the posted range fact (ask null), so it is never grouped, nor sent to the
      // semantic pass that could merge it into the older label-keyed question.
      assert.equal(m.factForQuestion(q)?.key, 'work.salary_in_band')
      assert.equal(m.isApplicationOnlySubject(q.subject), true)
      asked.push(q.id)
      assert.equal(salary.value, '$160,000 or more base')
    }
    assert.notEqual(asked[0], asked[1], 'each application has its own question')
    assert.match(db().select().from(s.questions).all().find((x: any) => x.id === asked[1]).context, /gives no pay range/)
    assert.ok(r.changes.length >= 6)
  })

  test('the same minimum again changes nothing; a new minimum runs again', async () => {
    assert.equal((await m.refreshPayAnswersWhenChanged()).ran, false)
    db().update(s.knowledgeEntries).set({ value: '$210,000 a year in total compensation' }).where(m.eq(s.knowledgeEntries.key, 'Minimum Total Compensation')).run()
    const r = await m.refreshPayAnswersWhenChanged()
    assert.equal(r.ran, true)
    // Above tops out at $225,000: still Yes. Straddle tops out at $200,000: now its own question.
    assert.equal(stored('Above')[0].value, 'Yes')
    assert.equal(stored('Straddle')[0].value, null)
    assert.equal(stored('Straddle')[1].value, '$210,000 or more base')
  })

  test("his answer to an application's own question fills that form only", async () => {
    const under = stored('Under')[0].needsQuestionId
    db().update(s.questions).set({ status: 'answered', answer: 'No' }).where(m.eq(s.questions.id, under)).run()
    await m.refreshStoredAnswers(ids.Under!.app)
    await m.refreshStoredAnswers(ids.NoRange!.app)
    assert.equal(stored('Under')[0].value, 'No')
    assert.equal(stored('NoRange')[0].value, null)
    assert.notEqual(stored('NoRange')[0].needsQuestionId, under)
  })
})
