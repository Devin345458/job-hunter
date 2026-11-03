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

/**
 * Every number written in the text, with thousands separators and currency removed, plus
 * magnitude words ("hundreds of millions" yields "hundred" and "million"), which carry an
 * invented figure as surely as digits do.
 */
export function numbersIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = m[0].replace(/,/g, '').replace(/\.0+$/, '')
    if (n) out.push(n)
  }
  for (const m of text.toLowerCase().matchAll(/\b(hundred|thousand|million|billion|trillion|dozen)s?\b/g)) out.push(m[1]!)
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

/** Text as compared for repeats: lowercase words and digits only, single spaces. */
export function repeatKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Sentences shorter than this many words ("Thank you.") can repeat on purpose. */
const REPEAT_MIN_WORDS = 4

/**
 * The last guard before generated text is stored: a paragraph, or a sentence of four or more
 * words, that already appeared earlier in the same text (compared as repeatKey) is dropped.
 * Ramp's cover letter once carried the same three sentences twice in one paragraph, because the
 * evidence check's "rewrite" of one sentence was a copy of the sentences before it. Only removes
 * words; the line breaks between paragraphs are kept.
 */
export function dropRepeats(text: string): string {
  const seen = new Set<string>()
  const seenParagraphs = new Set<string>()
  const paragraphs = text.split(/\n{2,}/)
  const out: string[] = []
  let changed = false
  for (const para of paragraphs) {
    const whole = repeatKey(para)
    if (whole.split(' ').length >= REPEAT_MIN_WORDS && seenParagraphs.has(whole)) {
      changed = true
      continue
    }
    seenParagraphs.add(whole)
    const lines = para.split('\n')
    const keptLines: string[] = []
    for (const line of lines) {
      const sentences = splitSentences(line)
      if (sentences.length === 0) {
        keptLines.push(line)
        continue
      }
      const kept = sentences.filter((sentence) => {
        const key = repeatKey(sentence)
        if (key.split(' ').length < REPEAT_MIN_WORDS) return true
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (kept.length < sentences.length) {
        changed = true
        if (kept.length) keptLines.push(kept.join(' '))
      }
      else {
        keptLines.push(line)
      }
    }
    if (keptLines.some(l => l.trim())) out.push(keptLines.join('\n'))
  }
  // Untouched text comes back exactly as it was, whitespace included.
  return changed ? out.join('\n\n') : text
}

/**
 * Why a proposed rewrite cannot stand in for its line, or null when it can. A rewrite replaces one
 * line, so it may not run longer than the line (more sentences) or repeat another line. The
 * evidence checker sees every line at once: for Ramp's cover letter it "rewrote" one sentence as a
 * copy of the three before it, and for Vanta's it rewrote a sentence as the opening of the next
 * line ("I work best remote."). Both passed the recheck, because every copied claim was supported.
 */
export function rewriteProblem(lineText: string, rewrite: string, otherLines: string[]): string | null {
  if (splitSentences(rewrite).length > Math.max(1, splitSentences(lineText).length)) return 'The rewrite ran longer than the line it replaces, so it was not used.'
  const key = repeatKey(rewrite)
  for (const other of otherLines) {
    const k = repeatKey(other)
    if (!k) continue
    if (k === key || (key.length >= 12 && k.includes(key)) || (k.length >= 20 && key.includes(k))) return 'The rewrite repeated another line, so it was not used.'
  }
  return null
}

/** dropRepeats for one form answer value: text is cleaned, choices and booleans are left alone. */
export function dropRepeatsInValue<T>(value: T): T {
  return (typeof value === 'string' ? dropRepeats(value) : value) as T
}

export function normalizeLabel(s: string): string {
  return s.toLowerCase().replace(/[\u2731*]/g, '').replace(/[^a-z0-9+#]+/g, ' ').trim()
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}\u2026` : s
}
