// Small text helpers shared by tailoring, the cover letter, and the form engine.

/**
 * Generated text goes to employers under Devin's name, so it never carries an em dash or an
 * en dash. A dash used as a range between numbers becomes "to"; any other dash becomes a comma.
 */
export function scrubDashes(text: string): string {
  return text
    .replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, '$1 to $2')
    .replace(/\s*[\u2013\u2014]\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/\s+,/g, ',')
}

/** "Oct 2021 - Present" and "May 2018 - Apr 2019" read as "Oct 2021 to Present". */
export function periodText(period: string): string {
  return period.replace(/\s+[-\u2013\u2014]\s+/g, ' to ').trim()
}

/** Every number written in the text, with thousands separators and currency removed. */
export function numbersIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = m[0].replace(/,/g, '').replace(/\.0+$/, '')
    if (n) out.push(n)
  }
  return out
}

/**
 * Numbers in `text` that never appear in the source text. Used to catch invented figures
 * (years, team sizes, percentages, dollar amounts) that a verification pass might miss.
 * "5M" in the source also allows "5", and "$150,000" allows "150000".
 */
export function unsupportedNumbers(text: string, sourceText: string): string[] {
  const allowed = new Set(numbersIn(sourceText))
  return [...new Set(numbersIn(text))].filter(n => !allowed.has(n))
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map(s => s.trim())
    .filter(Boolean)
}

export function normalizeLabel(s: string): string {
  return s.toLowerCase().replace(/[\u2731*]/g, '').replace(/[^a-z0-9+#]+/g, ' ').trim()
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}\u2026` : s
}
