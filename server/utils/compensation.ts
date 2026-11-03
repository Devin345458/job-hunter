import { z } from 'zod'
import type { Benefit, BenefitCategory, CompensationBreakdown } from '#shared/types/pipeline'
import { loadKnowledge } from './knowledge'
import * as questionsModule from './questions'
import { answeredValue, askQuestion } from './questions'

// Total compensation: what Claude reads from the posting (numbers plus exact quotes), what
// code derives from those numbers (annualized base, benefit values, totals), and how the
// total compares with Devin's preferences.
//
// Preference decision: the knowledge base entry "Target Salary: $150,000+" is the TARGET,
// not the floor. "Target" names what he aims for; treating it as the lowest offer he would
// accept would drop a $145,000 job he might take, and that would be a guess. The floor is
// asked as a question and applied only once he answers it.

export const BENEFIT_CATEGORIES = ['health', 'dental_vision', 'retirement', 'pto', 'parental', 'learning', 'equipment', 'wellness', 'remote_stipend', 'insurance', 'other'] as const satisfies readonly BenefitCategory[]

/** What Claude extracts. Every figure carries the exact posting text it came from. */
export const CompExtractionSchema = z.object({
  currency: z.string().nullable().describe('ISO code of the pay figures, such as USD. Null when the posting gives no pay figure.'),
  base: z.object({
    min: z.number().nullable().describe('Lowest base pay figure, as written (165000 for "$165,000" or "$165K"). Null if not stated.'),
    max: z.number().nullable().describe('Highest base pay figure, as written. Null if not stated.'),
    period: z.string().nullable().describe('One of: year, month, hour. The period the figures are per. Null if the posting does not say.'),
    quote: z.string().describe('The exact line from the posting that states both base figures.'),
  }).nullable().describe('Base salary or hourly rate: one range exactly as the posting lists it, never the minimum of one range joined to the maximum of another. Null when the posting states no base pay.'),
  bonus: z.object({
    description: z.string(),
    percentOfBase: z.number().nullable().describe('Recurring bonus target as a percent of base, such as 10 for "10% of base". Null if not stated.'),
    amount: z.number().nullable().describe('Recurring yearly bonus in dollars, if stated. Null otherwise.'),
    quote: z.string(),
  }).nullable().describe('A recurring bonus. Sign-on bonuses go in notes, not here.'),
  equity: z.object({
    description: z.string(),
    amountPerYear: z.number().nullable().describe('Equity value per year in dollars, only if the posting states one.'),
    totalGrant: z.number().nullable().describe('Total grant value in dollars, only if stated.'),
    vestingYears: z.number().nullable().describe('Years the total grant vests over, only if stated.'),
    quote: z.string(),
  }).nullable().describe('A grant of stock, options, or RSUs to the employee. An employee stock purchase plan or a donation match is a benefit, not equity. Null when the posting names no grant.'),
  benefits: z.array(z.object({
    name: z.string().describe('Short name, such as "401(k) match" or "Medical insurance".'),
    category: z.string().describe(`One of: ${BENEFIT_CATEGORIES.join(', ')}.`),
    detail: z.string().describe('What the posting says about it, in a few words.'),
    amount: z.number().nullable().describe('A US dollar amount the employer pays or provides for this benefit, as the posting states it. Null for a price or premium the employee pays, a count of hours or days, a percentage, an amount in another currency, or no amount.'),
    amountRecurrence: z.string().nullable().describe('One of: year, month, one_time, unknown. How often that amount is paid; any other frequency, such as weekly or every 2 years, is unknown. Null when there is no amount.'),
    percentOfBase: z.number().nullable().describe('Retirement match as a percent of salary, such as 4 for "4% match". Null for everything else.'),
    quote: z.string().describe('The exact text from the posting this benefit came from.'),
  })),
  notes: z.string().describe('Anything relevant that does not fit above: multiple location-based ranges, sign-on bonus, commission. Empty string if nothing.'),
})

export type CompExtraction = z.infer<typeof CompExtractionSchema>

// ── Quote checks ─────────────────────────────────────────────

export function normalizeForQuote(s: string): string {
  return s.toLowerCase()
    .replace(/[‘’‛′]/g, '\'')
    .replace(/[“”″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[   ]/g, ' ')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** True when the quote (or each part of it around "...") appears in the posting text. */
export function quoteInText(quote: string | null | undefined, normalizedText: string): boolean {
  if (!quote) return false
  const cleaned = normalizeForQuote(quote).replace(/^["'\s-]+|["'\s.]+$/g, '')
  const pieces = cleaned.split(/\.{3}|…/).map(p => p.trim().replace(/^["'\s-]+|["'\s.]+$/g, '')).filter(p => p.length >= 4)
  return pieces.length > 0 && pieces.every(p => normalizedText.includes(p))
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function numberForms(n: number): string[] {
  const forms = new Set<string>([String(n), n.toFixed(2).replace(/\.?0+$/, '')])
  if (n >= 1000) {
    const k = n / 1000
    forms.add(String(Math.round(k * 10) / 10))
    forms.add(String(Math.round(k)))
  }
  if (n >= 1_000_000) forms.add(String(Math.round(n / 100_000) / 10))
  return [...forms].map(escapeRegex)
}

function quoteDigits(quote: string) {
  return normalizeForQuote(quote).replace(/(\d),(?=\d{3}\b)/g, '$1')
}

/** True when the number is written in the quote, as 165000, 165,000, 165k, 211.4K, or 1.5M. */
export function numberInQuote(n: number, quote: string): boolean {
  const q = quoteDigits(quote)
  return numberForms(n).some(f => new RegExp(`(?<![0-9.])${f}(?![0-9])`).test(q))
}

/** True when the number is written as money: "$1,500", "$1.5k", or "1500 USD". "120 hours" does not count. */
export function moneyInQuote(n: number, quote: string): boolean {
  const q = quoteDigits(quote)
  return numberForms(n).some(f => new RegExp(`\\$\\s?${f}(?![0-9])|(?<![0-9.])${f}\\s?(k|m)?\\s?(usd|dollars)\\b`).test(q))
}

/** True when the number is written as a percent: "4%" or "10 percent". */
export function percentInQuote(n: number, quote: string): boolean {
  const q = quoteDigits(quote)
  return numberForms(n).some(f => new RegExp(`(?<![0-9.])${f}\\s?(%|percent)`).test(q))
}

// ── Derivation in code ───────────────────────────────────────

const PERIOD_FACTOR = { year: 1, month: 12, hour: 2080 } as const

/**
 * Benefits whose stated value goes into the total. Parental and family-forming benefits
 * (childcare, fertility, adoption) and uncategorized perks pay out only if used, so an "up to $10,000" fertility
 * allowance would inflate the estimate. They keep their value on the page but stay out of the total.
 */
const USE_DEPENDENT = /fertility|child\s?care|daycare|adoption|surrogacy|family[\s-](forming|planning|building)|egg freezing|\bivf\b/i

export function countsTowardTotal(b: { category: BenefitCategory; name: string; detail?: string }): boolean {
  return b.category !== 'parental' && b.category !== 'other' && !USE_DEPENDENT.test(`${b.name} ${b.detail ?? ''}`)
}

const FULL_COVERAGE = /100\s?%|fully (paid|covered)|full(y)? cover|at no cost|no cost|free (medical|health)|employer[\s-]paid|company[\s-]paid|paid in full|covers? (all|the full)|premiums? (are )?(fully )?(paid|covered)/i

/** A health benefit the posting describes as fully paid by the employer. */
export function isFullyPaidHealth(b: Benefit): boolean {
  return b.category === 'health' && FULL_COVERAGE.test(`${b.detail} ${b.quote}`)
}

function round(n: number) {
  return Math.round(n)
}

// Enums are plain strings in the schema: Haiku 4.5 does not always keep to an enum under
// structured outputs, and one stray value would fail the whole job. Code maps them here.
function oneOf<T extends string>(value: string | null | undefined, allowed: readonly T[], fallback: T): T
function oneOf<T extends string>(value: string | null | undefined, allowed: readonly T[], fallback: null): T | null
function oneOf<T extends string>(value: string | null | undefined, allowed: readonly T[], fallback: T | null): T | null {
  const v = (value ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_') as T
  return allowed.includes(v) ? v : fallback
}

const PERIODS = ['year', 'month', 'hour'] as const
const RECURRENCES = ['year', 'month', 'one_time', 'unknown'] as const

/**
 * Turns Claude's extraction into a CompensationBreakdown. Every figure whose quote is not in
 * the posting, or whose number is not in its quote, is dropped and the reason goes in notes.
 * Annualization and totals happen here, never in the prompt.
 */
export function buildCompensation(ex: CompExtraction, postingText: string): CompensationBreakdown {
  const text = normalizeForQuote(postingText)
  const notes: string[] = []
  if (ex.notes?.trim()) notes.push(ex.notes.trim())

  // Each figure must be written in its quote in the right form: a dollar amount as money
  // ("$1,500", not "120 hours"), a percent with "%". Base pay only needs the number.
  type Check = [number | null, 'number' | 'money' | 'percent']
  const CHECKS = { number: numberInQuote, money: moneyInQuote, percent: percentInQuote }
  const verified = (label: string, quote: string | null | undefined, checks: Check[]): 'ok' | 'no_quote' | 'bad_number' => {
    if (!quoteInText(quote, text)) {
      notes.push(`Dropped ${label}: its quote is not in the posting.`)
      return 'no_quote'
    }
    for (const [n, kind] of checks) {
      if (n != null && !CHECKS[kind](n, quote!)) {
        notes.push(`Dropped the ${label} figure ${n}: the quote does not state it as ${kind === 'money' ? 'a dollar amount' : kind === 'percent' ? 'a percent' : 'a number'}.`)
        return 'bad_number'
      }
    }
    return 'ok'
  }

  // Base
  let baseMin: number | null = null
  let baseMax: number | null = null
  let basePeriod: CompensationBreakdown['basePeriod'] = null
  let baseQuote: string | null = null
  if (ex.base && (ex.base.min != null || ex.base.max != null) && verified('base pay', ex.base.quote, [[ex.base.min, 'number'], [ex.base.max, 'number']]) === 'ok') {
    baseMin = ex.base.min
    baseMax = ex.base.max
    if (baseMin != null && baseMax != null && baseMin > baseMax) [baseMin, baseMax] = [baseMax, baseMin]
    basePeriod = oneOf(ex.base.period, PERIODS, null)
    // "$165K" read as 165: the quote literally says thousands, so scale it.
    const quoteText = normalizeForQuote(ex.base.quote)
    const inThousands = (n: number | null) => n != null && n < 1000 && new RegExp(`(?<![0-9.])${escapeRegex(String(n))}\\s?k\\b`).test(quoteText)
    if (inThousands(baseMin) || inThousands(baseMax)) {
      baseMin = baseMin != null ? baseMin * 1000 : null
      baseMax = baseMax != null ? baseMax * 1000 : null
    }
    const top = baseMax ?? baseMin!
    if (!basePeriod && top >= 30000) {
      basePeriod = 'year'
      notes.push('The posting gives no pay period; a figure of $30,000 or more is read as yearly.')
    }
    if (!basePeriod) {
      notes.push('Dropped base pay: the posting gives no pay period and the figure is too small to assume yearly.')
      baseMin = baseMax = null
    }
    else {
      baseQuote = ex.base.quote
    }
  }
  const factor = basePeriod ? PERIOD_FACTOR[basePeriod] : 1
  const baseAnnualMin = baseMin != null ? round(baseMin * factor) : null
  const baseAnnualMax = baseMax != null ? round(baseMax * factor) : null
  const baseLow = baseAnnualMin ?? baseAnnualMax
  const baseHigh = baseAnnualMax ?? baseAnnualMin
  const baseMid = baseLow != null && baseHigh != null ? (baseLow + baseHigh) / 2 : null
  if (baseAnnualMin == null && baseAnnualMax != null) notes.push('Only a maximum base was stated.')
  if (basePeriod && basePeriod !== 'year' && baseLow != null) notes.push(`Base converted to yearly: ${basePeriod === 'hour' ? 'hourly rate times 2,080 hours' : 'monthly pay times 12'}.`)

  // Bonus: percent applies to each end of the base range
  let bonus: CompensationBreakdown['bonus'] = null
  let bonusLow = 0
  let bonusHigh = 0
  if (ex.bonus) {
    const status = verified('bonus', ex.bonus.quote, [[ex.bonus.percentOfBase, 'percent'], [ex.bonus.amount, 'money']])
    if (status !== 'no_quote') {
      let estimated: number | null = null
      if (status === 'ok' && ex.bonus.amount != null) {
        estimated = round(ex.bonus.amount)
        bonusLow = bonusHigh = estimated
      }
      else if (status === 'ok' && ex.bonus.percentOfBase != null && ex.bonus.percentOfBase > 0 && ex.bonus.percentOfBase <= 100 && baseLow != null && baseHigh != null && baseMid != null) {
        bonusLow = round(baseLow * ex.bonus.percentOfBase / 100)
        bonusHigh = round(baseHigh * ex.bonus.percentOfBase / 100)
        estimated = round(baseMid * ex.bonus.percentOfBase / 100)
      }
      bonus = { description: ex.bonus.description, estimatedAnnual: estimated, quote: ex.bonus.quote }
    }
  }

  // Equity: only a stated yearly value, or a stated grant over stated vesting years
  let equity: CompensationBreakdown['equity'] = null
  let equityAnnual = 0
  if (ex.equity) {
    const status = verified('equity', ex.equity.quote, [[ex.equity.amountPerYear, 'money'], [ex.equity.totalGrant, 'money']])
    if (status !== 'no_quote') {
      let estimated: number | null = null
      if (status === 'ok' && ex.equity.amountPerYear != null) estimated = round(ex.equity.amountPerYear)
      else if (status === 'ok' && ex.equity.totalGrant != null && ex.equity.vestingYears != null && ex.equity.vestingYears > 0 && text.includes(String(ex.equity.vestingYears))) {
        estimated = round(ex.equity.totalGrant / ex.equity.vestingYears)
      }
      equityAnnual = estimated ?? 0
      equity = { description: ex.equity.description, estimatedAnnual: estimated, quote: ex.equity.quote }
    }
  }

  // Benefits
  const benefits: Benefit[] = []
  for (const raw of ex.benefits ?? []) {
    const b = { ...raw, category: oneOf(raw.category, BENEFIT_CATEGORIES, 'other'), amountRecurrence: oneOf(raw.amountRecurrence, RECURRENCES, null) }
    const status = verified(`benefit "${b.name}"`, b.quote, [[b.amount, 'money'], [b.category === 'retirement' ? b.percentOfBase : null, 'percent']])
    if (status === 'no_quote') continue
    let value: number | null = null
    let detail = b.detail
    if (status === 'ok' && b.amount != null && b.amount > 0) {
      if (b.amountRecurrence === 'year') value = round(b.amount)
      else if (b.amountRecurrence === 'month') value = round(b.amount * 12)
      else detail = `${detail} (one-time or unstated frequency, not counted per year)`
    }
    else if (status === 'ok' && b.category === 'retirement' && b.percentOfBase != null && b.percentOfBase > 0 && b.percentOfBase <= 25) {
      if (baseMid != null) {
        value = round(baseMid * b.percentOfBase / 100)
        detail = `${detail} (${b.percentOfBase}% of the base midpoint)`
      }
    }
    if (value != null && !countsTowardTotal(b)) detail = `${detail} (not counted in the total: its value depends on use)`
    benefits.push({ name: b.name, category: b.category, detail, estimatedAnnualValue: value, quote: b.quote })
  }
  const benefitTotal = benefits.reduce((sum, b) => sum + (countsTowardTotal(b) ? b.estimatedAnnualValue ?? 0 : 0), 0)

  const hasBase = baseLow != null
  const anyValue = hasBase || (bonus?.estimatedAnnual ?? null) != null || (equity?.estimatedAnnual ?? null) != null || benefits.some(b => b.estimatedAnnualValue != null)
  if (!hasBase && anyValue) notes.push('No base pay is stated, so no total is estimated.')

  return {
    currency: normalizeCurrency(ex.currency),
    baseMin,
    baseMax,
    basePeriod,
    baseQuote,
    baseAnnualMin,
    baseAnnualMax,
    bonus,
    equity,
    benefits,
    totalEstimateMin: hasBase ? round(baseLow! + bonusLow + equityAnnual + benefitTotal) : null,
    totalEstimateMax: hasBase ? round(baseHigh! + bonusHigh + equityAnnual + benefitTotal) : null,
    confidence: hasBase ? 'stated' : anyValue ? 'partial' : 'not_stated',
    notes: notes.join(' '),
    extractedAt: new Date().toISOString(),
  }
}

/** One ISO code. Haiku sometimes writes "CAD/USD"; any mention of USD means dollars. */
export function normalizeCurrency(value: string | null | undefined): string {
  const v = (value ?? '').toUpperCase()
  if (!v || /USD|US\$|\$/.test(v)) return 'USD'
  return v.match(/[A-Z]{3}/)?.[0] ?? 'USD'
}

/** Midpoint of the yearly total estimate, or null. Stored in jobs.total_comp_estimate. */
export function totalMidpoint(c: CompensationBreakdown | null): number | null {
  if (!c) return null
  const lo = c.totalEstimateMin ?? c.totalEstimateMax
  const hi = c.totalEstimateMax ?? c.totalEstimateMin
  return lo != null && hi != null ? Math.round((lo + hi) / 2) : null
}

// ── Devin's preferences ──────────────────────────────────────

export const FLOOR_SUBJECT = 'compensation floor'
export const HEALTH_SUBJECT = 'value of fully paid health insurance'

/** Dollars from text like "$150,000+ USD", "150k", or "140000". Null when there is no figure. */
export function parseMoney(value: string | null | undefined): number | null {
  if (!value) return null
  const m = value.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(k|m)?\b/i)
  if (!m) return null
  const n = Number(m[1]) * (m[2]?.toLowerCase() === 'k' ? 1000 : m[2]?.toLowerCase() === 'm' ? 1_000_000 : 1)
  return Number.isFinite(n) ? n : null
}

export interface PreferenceValue {
  value: number | null
  /** Where the value came from, shown in the score reasoning. */
  source: string | null
}

export interface CompPreferences {
  target: PreferenceValue
  floor: PreferenceValue
  healthValue: PreferenceValue
}

function fromKnowledge(pattern: RegExp, minimum: number): PreferenceValue | null {
  const entry = loadKnowledge('preference').find(e => pattern.test(e.key))
  if (!entry) return null
  const value = parseMoney(entry.value)
  return value != null && value >= minimum ? { value, source: `knowledge base: ${entry.key} "${entry.value}"` } : null
}

function fromAnswer(subject: string, minimum: number): PreferenceValue | null {
  const answer = answeredValue('preference', subject)
  if (answer == null) return null
  const value = parseMoney(answer)
  return value != null && value >= minimum ? { value, source: `your answer "${answer}"` } : null
}

// The pay floor is shared with the learning unit (feature/cap-learning), which adds
// compensationFloor() and askCompFloor() to questions.ts so Devin is asked once, under one
// subject and knowledge key. Until that branch merges, the lookups below fall back to the
// same subject ("compensation floor"), kind, and key. The floor used here is only ever the
// one Devin answered: the floor learned from "Pay too low" rejections is applied by
// learnedAdjustment(), never in the compensation score, so it cannot count twice.
export const FLOOR_KNOWLEDGE_KEY = 'preference:Minimum Total Compensation'

function sharedQuestionHelper<T extends (...args: any[]) => any>(name: string): T | null {
  const fn = (questionsModule as Record<string, unknown>)[name]
  return typeof fn === 'function' ? fn as T : null
}

function answeredFloor(): PreferenceValue | null {
  const compensationFloor = sharedQuestionHelper<() => number | null>('compensationFloor')
  if (compensationFloor) {
    const value = compensationFloor()
    return value != null && value >= 10000 ? { value, source: 'your answer to the pay floor question' } : null
  }
  return fromAnswer(FLOOR_SUBJECT, 10000)
}

/** Reads the compensation preferences from the knowledge base first, then from answered questions. Never guesses. */
export function loadCompPreferences(): CompPreferences {
  return {
    target: fromKnowledge(/target salary|salary target|desired (salary|compensation)/i, 10000) ?? { value: null, source: null },
    floor: fromKnowledge(/floor|minimum (total )?(comp|salary|pay)|lowest|walk[\s-]?away/i, 10000) ?? answeredFloor() ?? { value: null, source: null },
    healthValue: fromKnowledge(/health insurance.*(value|worth)|(value|worth).*health insurance/i, 0) ?? fromAnswer(HEALTH_SUBJECT, 0) ?? { value: null, source: null },
  }
}

/** Asks for the missing compensation preferences this job needs. askQuestion dedupes, so each is asked once. */
export function askCompQuestions(prefs: CompPreferences, comp: CompensationBreakdown | null, jobId?: number): { floorQuestionId: number | null; healthQuestionId: number | null } {
  let floorQuestionId: number | null = null
  let healthQuestionId: number | null = null
  if (prefs.floor.value == null) {
    const context = `Your knowledge base says ${prefs.target.source ? prefs.target.source.replace('knowledge base: ', '') : 'nothing about pay'}. The scorer treats that as your target, not the lowest offer you would take. Jobs whose estimated total pay (salary, bonus, and benefits with a stated value) is below this number will score low on compensation.`
    const askCompFloor = sharedQuestionHelper<(opts: Record<string, unknown>) => { id?: number; status?: string } | null | undefined>('askCompFloor')
    const q = askCompFloor
      ? askCompFloor({ jobId, context })
      : askQuestion({
          kind: 'preference',
          subject: FLOOR_SUBJECT,
          question: 'What is the lowest total yearly compensation you would accept?',
          context,
          answerType: 'number',
          knowledgeKey: FLOOR_KNOWLEDGE_KEY,
          jobId,
          category: 'preference',
        })
    floorQuestionId = q?.status === 'pending' && typeof q.id === 'number' ? q.id : null
  }
  if (prefs.healthValue.value == null && comp?.benefits.some(b => isFullyPaidHealth(b) && b.estimatedAnnualValue == null)) {
    const q = askQuestion({
      kind: 'preference',
      subject: HEALTH_SUBJECT,
      question: 'How much is fully paid health insurance worth to you per year, in dollars?',
      context: 'Many postings say the employer pays all health insurance premiums but give no dollar figure. Your answer is added to the estimated total pay of jobs that say so. Answer 0 if you have coverage elsewhere.',
      answerType: 'number',
      knowledgeKey: 'preference:Value of Fully Paid Health Insurance',
      jobId,
      category: 'preference',
    })
    healthQuestionId = q.status === 'pending' ? q.id : null
  }
  return { floorQuestionId, healthQuestionId }
}

// ── Compensation score ───────────────────────────────────────

export interface CompScore {
  score: number | null
  reasoning: string
  floor: number | null
  target: number | null
  estimate: number | null
  meetsFloor: boolean | null
}

function usd(n: number) {
  return `$${Math.round(n).toLocaleString('en-US')}`
}

/**
 * Compensation score, 0 to 100, computed in code:
 * - at or above the target: 80, rising to 100 at 130% of the target
 * - between the floor and the target: 40 at the floor to 80 at the target
 * - below the target with no floor known: 80 minus 2 points per percent below the target
 * - below a known floor: 30 at most, falling to 0 at 80% of the floor
 * Null when the posting states no base pay; skills then carry the whole score.
 */
export function scoreCompensation(comp: CompensationBreakdown | null, prefs: CompPreferences, questionIds: { floorQuestionId: number | null; healthQuestionId: number | null } = { floorQuestionId: null, healthQuestionId: null }): CompScore {
  const target = prefs.target.value
  const floor = prefs.floor.value
  const parts: string[] = []
  const gapNotes: string[] = []

  if (floor == null) gapNotes.push(`Your lowest acceptable pay is unknown, so no floor was applied${questionIds.floorQuestionId ? ` (asked on the Questions page)` : ''}.`)

  const postingMid = totalMidpoint(comp)
  const currency = comp ? normalizeCurrency(comp.currency) : 'USD'
  if (comp && postingMid != null && currency !== 'USD') {
    return { score: null, reasoning: [`The posting states pay in ${currency}, not US dollars, so it is not compared with your target.`, 'Skills carry the whole score.', ...gapNotes].join(' '), floor, target, estimate: null, meetsFloor: null }
  }
  if (!comp || postingMid == null) {
    const why = !comp
      ? 'Compensation has not been extracted from this posting yet.'
      : comp.confidence === 'partial'
        ? 'The posting gives some benefit details but no base pay, so compensation is not scored.'
        : 'The posting states no pay, so compensation is not scored.'
    return { score: null, reasoning: [why, 'Skills carry the whole score.', ...gapNotes].join(' '), floor, target, estimate: null, meetsFloor: null }
  }

  let estimate = postingMid
  parts.push(`Estimated total pay is ${usd(postingMid)} a year from the posting (${comp.totalEstimateMin === comp.totalEstimateMax ? usd(postingMid) : `${usd(comp.totalEstimateMin!)} to ${usd(comp.totalEstimateMax!)}`}: base${comp.bonus?.estimatedAnnual ? ', bonus' : ''}${comp.equity?.estimatedAnnual ? ', equity' : ''}${comp.benefits.some(b => b.estimatedAnnualValue) ? ', and benefits with a stated value' : ''}).`)

  const unvaluedHealth = comp.benefits.some(b => isFullyPaidHealth(b) && b.estimatedAnnualValue == null)
  if (unvaluedHealth) {
    if (prefs.healthValue.value != null) {
      estimate += prefs.healthValue.value
      parts.push(`Fully paid health insurance adds ${usd(prefs.healthValue.value)} at the value you gave, for ${usd(estimate)} in total.`)
    }
    else {
      gapNotes.push(`The posting offers fully paid health insurance, but you have not said what that is worth to you, so it is not counted${questionIds.healthQuestionId ? ` (asked on the Questions page)` : ''}.`)
    }
  }

  let score: number | null
  if (floor != null && estimate < floor) {
    score = Math.max(0, Math.round(30 - (1 - estimate / floor) * 150))
    parts.push(`That is below your floor of ${usd(floor)} (${prefs.floor.source}).`)
  }
  else if (target != null && estimate >= target) {
    score = Math.min(100, Math.round(80 + 20 * (estimate / target - 1) / 0.3))
    parts.push(`That meets your target of ${usd(target)} (${prefs.target.source}).`)
  }
  else if (target != null) {
    score = floor != null && target > floor
      ? Math.round(40 + 40 * (estimate - floor) / (target - floor))
      : Math.max(0, Math.round(80 - (1 - estimate / target) * 200))
    parts.push(`That is ${Math.round((1 - estimate / target) * 100)}% below your target of ${usd(target)} (${prefs.target.source})${floor != null ? ` but above your floor of ${usd(floor)}` : ''}.`)
  }
  else if (floor != null) {
    score = Math.min(100, Math.round(60 + 40 * (estimate / floor - 1) / 0.3))
    parts.push(`That is above your floor of ${usd(floor)} (${prefs.floor.source}). No target salary is in your knowledge base.`)
  }
  else {
    score = null
    parts.push('Your knowledge base has no target salary and you have not given a floor, so compensation is not scored.')
  }

  return {
    score,
    reasoning: [...parts, ...gapNotes].join(' '),
    floor,
    target,
    estimate: Math.round(estimate),
    meetsFloor: floor != null ? estimate >= floor : null,
  }
}
