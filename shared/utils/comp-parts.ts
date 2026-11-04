import type { Benefit, BenefitCategory, CompensationBreakdown } from '#shared/types/pipeline'
import { payRange } from './pay-format'

// What the estimated total is made of. buildCompensation() stores the totals this computes, and
// every screen that explains the total (the review card, the job page, the score's sentence)
// reads the same parts, so the explanation always adds up to the figure beside it.

/**
 * Benefits whose stated value goes into the total. Parental and family-forming benefits
 * (childcare, fertility, adoption) and uncategorized perks pay out only if used, so an "up to $10,000" fertility
 * allowance would inflate the estimate. They keep their value on the page but stay out of the total.
 */
const USE_DEPENDENT = /fertility|child\s?care|daycare|adoption|surrogacy|family[\s-](forming|planning|building)|egg freezing|\bivf\b/i

export function countsTowardTotal(b: { category: BenefitCategory; name: string; detail?: string }): boolean {
  return b.category !== 'parental' && b.category !== 'other' && !USE_DEPENDENT.test(`${b.name} ${b.detail ?? ''}`)
}

/** One amount the total adds to base pay, at the low and the high end of the base range. */
export interface CompPart {
  kind: 'bonus' | 'equity' | 'benefit'
  /** "bonus", "equity", or the benefit's name as the posting reads. */
  label: string
  min: number
  max: number
  /** Set when the amount is this percent of each end of the base range. */
  percentOfBase: number | null
  /** The benefit this part counts (kind benefit only). */
  benefit?: Benefit
}

export interface CompParts {
  /** Yearly base pay at each end; one end stated reads as both. Null with no base pay. */
  baseMin: number | null
  baseMax: number | null
  /** What the total adds to base, in order: bonus, equity, then counted benefits. */
  counted: CompPart[]
  /** Benefits with a yearly value that the total leaves out because the value depends on use. */
  valuedNotCounted: Benefit[]
  /** Benefits the posting names with no yearly dollar value. */
  unvalued: Benefit[]
  /** Base plus every counted part. Null with no base pay. */
  totalMin: number | null
  totalMax: number | null
}

type PartsInput = Pick<CompensationBreakdown, 'baseAnnualMin' | 'baseAnnualMax' | 'bonus' | 'equity' | 'benefits'>

function validPercent(p: number | null | undefined, cap: number): p is number {
  return p != null && Number.isFinite(p) && p > 0 && p <= cap
}

/**
 * Splits a breakdown into base, the parts the total counts, and the benefits it leaves out. A
 * percent (a bonus target, a 401(k) match) applies to each end of the base range: 4% of $157K to
 * $213K adds $6,280 at the low end and $8,520 at the high end. A stated amount adds the same at both.
 */
export function compParts(c: PartsInput): CompParts {
  const baseMin = c.baseAnnualMin ?? c.baseAnnualMax ?? null
  const baseMax = c.baseAnnualMax ?? c.baseAnnualMin ?? null
  const hasBase = baseMin != null && baseMax != null
  const ends = (percent: number) => ({ min: Math.round(baseMin! * percent / 100), max: Math.round(baseMax! * percent / 100) })

  const counted: CompPart[] = []
  const bonus = c.bonus
  if (bonus && hasBase && validPercent(bonus.percentOfBase, 100)) {
    counted.push({ kind: 'bonus', label: 'bonus', ...ends(bonus.percentOfBase), percentOfBase: bonus.percentOfBase })
  }
  else if (bonus?.estimatedAnnual != null) {
    counted.push({ kind: 'bonus', label: 'bonus', min: bonus.estimatedAnnual, max: bonus.estimatedAnnual, percentOfBase: null })
  }
  if (c.equity?.estimatedAnnual != null) {
    counted.push({ kind: 'equity', label: 'equity', min: c.equity.estimatedAnnual, max: c.equity.estimatedAnnual, percentOfBase: null })
  }

  const valuedNotCounted: Benefit[] = []
  const unvalued: Benefit[] = []
  for (const b of c.benefits ?? []) {
    if (b.estimatedAnnualValue == null) {
      unvalued.push(b)
      continue
    }
    if (!countsTowardTotal(b)) {
      valuedNotCounted.push(b)
      continue
    }
    if (hasBase && validPercent(b.percentOfBase, 25)) counted.push({ kind: 'benefit', label: b.name, ...ends(b.percentOfBase), percentOfBase: b.percentOfBase, benefit: b })
    else counted.push({ kind: 'benefit', label: b.name, min: b.estimatedAnnualValue, max: b.estimatedAnnualValue, percentOfBase: null, benefit: b })
  }

  const sum = (end: 'min' | 'max') => counted.reduce((s, p) => s + p[end], 0)
  return {
    baseMin,
    baseMax,
    counted,
    valuedNotCounted,
    unvalued,
    totalMin: hasBase ? Math.round(baseMin! + sum('min')) : null,
    totalMax: hasBase ? Math.round(baseMax! + sum('max')) : null,
  }
}

/** The part a benefit adds to the total, or null when the total does not count it. */
export function benefitPart(parts: CompParts, b: Benefit): CompPart | null {
  return parts.counted.find(p => p.benefit === b) ?? null
}

/** A benefit's name inside a sentence: "Remote work stipend" reads "remote work stipend"; "401(k) match" and "HSA" stay. */
function inSentence(name: string): string {
  const first = name.split(/\s+/)[0] ?? ''
  if (first.length > 1 && first === first.toUpperCase()) return name
  return name.charAt(0).toLowerCase() + name.slice(1)
}

function listText(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

function partName(p: CompPart): string {
  return p.kind === 'benefit' ? inSentence(p.label) : p.label
}

/** Some parts' names for a sentence: "bonus and 401(k) match". */
export function partNames(list: CompPart[]): string {
  return listText(list.map(partName))
}

/** What the total counts, for a sentence: "base, bonus, and 401(k) match", or "base only". */
export function payPartNames(parts: CompParts): string {
  if (!parts.counted.length) return 'base only'
  return listText(['base', ...parts.counted.map(partName)])
}

/** One counted part with its amount: "$6,280 to $8,520" (both ends) or "$7,400". */
export function partAmount(p: CompPart, currency: string | null | undefined): string {
  return payRange(p.min, p.max, currency)
}

/** "4% of base" for a percent part, else empty. */
export function partPercent(p: CompPart): string {
  return p.percentOfBase != null ? `${p.percentOfBase}% of base` : ''
}

/**
 * The total in one sentence, for the line under the figure: "Base $157K to $213K plus 401(k)
 * match ($6,280 to $8,520, 4% of base). 7 other benefits have no dollar value." Empty with no total.
 */
export function totalSourcesText(parts: CompParts, currency: string | null | undefined): string {
  if (parts.totalMin == null) return ''
  const base = `Base ${payRange(parts.baseMin, parts.baseMax, currency)}`
  const added = parts.counted.map((p) => {
    const name = partName(p)
    const pct = partPercent(p)
    return `${name} (${partAmount(p, currency)}${pct ? `, ${pct}` : ''})`
  })
  const lead = added.length ? `${base} plus ${listText(added)}.` : `${base} only.`
  const rest: string[] = []
  const notCounted = parts.valuedNotCounted.length
  const unvalued = parts.unvalued.length
  if (unvalued) rest.push(`${unvalued} ${added.length ? 'other ' : ''}${unvalued === 1 ? 'benefit has' : 'benefits have'} no dollar value.`)
  if (notCounted) rest.push(`${notCounted} valued ${notCounted === 1 ? 'benefit is' : 'benefits are'} left out because ${notCounted === 1 ? 'its value depends' : 'their value depends'} on use.`)
  return [lead, ...rest].join(' ')
}

/**
 * The benefits the total leaves out, in a few words: "7 quoted, no dollar value" or, when some
 * have a value that depends on use, "8 quoted, not counted". Empty when there are none.
 */
export function otherBenefitsText(parts: CompParts): string {
  const n = parts.unvalued.length + parts.valuedNotCounted.length
  if (!n) return ''
  return parts.valuedNotCounted.length ? `${n} quoted, not counted` : `${n} quoted, no dollar value`
}
