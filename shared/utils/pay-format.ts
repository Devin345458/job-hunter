// One fact, one form. Every screen prints pay, extras (bonus, equity) and counts through these,
// so the Review card, the Jobs list and the job page say the same thing the same way:
// "$164K to $220K", "$191K", "Yes, amount not stated", "1,835".

function symbolFor(currency: string | null | undefined): { prefix: string; suffix: string } {
  const c = (currency || 'USD').toUpperCase()
  if (c === 'USD') return { prefix: '$', suffix: '' }
  if (c === 'EUR') return { prefix: '€', suffix: '' }
  if (c === 'GBP') return { prefix: '£', suffix: '' }
  return { prefix: '', suffix: ` ${c}` }
}

/** A count with a thousands separator: 1835 is "1,835". */
export function countText(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '0'
  return Math.round(n).toLocaleString('en-US')
}

/**
 * One pay figure. $10,000 and up rounds to thousands with an uppercase K ("$164K"); smaller
 * figures (a 401(k) match, a stipend) print in full ("$7,400").
 */
export function payAmount(n: number | null | undefined, currency: string | null | undefined = 'USD'): string {
  if (n == null || Number.isNaN(n)) return ''
  const { prefix, suffix } = symbolFor(currency)
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  const body = abs >= 10000 ? `${Math.round(abs / 1000).toLocaleString('en-US')}K` : Math.round(abs).toLocaleString('en-US')
  return `${sign}${prefix}${body}${suffix}`
}

/**
 * A pay range: "$157K to $213K". The same figure at both ends prints once ("$191K", never
 * "$191K to $191K"); one end alone reads "From $157K" or "Up to $213K". Empty when neither is known.
 */
export function payRange(min: number | null | undefined, max: number | null | undefined, currency: string | null | undefined = 'USD'): string {
  const lo = min ?? null
  const hi = max ?? null
  if (lo == null && hi == null) return ''
  if (lo != null && hi != null) {
    const a = payAmount(lo, currency)
    const b = payAmount(hi, currency)
    return a === b ? a : `${a} to ${b}`
  }
  if (lo != null) return `From ${payAmount(lo, currency)}`
  return `Up to ${payAmount(hi, currency)}`
}

/** Bonus or equity as one phrase everywhere: a yearly figure, "Yes, amount not stated", or "Not stated". */
export function payExtraText(extra: { estimatedAnnual: number | null } | null | undefined, currency: string | null | undefined = 'USD'): string {
  if (!extra) return 'Not stated'
  if (extra.estimatedAnnual != null) return `${payAmount(extra.estimatedAnnual, currency)} a year`
  return 'Yes, amount not stated'
}
