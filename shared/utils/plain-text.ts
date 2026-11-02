// Turns stored error and status text into plain sentences for the dashboard. Errors arrive from
// the Anthropic SDK, the job boards, and the pipeline as raw JSON, stack traces, and internal
// prefixes; none of that should reach the screen. Used by the server where status details are
// written and by every component that shows a stored error, so both sides read the same way.
// Text that has none of those shapes passes through unchanged.

export const CREDIT_SENTENCE = 'Claude is out of credit (add credit in the Anthropic Console)'
export const KEY_SENTENCE = 'Anthropic rejected the API key (set a working key in Coolify)'

const CREDIT = /credit balance is too low|\bis out of credit\b|\bout of credit:/i

/** True when the text is, or contains, Anthropic's out-of-credit error. */
export function isCreditError(raw: string | null | undefined): boolean {
  return !!raw && CREDIT.test(raw)
}

/** Index just past the JSON object that opens at `start`, or -1 when it never closes. */
function jsonEnd(s: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i + 1
  }
  return -1
}

/** The human message inside an API error body: Anthropic's error.message, or a plain message. */
function innerMessage(json: string): string | null {
  try {
    const o = JSON.parse(json)
    const m = o?.error?.message ?? o?.message ?? (typeof o?.error === 'string' ? o.error : null)
    return typeof m === 'string' ? m : null
  }
  catch {
    // Truncated bodies (stats keep the first few hundred characters) do not parse.
    const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(json)
    return m ? m[1]!.replace(/\\"/g, '"') : null
  }
}

/** Replaces every JSON error body in one line with its message, and drops HTML error pages. */
function replaceBodies(line: string): string {
  let out = line
  for (let guard = 0; guard < 5; guard++) {
    const m = /(?:\b\d{3}\s+)?\{\s*"/.exec(out)
    if (!m) break
    const open = m.index + m[0].indexOf('{')
    const end = jsonEnd(out, open)
    const body = out.slice(open, end === -1 ? out.length : end)
    const msg = innerMessage(body)
    const plain = msg == null ? '' : CREDIT.test(msg) ? CREDIT_SENTENCE : msg.trim().replace(/\.$/, '')
    out = `${out.slice(0, m.index)}${plain}${end === -1 ? '' : out.slice(end)}`
  }
  // An HTML error page pasted into a message ("HTTP 503 from host: <!DOCTYPE html> ...").
  return out.replace(/:?\s*<(!doctype|html|head|body)\b[\s\S]*$/i, '')
}

const CREDIT_PHRASES: RegExp[] = [
  // AiCreditExhausted, which also names the environment variable.
  /The Anthropic account behind \w+ is out of credit\.\s*Add credit in the Anthropic Console under Plans & Billing\.?/gi,
  // ai_calls.error for a refused call.
  /out of credit:\s*Your credit balance is too low to access the Anthropic API\.?/gi,
  // The bare sentence from Anthropic, outside any JSON.
  /Your credit balance is too low to access the Anthropic API\.?(\s*Please go to Plans & Billing to upgrade or purchase credits\.?)?/gi,
]

const KEY_PHRASES: RegExp[] = [
  // AiKeyRejected, which names the environment variable.
  /Anthropic rejected the (?:API )?key in \w+(?: \(401\))?\.\s*Set a [^.]*\.?/gi,
  // ai_calls.error for a refused call.
  /^key rejected:\s*401\b.*$/gi,
  // The bare 401 from Anthropic.
  /(?:\b401\s+)?invalid x-api-key\b\.?/gi,
]

/**
 * Question numbers are internal ids. "Optional: asked you as question #12" becomes "Optional:
 * your answer is open on the Questions page", "You skipped question #12" becomes "You skipped
 * this question", "(asked in question #5)" becomes "(asked on the Questions page)", and
 * "question #7: Yes" becomes "Your answer: Yes".
 */
export function plainQuestionRefs(text: string | null | undefined): string {
  if (!text) return ''
  return text
    .replace(/^Optional: asked you as question #\d+\.?/i, 'Optional: your answer is open on the Questions page')
    .replace(/^You skipped question #\d+\.?/i, 'You skipped this question')
    .replace(/\(asked in question #\d+\)/gi, '(asked on the Questions page)')
    .replace(/^question #\d+ answered /i, 'Your answer ')
    .replace(/^question #\d+:\s*/i, 'Your answer: ')
    .replace(/\bquestion #\d+/gi, 'a question on the Questions page')
}

// Knowledge base categories. Facts about Devin read as "your Full Name"; list entries (one skill,
// one job, one project) read as "your Sentry entry".
const FACT_CATEGORIES = 'profile|personal|preferences?'
const ENTRY_CATEGORIES = 'skills?|experience|projects?|education|certifications?|facts?|other'
// "category/" (or "category:" glued to the key), not inside a path or URL.
const KNOWLEDGE_REF = new RegExp(`(?<![\\w./-])(${FACT_CATEGORIES}|${ENTRY_CATEGORIES})(?:/|:(?=[A-Z0-9]))`, 'gi')
// Small words that sit inside a key ("Ruby on Rails", "Game dev or animation").
const KEY_CONNECTORS = new Set(['of', 'and', 'or', 'on', 'the', 'in', 'a', 'an', 'for', 'to', 'with', '&', '-'])

/** Where a key that starts at `start` ends: at , ; ( ) " a line break or the end, or before a sentence word ("mentions United States"). */
function keyEnd(text: string, start: number): number {
  const rest = text.slice(start)
  const stop = /[,;()"“”\n]|\s\(/.exec(rest)
  // The next reference starts a new key ("skill/AI coding tools and skill/Ruby on Rails").
  const nextRef = new RegExp(KNOWLEDGE_REF.source, 'i').exec(rest)
  const end = start + Math.min(stop ? stop.index : rest.length, nextRef ? nextRef.index : rest.length)
  const span = text.slice(start, end)
  // A lowercase word that more capitalized words follow is the sentence going on, not the key:
  // "Work Authorization mentions United States". Lowercase words at the end are the key's own
  // ("AI coding tools"), and so are connectors ("Ruby on Rails").
  const words = [...span.matchAll(/\S+/g)]
  let cut = words.length
  for (let i = 1; i < words.length; i++) {
    const w = words[i]![0]
    if (/^[a-z]/.test(w) && !KEY_CONNECTORS.has(w) && words.slice(i + 1).some(n => /^[A-Z0-9]/.test(n[0]))) {
      cut = i
      break
    }
  }
  // A connector left at the end joins the key to what follows ("skill/X and skill/Y").
  while (cut > 1 && KEY_CONNECTORS.has(words[cut - 1]![0])) cut--
  return cut < words.length ? start + words[cut]!.index! : end
}

/**
 * Knowledge base references as plain words. Stored notes and answer sources name entries the
 * way the database does ("parsed from personal/Street Address", "initials of profile/Full Name",
 * "the source is skill/Sentry"); on screen they read "parsed from your Street Address", "initials
 * of your Full Name", "the source is your Sentry entry". Text without a reference comes back unchanged.
 */
export function plainKnowledgeRefs(text: string | null | undefined): string {
  if (!text) return ''
  let out = ''
  let last = 0
  KNOWLEDGE_REF.lastIndex = 0
  for (let m = KNOWLEDGE_REF.exec(text); m; m = KNOWLEDGE_REF.exec(text)) {
    const keyStart = m.index + m[0].length
    const end = keyEnd(text, keyStart)
    const key = text.slice(keyStart, end).trim()
    if (!key) continue
    const isFact = new RegExp(`^(?:${FACT_CATEGORIES})$`, 'i').test(m[1]!)
    const trailing = text.slice(keyStart, end).match(/\s*$/)![0]
    out += `${text.slice(last, m.index)}your ${key}${isFact ? '' : ' entry'}${trailing}`
    last = end
    KNOWLEDGE_REF.lastIndex = end
  }
  return out + text.slice(last)
}

/** Upper-cases the first letter when the first word is all lowercase; "hCaptcha" and "iCIMS" stay as written. */
export function capitalize(text: string): string {
  const first = /^\S*/.exec(text)![0]
  return first === first.toLowerCase() ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

/** "9 gap(s)" becomes "9 gaps", "1 question(s)" becomes "1 question", "field(s)" becomes "fields". */
export function fixPlurals(text: string): string {
  return text
    .replace(/\b(\d+)(\s+(?:[a-z]+\s+)?)([a-z]+)\(s\)/gi, (_, n: string, mid: string, word: string) => `${n}${mid}${Number(n) === 1 ? word : `${word}s`}`)
    .replace(/\b([a-z]+)\(s\)/gi, '$1s')
}

/**
 * One stored error or status detail as plain text: the first line only (never a stack trace),
 * without internal prefixes, with API error JSON replaced by its message, and with Anthropic's
 * credit error said as one sentence. Plain text comes back unchanged.
 */
export function plainError(raw: string | null | undefined): string {
  if (!raw) return ''
  let line = raw.split('\n').map(s => s.trim()).find(Boolean) ?? ''
  line = line
    .replace(/^prepare_failed attempt=\d+:\s*/i, '')
    .replace(/^(?:Error|TypeError|APIError|BadRequestError):\s*/, '')
    .replace(/^#(\d+):\s*/, 'Job $1: ')
  line = replaceBodies(line)
  for (const re of CREDIT_PHRASES) line = line.replace(re, `${CREDIT_SENTENCE}.`)
  for (const re of KEY_PHRASES) line = line.replace(re, `${KEY_SENTENCE}.`)
  // A credit or key error says everything the turn number would.
  if (line.includes(CREDIT_SENTENCE) || line.includes(KEY_SENTENCE)) line = line.replace(/Claude call failed on turn \d+:\s*/i, '')
  line = line
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:)])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\.{2}(?!\.)/g, '.')
    .trim()
  return fixPlurals(capitalize(line))
}

const WIDGET_TEXT: RegExp[] = [
  /couldn['’]?t auto-?read (?:your )?resume\.?/gi,
  /could not auto-?read (?:your )?resume\.?/gi,
  /analy[sz]ing (?:your )?resume(?:\.{1,3}|…)?/gi,
  /\bsuccess!/gi,
  /\bno locations? found\.?/gi,
  /try entering a different location\.?/gi,
  /\bno (?:results|options|matches) found\.?/gi,
]

/**
 * A form field's label without the status and helper text some employer forms keep inside the
 * label element ("Resume/CV Couldn't auto-read resume.Analyzing resume...Success!",
 * "Current location No location found. Try entering a different locationLoading").
 * Ordinary labels come back unchanged.
 */
export function cleanFieldLabel(label: string | null | undefined): string {
  if (!label) return ''
  let out = label
  for (const re of WIDGET_TEXT) out = out.replace(re, ' ')
  // Trailing spinner captions, which some widgets glue straight onto the previous word.
  for (let i = 0; i < 3; i++) out = out.replace(/\s*(?:Loading|Uploading|Searching)(?:\.{3}|…)?\s*$/, '')
  out = out.replace(/\s+/g, ' ').trim()
  return out || label.trim()
}
