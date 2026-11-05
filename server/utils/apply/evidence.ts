import { z } from 'zod'
import { aiStructured, cachedPrompt } from '../ai'
import type { KnowledgeEntry } from '../knowledge'
import { numbersIn, rewriteProblem, scrubDashes, unsupportedNumbers } from './text'

// The evidence check every generated line goes through before it can reach an employer:
// resume summary sentences and bullets, cover letter sentences, and free-text form answers.
// A second Claude call checks each line against the knowledge base (and the posting, for
// claims about the company), and a deterministic pass drops any line with a number that
// appears in no source.

/** The knowledge base as the prompts see it: one "[category/key] value" block per entry. */
export function knowledgeForPrompt(entries: KnowledgeEntry[]): string {
  return entries.map(e => `[${e.category}/${e.key}]\n${e.value.trim()}`).join('\n\n')
}

/** Plain text of every knowledge entry, for the number guard. */
export function knowledgeText(entries: KnowledgeEntry[]): string {
  return entries.map(e => `${e.key} ${e.value}`).join('\n')
}

export interface ClaimLine {
  id: string
  text: string
}

export interface ClaimOutcome {
  id: string
  original: string
  /** The text that survives, or null when the line was dropped. */
  final: string | null
  status: 'supported' | 'rewritten' | 'dropped'
  evidence: string[]
  problem: string | null
}

const CheckSchema = z.object({
  checks: z.array(z.object({
    id: z.string().describe('The line id exactly as given, e.g. "S1" or "E0.B2"'),
    claims: z.array(z.object({
      claim: z.string().describe('One factual statement from the line, starting with its subject: "Devin ..." for a fact about Devin, "The employer ..." or "The role ..." for a fact from the posting'),
      source: z.string().describe('Where it is stated: a knowledge base key exactly as written inside the brackets (e.g. "skill/PHP", "experience/Applied Imagination - Senior Developer"), "POSTING" for a fact about the employer or the role, or "NONE" when no source states it'),
      quote: z.string().nullable().describe('5 to 25 words copied exactly from that source that state the claim. Null when source is NONE.'),
    })).describe('Every factual claim in the line. Plain enthusiasm or intent is not a claim.'),
    supported: z.boolean().describe('True only when every claim has a source that states it'),
    problem: z.string().nullable().describe('For an unsupported line: which claim has no source'),
    rewrite: z.string().nullable().describe('For an unsupported line: the same line keeping only supported facts, or null to drop it'),
  })),
})

const CHECK_SYSTEM = `You are a strict fact checker for job application materials written for Devin Hollister-Graham.
You receive numbered LINES and the SOURCES they must come from. Split every line into its factual claims and, for each claim, name the one source that states it and copy a short exact quote from that source.

A claim about Devin needs a knowledge base entry that states it: a skill, tool, language, framework, employer, job title, responsibility, result, metric, number, team size, duration, date, degree, certification, or industry.
A claim that ties something to an employer ("at Mihlfeld I designed MySQL schemas") must be stated in that employer's own experience entry. A skill listed elsewhere does not show he used it at that employer.
A statement that Devin has NOT done something, lacks a skill, or would need to learn something is also a claim. It is unsupported unless the knowledge base says it. The knowledge base being silent about a skill is not evidence that he lacks it.
A claim about the employer or the role needs the POSTING. A claim about Devin never comes from the POSTING, even when the posting uses the same words.
Write every claim with its subject first: "Devin ..." for Devin, "The employer ..." or "The role ..." for the posting.
Rewording, summarizing, and choosing what to emphasize are fine, but the quote must come from the source word for word.
Stating the skill a specific piece of work in a source shows ("I designed sensible defaults for data that was missing" for an entry that credits unsigned articles to the firm instead of guessing an author) summarizes that work: quote the work. It may not widen the scope, add a result, or claim a skill the work does not show.
Plain enthusiasm or intent ("I would like to bring this to your team") is not a claim; list no claims for it.
Numbers must match the source exactly. "Over 6 years" is supported by "6+ years". "8 years" is not.

For each unsupported line, write a rewrite that keeps only the supported facts and adds nothing new, in the line's own voice (a first-person line stays in first person), or set rewrite to null when nothing supported remains.
A rewrite replaces only its own line: one sentence at most for a one-sentence line, and never a copy of another line's text.
Never use an em dash or an en dash in a rewrite.
Return one check for every line id, in order.`

export type Check = z.infer<typeof CheckSchema>['checks'][number]

/**
 * One check call. The sources are cached blocks: the knowledge base (the same for the resume,
 * letter, and form answer checks of every application) and the posting (the same for a check and
 * its rechecks); the lines follow.
 */
async function runChecks(lines: ClaimLine[], sources: string[], purpose: string, ref?: { type: string; id: number }) {
  const [kb = '', ...rest] = sources
  const result = await aiStructured(CheckSchema, {
    purpose,
    system: CHECK_SYSTEM,
    maxTokens: 12000,
    effort: 'medium',
    ref,
    prompt: cachedPrompt([`SOURCES
${kb}`, ...rest], `

LINES
${lines.map(l => `${l.id}: ${l.text}`).join('\n')}`),
  })
  return new Map(result.checks.map(c => [c.id.trim(), c]))
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// The problem text the evidence check stores and the application page shows. A line whose rewrite
// also failed reads "X. The rewrite was also unsupported: the claim that ...", never
// "X.; the rewrite was also unsupported (The claim ...)" with a doubled closing parenthesis.
const withoutEndPeriod = (s: string) => s.trim().replace(/[.;,\s]+$/, '')
const asSentence = (s: string) => `${withoutEndPeriod(s)}.`
/** "The claim that ..." continues a sentence as "the claim that ..."; a name keeps its capital. */
const continueSentence = (s: string) => (/^(The|A|An|This|That|It|No|Nothing|One|Each|Every)\b/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s)

export interface Grounding {
  entries: KnowledgeEntry[]
  posting: string | null
  /** Devin's employers, from the experience entries ("Applied Imagination", ...). */
  employers: Array<{ name: string; key: string }>
}

/**
 * The part of the check that does not rely on the model's judgment: every claim must cite a
 * source that exists, quote it word for word, and, when it names one of Devin's employers, cite
 * that employer's own entry. Haiku 4.5 (the production model) passes misattributed claims that
 * this catches, such as a MySQL skill presented as work done at a job whose entry never names MySQL.
 */
export function groundCheck(line: ClaimLine, c: Check, g: Grounding): string | null {
  const lineNorm = norm(line.text)
  if (c.claims.length === 0) {
    if (numbersIn(line.text).length > 0) return 'States a number but cites no source'
    const named = g.employers.find(e => lineNorm.includes(norm(e.name)))
    if (named) return `Names ${named.name} but cites no source`
    return null
  }
  for (const cl of c.claims) {
    const src = cl.source.trim().replace(/^\[|\]$/g, '')
    if (!src || /^none$/i.test(src)) return `No source states: "${cl.claim}"`
    let text: string | null = null
    let entryKey: string | null = null
    let wholeValue: string | null = null
    if (/^posting$/i.test(src)) text = g.posting
    else {
      const e = g.entries.find(x => norm(`${x.category}/${x.key}`) === norm(src) || norm(x.key) === norm(src))
      if (e) { text = `${e.key}\n${e.value}`; entryKey = `${e.category}/${e.key}`; wholeValue = norm(e.value) }
    }
    if (!text) return `Cites a source that does not exist: "${src}"`
    if (/^posting$/i.test(src) && /\bdevin\b|^(i|my|he|his)\b/i.test(cl.claim.trim())) return `A fact about Devin cannot come from the posting: "${cl.claim}"`
    const q = norm(cl.quote ?? '')
    // A short quote is too easy to find by chance, unless it is the cited entry's whole value:
    // "Years of Experience" holds only "6+", and rejecting that dropped a true "six years" line
    // from half the letters (and, in Render's, left the next sentence opening on "Before that").
    const isWholeValue = q.length > 0 && q === wholeValue
    if ((q.length < 8 && !isWholeValue) || !norm(text).includes(q)) return `The quote for "${cl.claim}" is not in ${src}`
    const claimNorm = norm(cl.claim)
    for (const emp of g.employers) {
      // Allowed when the verified quote itself names the employer: Devin's own example ("At Applied
      // Imagination I demoed ...") stored under a skill entry says where he did it.
      if (claimNorm.includes(norm(emp.name)) && entryKey !== emp.key && !/^posting$/i.test(src) && !q.includes(norm(emp.name))) {
        return `Attributes "${cl.claim}" to ${emp.name}, but the source is ${src}, not that job's entry`
      }
    }
  }
  return null
}

/**
 * Checks every line against the sources. Unsupported lines are rewritten (and the rewrite
 * is checked again) or dropped. Lines the checker skipped are checked once more, then dropped.
 * Nothing is ever added.
 */
export async function verifyClaims(
  lines: ClaimLine[],
  opts: { entries: KnowledgeEntry[]; posting?: string | null; purpose: string; ref?: { type: string; id: number } },
): Promise<ClaimOutcome[]> {
  if (lines.length === 0) return []
  const kb = knowledgeForPrompt(opts.entries)
  const posting = opts.posting ? opts.posting.slice(0, 12000) : null
  // Joined, these read "KNOWLEDGE BASE ...\n\nPOSTING ..."; split so each is its own cached block.
  const sources = [`KNOWLEDGE BASE (facts about Devin)\n${kb}`, posting ? `\n\nPOSTING (facts about the employer and the role)\n${posting}` : '']
  const numberSource = `${knowledgeText(opts.entries)}\n${opts.posting ?? ''}`
  const g: Grounding = {
    entries: opts.entries,
    posting,
    employers: opts.entries.filter(e => e.category === 'experience' && !/^has done:/i.test(e.key))
      .map(e => ({ name: (e.key.split(/\s+-\s+/)[0] ?? e.key).trim(), key: `${e.category}/${e.key}` }))
      .filter(e => e.name.length >= 3),
  }
  const evidenceOf = (c: Check) => [...new Set(c.claims.map(x => x.source))]

  let checks = await runChecks(lines, sources, opts.purpose, opts.ref)
  const missing = lines.filter(l => !checks.has(l.id))
  if (missing.length > 0) {
    const again = await runChecks(missing, sources, opts.purpose, opts.ref)
    checks = new Map([...checks, ...again])
  }

  const outcomes: ClaimOutcome[] = lines.map((line) => {
    const c = checks.get(line.id)
    if (!c) return { id: line.id, original: line.text, final: null, status: 'dropped', evidence: [], problem: 'The checker did not return a verdict for this line' }
    const failed = c.supported ? groundCheck(line, c, g) : null
    if (c.supported && !failed) return { id: line.id, original: line.text, final: line.text, status: 'supported', evidence: evidenceOf(c), problem: null }
    const proposed = c.rewrite?.trim() ? scrubDashes(c.rewrite.trim()) : null
    const copied = proposed ? rewriteProblem(line.text, proposed, lines.filter(l => l.id !== line.id).map(l => l.text)) : null
    const rewrite = copied ? null : proposed
    const problem = failed ?? c.problem
    return {
      id: line.id,
      original: line.text,
      final: rewrite,
      status: rewrite ? 'rewritten' : 'dropped',
      evidence: evidenceOf(c),
      problem: copied ? `${asSentence(problem ?? 'Unsupported')} ${copied}` : problem,
    }
  })

  // A rewrite is new text, so it gets the same check, model and grounding, before it is kept.
  const rewritten = outcomes.filter(o => o.status === 'rewritten' && o.final)
  if (rewritten.length > 0) {
    const relines = rewritten.map(o => ({ id: o.id, text: o.final! }))
    const recheck = await runChecks(relines, sources, opts.purpose, opts.ref)
    for (const o of rewritten) {
      const c = recheck.get(o.id)
      const failed = c?.supported ? groundCheck({ id: o.id, text: o.final! }, c, g) : 'unsupported'
      if (!c?.supported || failed) {
        const why = c?.problem || (failed && failed !== 'unsupported' ? failed : null)
        o.problem = `${asSentence(o.problem ?? 'Unsupported')} The rewrite was also unsupported${why ? `: ${continueSentence(withoutEndPeriod(why))}` : ''}.`
        o.final = null
        o.status = 'dropped'
      }
      else {
        o.evidence = evidenceOf(c)
      }
    }
  }

  // Deterministic guard: a number that appears in no source is invented, whatever the checker said.
  // A first-person sentence speaks about Devin, so its numbers must come from the knowledge base,
  // never from the posting.
  const kbText = knowledgeText(opts.entries)
  for (const o of outcomes) {
    if (!o.final) continue
    const firstPerson = /\b(i|i'm|i've|i'd|my|me)\b/i.test(o.final)
    const bad = unsupportedNumbers(o.final, firstPerson ? kbText : numberSource)
    if (bad.length > 0) {
      o.problem = `Contains numbers found in no source: ${bad.join(', ')}`
      o.final = null
      o.status = 'dropped'
    }
  }
  return outcomes
}

/** Human-readable record of an evidence check, stored in tailoring_notes. */
// ── Sentences left pointing at a dropped one ─────────────────

/** An opener that refers back to the sentence before it. Stripping it leaves a whole sentence: "Before that, I worked as CTO" reads "I worked as CTO". */
const BACK_ADVERB = /^(?:before that|before this|prior to that|after that|since then|also|in addition|additionally|similarly|likewise|furthermore|moreover|beyond that|on top of that|as well)(?:\s*,\s*|\s+(?=I\b))/i
/** A subject that only means something after the sentence before it ("That role", "It", "These"). Not strippable: the sentence goes. "This role" names the job applied for and stays. */
const BACK_SUBJECT = /^(?:it|they|these|those|there|that\s+(?:role|job|position|team|company|experience|work|project|time)|this\s+(?:experience|work|background))\b/i

const UPPER_START = /^[a-z]/

/**
 * The kept sentences of each paragraph, joined, after the evidence check. A dropped sentence can
 * leave the next one opening on a reference to it: Render's letter lost its first sentence to the
 * check and then opened "Before that, I worked as CTO ...". Here a sentence that follows a dropped
 * one loses a back-referring opener ("Before that,", "Also,", "In addition,"), and a paragraph
 * whose new first sentence starts on a back-referring subject ("That role", "It") loses that
 * sentence too. Words are only removed, never added, so the check's verdict on the rest holds.
 * The outcomes are updated in place so the evidence report says what changed.
 */
export function joinKeptParagraphs(paragraphs: string[][], outcomes: ClaimOutcome[], idOf: (paragraph: number, sentence: number) => string): string[] {
  const byId = new Map(outcomes.map(o => [o.id, o]))
  const why = 'opened on a reference to a sentence the evidence check removed'
  let previousDropped = false
  const out: string[] = []
  paragraphs.forEach((sentences, i) => {
    const kept: string[] = []
    sentences.forEach((_, j) => {
      const o = byId.get(idOf(i, j))
      if (o?.final && previousDropped) {
        const m = BACK_ADVERB.exec(o.final)
        if (m) {
          const rest = o.final.slice(m[0].length)
          const fixed = UPPER_START.test(rest) ? rest.charAt(0).toUpperCase() + rest.slice(1) : rest
          o.problem = o.problem ? `${withoutEndPeriod(o.problem)}; ${why}` : why
          if (o.status === 'supported') o.status = 'rewritten'
          o.final = fixed
        }
        else if (kept.length === 0 && BACK_SUBJECT.test(o.final)) {
          o.problem = o.problem ? `${withoutEndPeriod(o.problem)}; ${why}` : why
          o.status = 'dropped'
          o.final = null
        }
      }
      if (o?.final) kept.push(o.final)
      previousDropped = !o?.final
    })
    if (kept.length) out.push(kept.join(' '))
  })
  return out
}

export function evidenceReport(title: string, outcomes: ClaimOutcome[]): string {
  const supported = outcomes.filter(o => o.status === 'supported').length
  const rewritten = outcomes.filter(o => o.status === 'rewritten')
  const dropped = outcomes.filter(o => o.status === 'dropped')
  const lines = [`${title}: ${outcomes.length} lines checked against the knowledge base. ${supported} supported, ${rewritten.length} rewritten, ${dropped.length} dropped.`]
  for (const o of rewritten) lines.push(`Rewritten: "${o.original}" became "${o.final}" (${withoutEndPeriod(o.problem ?? 'unsupported claim')})`)
  for (const o of dropped) lines.push(`Dropped: "${o.original}" (${withoutEndPeriod(o.problem ?? 'unsupported claim')})`)
  return lines.join('\n')
}
