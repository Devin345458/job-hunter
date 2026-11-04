// Unit tests for the estimated total pay: a percent (a 401(k) match, a bonus target) applies to
// each end of the base range, and the one-time repair brings rows stored before that fix in line.
//
//   npm run test:comp
//
// No Claude call. The app's server code runs outside Nitro through scripts/eval/globals.ts, on a
// fresh database file in a temporary directory.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { setupGlobals } from './globals'

const dir = mkdtempSync(join(tmpdir(), 'comp-test-'))
const config: Record<string, unknown> = {
  databasePath: join(dir, 'job-hunter.db'),
  anthropicApiKey: '',
  aiModel: 'claude-opus-5-5',
  aiFallbackModel: 'claude-haiku-4-5',
  dailyAiBudgetUsd: '10',
  schedulerEnabled: 'false',
  demoToolPath: '',
}

let m: Record<string, any> = {}

before(async () => {
  await setupGlobals(config as any)
  m = {
    ...(await import('../../server/utils/compensation')),
    ...(await import('../../server/utils/comp-repair')),
    ...(await import('../../shared/utils/comp-parts')),
    ...(await import('../../server/utils/db')),
    ...(await import('../../shared/utils/pay-format')),
  }
  m.sql = (await import('drizzle-orm')).sql
})

after(() => rmSync(dir, { recursive: true, force: true }))

const POSTING = [
  'Senior Software Engineer II, Risk.',
  'Base salary range: $157,000 to $213,000 USD annually.',
  'This role is eligible for an annual performance bonus of 10% of base.',
  'Benefits: 401(k) with up to 4% match. Robust time-off plan (21 days of PTO in your first year).',
].join('\n')

function extraction(over: Record<string, unknown> = {}) {
  return {
    currency: 'USD',
    base: { min: 157000, max: 213000, period: 'year', quote: 'Base salary range: $157,000 to $213,000 USD annually' },
    bonus: null,
    equity: null,
    benefits: [
      { name: '401(k) match', category: 'retirement', detail: 'up to 4% match', amount: null, amountRecurrence: null, percentOfBase: 4, quote: '401(k) with up to 4% match' },
      { name: 'Paid time off', category: 'pto', detail: '21 days of PTO in your first year', amount: null, amountRecurrence: null, percentOfBase: null, quote: 'Robust time-off plan (21 days of PTO in your first year)' },
    ],
    notes: '',
    ...over,
  }
}

describe('a percent match counts at each end of the base range', () => {
  test('4% of $157,000 to $213,000 adds $6,280 at the low end and $8,520 at the high end', () => {
    const c = m.buildCompensation(extraction(), POSTING)
    const match = c.benefits.find((b: any) => b.name === '401(k) match')
    assert.equal(match.percentOfBase, 4)
    assert.equal(match.estimatedAnnualValue, 7400, 'the value shown alone stays the midpoint value')
    assert.equal(match.detail, 'up to 4% match (4% of base pay)')
    assert.equal(c.totalEstimateMin, 163280)
    assert.equal(c.totalEstimateMax, 221520)
    assert.equal(m.totalMidpoint(c), 192400, 'the midpoint, and so the score, is the same as before the fix')
    const parts = m.compParts(c)
    assert.deepEqual(parts.counted.map((p: any) => [p.label, p.min, p.max, p.percentOfBase]), [['401(k) match', 6280, 8520, 4]])
    assert.equal(parts.unvalued.length, 1)
    assert.equal(m.totalSourcesText(parts, 'USD'), 'Base $157K to $213K plus 401(k) match ($6,280 to $8,520, 4% of base). 1 other benefit has no dollar value.')
    assert.equal(m.otherBenefitsText(parts), '1 quoted, no dollar value')
  })

  test('a single base figure gives the same total at both ends', () => {
    const c = m.buildCompensation(extraction({ base: { min: 150000, max: 150000, period: 'year', quote: 'Base salary: $150,000 USD annually' } }), `${POSTING}\nBase salary: $150,000 USD annually`)
    assert.equal(c.totalEstimateMin, 156000)
    assert.equal(c.totalEstimateMax, 156000)
  })

  test('with no base pay the match has no value and there is no total', () => {
    const c = m.buildCompensation(extraction({ base: null }), POSTING)
    const match = c.benefits.find((b: any) => b.name === '401(k) match')
    assert.equal(match.estimatedAnnualValue, null)
    assert.equal(match.percentOfBase, undefined)
    assert.equal(c.totalEstimateMin, null)
    assert.equal(c.totalEstimateMax, null)
  })

  test('a percent bonus keeps its percent and still counts at each end', () => {
    const c = m.buildCompensation(extraction({ bonus: { description: 'Annual performance bonus', percentOfBase: 10, amount: null, quote: 'annual performance bonus of 10% of base' } }), POSTING)
    assert.equal(c.bonus.percentOfBase, 10)
    assert.equal(c.bonus.estimatedAnnual, 18500)
    assert.equal(c.totalEstimateMin, 157000 + 15700 + 6280)
    assert.equal(c.totalEstimateMax, 213000 + 21300 + 8520)
  })

  test('the score sentence names what the total counts', () => {
    const c = m.buildCompensation(extraction(), POSTING)
    const s = m.scoreCompensation(c, { target: { value: 150000, source: 'knowledge base: Target Salary "$150,000+"' }, floor: { value: null, source: null }, healthValue: { value: null, source: null } })
    assert.match(s.reasoning, /The midpoint scored is \$192,400 a year, from the posting's estimated total \(\$163,280 to \$221,520: base and 401\(k\) match\)\./)
  })
})

// A row exactly as job 2556 was stored before the fix.
const OLD_2556 = {
  currency: 'USD',
  baseMin: 157000,
  baseMax: 213000,
  basePeriod: 'year',
  baseQuote: 'Base salary range: $157,000 to $213,000 USD annually',
  baseAnnualMin: 157000,
  baseAnnualMax: 213000,
  bonus: null,
  equity: { description: 'Role is eligible for equity compensation; no amounts stated', estimatedAnnual: null, quote: 'equity compensation' },
  benefits: [
    { name: 'Health, dental and vision insurance', category: 'health', detail: 'paid up to 80%', estimatedAnnualValue: null, quote: 'Health, dental and vision insurance paid up to 80%' },
    { name: '401(k) match', category: 'retirement', detail: 'up to 4% match (4% of the base midpoint)', estimatedAnnualValue: 7400, quote: '401(k) with up to 4% match' },
  ],
  totalEstimateMin: 164400,
  totalEstimateMax: 220400,
  confidence: 'stated',
  notes: '',
  extractedAt: '2026-11-04T03:15:15.662Z',
}

// A percent bonus stored before the fix: 15% of $120,000 to $160,000, plus a flat $1,200 stipend.
const OLD_BONUS = {
  ...OLD_2556,
  baseMin: 120000,
  baseMax: 160000,
  baseAnnualMin: 120000,
  baseAnnualMax: 160000,
  bonus: { description: 'Target bonus 15%', estimatedAnnual: 21000, quote: '15% target bonus' },
  equity: null,
  benefits: [{ name: 'Home office stipend', category: 'remote_stipend', detail: '$100 a month', estimatedAnnualValue: 1200, quote: '$100 a month home office stipend' }],
  totalEstimateMin: 120000 + 18000 + 1200,
  totalEstimateMax: 160000 + 24000 + 1200,
}

test('a pay range prints both ends in one form', () => {
  assert.equal(m.payRange(8046, 13440, 'USD'), '$8,046 to $13,440')
  assert.equal(m.payRange(6280, 8520, 'USD'), '$6,280 to $8,520')
  assert.equal(m.payRange(157000, 213000, 'USD'), '$157K to $213K')
  assert.equal(m.payRange(7400, 7400, 'USD'), '$7,400')
})

describe('the one-time repair of rows stored before the fix', () => {
  test('reads the percent back from the detail and recomputes the totals; a second pass changes nothing', () => {
    const next = m.repairedComp(structuredClone(OLD_2556))
    const match = next.benefits.find((b: any) => b.name === '401(k) match')
    assert.equal(match.percentOfBase, 4)
    assert.equal(match.detail, 'up to 4% match (4% of base pay)')
    assert.equal(next.totalEstimateMin, 163280)
    assert.equal(next.totalEstimateMax, 221520)
    assert.equal(m.totalMidpoint(next), 192400)
    assert.deepEqual(m.repairedComp(structuredClone(next)), next)
  })

  test('reads a percent bonus back from the stored totals without moving them', () => {
    assert.equal(m.recoverBonusPercent(structuredClone(OLD_BONUS)), 15)
    const next = m.repairedComp(structuredClone(OLD_BONUS))
    assert.equal(next.bonus.percentOfBase, 15)
    assert.equal(next.totalEstimateMin, OLD_BONUS.totalEstimateMin)
    assert.equal(next.totalEstimateMax, OLD_BONUS.totalEstimateMax)
  })

  test('leaves a row whose stored totals do not add up as it is', () => {
    assert.equal(m.repairedComp({ ...structuredClone(OLD_BONUS), totalEstimateMax: OLD_BONUS.totalEstimateMax + 7 }), null)
  })

  test('runs once on the database: comp_json, total_comp_estimate, and the score sentence', async () => {
    const db = m.useDb()
    const skills = { score: 80, reasoning: 'Skills fit.', matched: [], missing: [] }
    const oldReasoning = 'The midpoint scored is $192,400 a year, from the posting\'s estimated total ($164,400 to $220,400: base, and benefits with a stated value).'
    const breakdown = { final: 80, skills, compensation: { score: null, reasoning: oldReasoning, floor: null, target: null, estimate: 192400, meetsFloor: null }, learned: { total: 0, rules: [] }, weights: { skills: 1, compensation: 0 }, recommendation: 'strong_match', computedAt: '2026-11-04T00:00:00Z' }
    db.run(m.sql`insert into jobs (id, source, source_id, title, company, status, comp_json, total_comp_estimate, score_breakdown, match_score) values (2556, 'test', 'a', 'Senior Software Engineer II', 'Aledade', 'new', ${JSON.stringify(OLD_2556)}, 192400, ${JSON.stringify(breakdown)}, 80)`)
    db.run(m.sql`insert into jobs (id, source, source_id, title, company, status, comp_json, total_comp_estimate) values (2557, 'test', 'b', 'Engineer', 'Bonus Co', 'new', ${JSON.stringify(OLD_BONUS)}, 162200)`)

    const first = await m.repairCompTotalsOnce()
    assert.equal(first.ran, true)
    assert.deepEqual(first.changed.sort(), [2556, 2557])
    assert.deepEqual(first.totalsChanged, [2556])
    assert.deepEqual(first.midpointChanged, [])
    assert.deepEqual(first.bonusPercentRecovered, [2557])
    assert.deepEqual(first.finalScoreChanged, [])

    const row = db.get(m.sql`select comp_json, total_comp_estimate, score_breakdown from jobs where id = 2556`) as any
    const comp = JSON.parse(row.comp_json)
    assert.equal(comp.totalEstimateMin, 163280)
    assert.equal(comp.totalEstimateMax, 221520)
    assert.equal(row.total_comp_estimate, 192400)
    assert.match(JSON.parse(row.score_breakdown).compensation.reasoning, /\$163,280 to \$221,520: base and 401\(k\) match/)

    const second = await m.repairCompTotalsOnce()
    assert.equal(second.ran, false)
  })
})
