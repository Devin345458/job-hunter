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
  // An answered experience question is stored under "Has done: <subject>"; it reads as "your <subject> entry".
  text = text.replace(/(?<![\w./-])(experience)\/has done:\s*/gi, '$1/')
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

// ── Demo build stops ──

export type DemoStopKind = 'credit' | 'key' | 'budget'

/**
 * Why a demo build stopped when the reason is the Claude account rather than the build: out of
 * credit, the key was rejected, or the daily budget ran out. The server retries those; any
 * other failure waits for a manual Build again.
 */
export function demoStopKind(error: string | null | undefined): DemoStopKind | null {
  const e = error ?? ''
  if (/credit balance is too low|out of credit/i.test(e)) return 'credit'
  if (/rejected the key|rejected the API key|invalid x-api-key/i.test(e)) return 'key'
  if (/Daily AI budget reached|Waiting for Claude/i.test(e)) return 'budget'
  return null
}

/**
 * A stop said in the past tense. The stored error describes the account at the time of the build;
 * the key or the credit may have changed since, so the page never says it is still true.
 */
export const DEMO_STOP_TEXT: Record<DemoStopKind, string> = {
  credit: 'Stopped: Claude was out of credit at the time',
  key: 'Stopped: Anthropic rejected the API key at the time',
  budget: 'Stopped: that day\'s Claude budget was used up',
}

// ── Gap analysis ──

/** How the gap summary names a demo in each status. */
const DEMO_STATE: Record<string, string> = {
  proposed: 'Demo planned',
  building: 'Demo being built',
  built: 'Demo built',
  publishing: 'Demo being published',
  published: 'Demo published',
  failed: 'Demo build failed',
}

/**
 * The gap summary, agreeing with the demo that exists and saying what state it is in. The stored
 * summary says "Demo planned: X (for Y)." from the day it was planned, even after X was built,
 * and an analysis that ran again later (a question answered since) can say "No demo planned."
 * while the demo is there. Pass null for a demo the current analysis no longer plans, so the
 * summary never names it.
 */
export function gapSummaryText(
  summary: string | null | undefined,
  demo: { title: string; gapAddressed?: string | null; status: string } | null | undefined,
): string {
  if (!summary) return ''
  if (!demo || demo.status === 'discarded') return summary
  const gap = demo.gapAddressed?.trim()
  const named = `${DEMO_STATE[demo.status] ?? 'Demo'}: ${demo.title}${gap ? ` (for ${gap})` : ''}.`
  if (/\bNo demo planned\./.test(summary)) return summary.replace(/\bNo demo planned\./, named)
  // The requirement can hold parentheses of its own, so the phrase ends at the period before the
  // next count ("2 questions waiting on you.") or at the end. A different demo planned since is left as written.
  return summary.replace(
    /\bDemo planned: ([\s\S]+?) \(for [\s\S]*?\)\.(?=\s+\d|\s*$)/,
    (whole, title: string) => (title.trim().toLowerCase() === demo.title.trim().toLowerCase() ? named : whole),
  )
}

// ── Confirmation pages ──

/**
 * A confirmation page's text as older submits stored it, with the page's blocks run together:
 * "Thank you for applying Your application was received." reads "Thank you for applying. Your
 * application was received." Text that already has its periods comes back unchanged.
 */
export function plainConfirmation(text: string | null | undefined): string {
  if (!text) return ''
  return text.replace(
    /\b(thank you for (?:applying|your application|your interest)|thanks for applying|application (?:was |has been )?(?:received|submitted|sent))(?=\s+[A-Z])/gi,
    '$1.',
  )
}

// ── Question context ──

/**
 * A question's stored context in plain words: without the "(kind: domain, must have)" tag older
 * gap questions copied from the prompt, and without the doubled period a requirement ending in
 * "U.S." left. An ellipsis stays.
 */
export function plainQuestionContext(text: string | null | undefined): string {
  if (!text) return ''
  return text
    .replace(/\s*\(kind: [^)]*\)/gi, '')
    .replace(/(?<!\.)\.\.(?!\.)/g, '.')
    .replace(/\s+([.,;:])/g, '$1')
}

// ── Match reasoning in the second person ──

const TO_BASE: Record<string, string> = {
  'has': 'have', 'is': 'are', 'was': 'were', 'does': 'do', 'doesn\'t': 'don\'t', 'isn\'t': 'aren\'t',
  'hasn\'t': 'haven\'t', 'wasn\'t': 'weren\'t', 'focuses': 'focus', 'goes': 'go',
}
const MODALS = new Set(['would', 'could', 'can', 'will', 'should', 'may', 'might', 'must', 'cannot', 'can\'t', 'won\'t', 'wouldn\'t'])
/** Verbs that share a subject after a comma, "and", or "but": "You have AWS, has led teams, but is ...". */
const COORDINATED = /(,\s+(?:and\s+|but\s+)?|\s+(?:and|but)\s+)(has|is|was|does|lacks|meets|exceeds|shows|brings|holds|owns|leads|knows|works|seeks|needs|offers|matches|fits|demonstrates|understands|uses|wants|targets|appears|seems|falls|aligns|covers|prefers|learns|values|cares|builds|writes|designs|ships|enjoys|thrives|picks|takes|makes|likes)\b/g

/** "has" gives "have", "meets" gives "meet"; null when the word is not a verb this can conjugate. */
function baseVerb(word: string): string | null {
  const w = word.toLowerCase()
  if (TO_BASE[w]) return TO_BASE[w]!
  if (MODALS.has(w)) return word
  if (!/^[a-z']+$/.test(word)) return null
  if (/[^aeiou]ies$/.test(w) && w.length > 4) return `${word.slice(0, -3)}y`
  if (/(?:ss|sh|ch|x|zz)es$/.test(w)) return word.slice(0, -2)
  if (/[^su]s$/.test(w) && w.length > 2) return word.slice(0, -1)
  return null
}

/**
 * "The candidate" as a subject: at the start of a sentence, after "However," or a semicolon or
 * colon, or after a conjunction, then up to two adverbs ("only partially") and the verb.
 */
const SUBJECT = /(^|[;:]\s+|\b(?:However|Still|Overall|Instead|Otherwise|Additionally|Also|Moreover|Further|Furthermore|Meanwhile),?\s+|\b(?:and|but|while|whereas|although|though|because|since|so)\s+)((?:the|this)\s+)?candidate\b(?!['’])((?:\s+(?:also|already|still|only|[a-z]+ly)\b){0,2})\s+([A-Za-z']+)/gi
/** Where a clause with its own subject starts; a verb after it does not belong to "you". */
const CLAUSE_END = /\b(?:while|whereas|although|though|because|since|which|who|where|when|if|unless)\b|[;:(]/i

/** One sentence: possessives anywhere; each subject, with the verbs that share it in its own clause. */
function secondPersonSentence(s: string): string {
  const text = s.replace(/\b(the|this)\s+candidate['’]s\b/gi, m => (m[0] === 'T' ? 'Your' : 'your'))
  let out = ''
  let last = 0
  SUBJECT.lastIndex = 0
  for (let m = SUBJECT.exec(text); m; m = SUBJECT.exec(text)) {
    const [all, pre = '', det, adverbs = '', verb = ''] = m
    // A bare "Candidate is" only at the start of a sentence.
    if (!det && pre !== '') continue
    const base = baseVerb(verb)
    if (!base) continue
    const end = m.index + all.length
    const after = text.slice(end)
    const stop = CLAUSE_END.exec(after)
    const clause = after.slice(0, stop ? stop.index : after.length)
      .replace(COORDINATED, (_, sep: string, v: string) => `${sep}${baseVerb(v) ?? v}`)
    out += `${text.slice(last, m.index)}${pre}${pre === '' ? 'You' : 'you'}${adverbs} ${base}${clause}`
    last = end + (stop ? stop.index : after.length)
    SUBJECT.lastIndex = last
  }
  return out + text.slice(last)
}

/**
 * Match reasoning and summaries stored by older runs speak about "the candidate"; newer ones say
 * "you". This rewrites only what it can do correctly: "the candidate's" as "your" anywhere, and
 * "The candidate has" as "You have" at a sentence start, after "However," or a semicolon, or
 * after a conjunction, when the next word is a verb it can conjugate. Anything else, such as
 * "a domain the candidate has worked in", is left as written.
 */
export function secondPerson(text: string | null | undefined): string {
  if (!text) return ''
  if (!/candidate/i.test(text)) return text
  return text.split(/((?<=[.!?])\s+)/).map((part, i) => (i % 2 === 0 ? secondPersonSentence(part) : part)).join('')
}

// ── Text about Devin in the second person ──

/** True when a word placed after `before` starts a sentence, a parenthesis, or a quote. */
function startsSentence(before: string): boolean {
  return /(?:^|[.!?]["”’')\]]*\s+|[("“]\s*)$/.test(before)
}

/** "Devin" or "he" doing something, then up to two adverbs ("only partially") and the next word. */
const PERSON_SUBJECT = /\b(?:Devin(?:\s+Hollister-Graham)?|[Hh]e)\b(?!['’-])((?:\s+(?:also|already|still|only|always|never|often|currently|consistently|[a-z]+ly)\b){0,2})\s+([A-Za-z']+)/g
/** Where the subject's own clause ends; a verb after it belongs to someone else. */
const PERSON_CLAUSE_END = /\b(?:while|whereas|although|though|because|since|which|who|where|when|if|unless|that)\b|[;:()"“”]|\.(?=\s|$)/i

/**
 * Text the evidence check and the tailoring notes write about Devin in the third person, said to
 * him: "Devin established development processes" reads "You established development processes",
 * "Devin has 6+ years" reads "You have 6+ years", "Devin's background" and "his career" read
 * "your background" and "your career", and "true for Devin" reads "true for you". The verb after
 * "Devin" or "he" and the verbs that share it ("has X and is Y") take the "you" form; a past tense
 * stays as written. The stored text is unchanged; this is for display.
 */
export function secondPersonDevin(text: string | null | undefined): string {
  if (!text) return ''
  if (!/\b(?:Devin|[Hh]e|[Hh]is|[Hh]im|himself)\b/.test(text)) return text
  const cap = (word: string, whole: string, offset: number) => (startsSentence(whole.slice(0, offset)) ? word.charAt(0).toUpperCase() + word.slice(1) : word)
  let out = text
    .replace(/\bDevin(?:\s+Hollister-Graham)?['’]s\b/g, (_m, offset: number, whole: string) => cap('your', whole, offset))
    .replace(/\b[Hh]is\b/g, (_m, offset: number, whole: string) => cap('your', whole, offset))
    .replace(/\bhimself\b/g, 'yourself')
    .replace(/\b[Hh]im\b/g, (_m, offset: number, whole: string) => cap('you', whole, offset))
    // "true for Devin", "attributed to Devin": an object, so no verb follows that needs changing.
    .replace(/\b(to|for|about|by|with|of|from|than|on|asked|tell|told)\s+Devin(?:\s+Hollister-Graham)?\b(?!['’])/gi, '$1 you')

  let built = ''
  let last = 0
  PERSON_SUBJECT.lastIndex = 0
  for (let m = PERSON_SUBJECT.exec(out); m; m = PERSON_SUBJECT.exec(out)) {
    const [all, adverbs = '', verb = ''] = m
    const end = m.index + all.length
    const after = out.slice(end)
    const stop = PERSON_CLAUSE_END.exec(after)
    const clause = after.slice(0, stop ? stop.index : after.length)
      .replace(COORDINATED, (_, sep: string, v: string) => `${sep}${baseVerb(v) ?? v}`)
    built += `${out.slice(last, m.index)}${cap('you', out, m.index)}${adverbs} ${baseVerb(verb) ?? verb}${clause}`
    last = end + (stop ? stop.index : after.length)
    PERSON_SUBJECT.lastIndex = last
  }
  out = built + out.slice(last)
  // A "Devin" left over sits before punctuation ("Devin, who ..."), so it has no verb to change.
  return out.replace(/\bDevin(?:\s+Hollister-Graham)?\b(?!['’])/g, (_m, offset: number, whole: string) => cap('you', whole, offset))
}

/**
 * One evidence check line ('"<resume line>" became "<new line>" (<reason>)') with the reason said
 * to Devin. The quoted resume and letter text is shown exactly as written.
 */
export function secondPersonReason(line: string | null | undefined): string {
  if (!line) return ''
  const at = line.indexOf('" (')
  return at === -1 ? secondPersonDevin(line) : line.slice(0, at + 2) + secondPersonDevin(line.slice(at + 2))
}

// ── Evidence check lines ──

/** "The claim that ..." continues a sentence as "the claim that ..."; a name keeps its capital. */
function continueSentence(text: string): string {
  return /^(The|A|An|This|That|It|No|Nothing|One|Each|Every)\b/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text
}

/**
 * One problem from the evidence check, as the producer now writes it: "X. The rewrite was also
 * unsupported: the claim that ...". Lines stored before that read "X.; the rewrite was also
 * unsupported (The claim ...))"; this turns them into the same shape. Other lines are unchanged.
 */
export function plainEvidenceLine(line: string | null | undefined): string {
  if (!line) return ''
  return line.replace(
    /\.?;\s*the rewrite was also unsupported(?:\s*\(((?:[^()]|\([^()]*\))*)\))?/i,
    (_, inner: string | undefined) => `. The rewrite was also unsupported${inner ? `: ${continueSentence(inner.trim().replace(/[.\s]+$/, ''))}` : ''}`,
  ).replace(/\.\)$/, ')')
}
