import { z } from 'zod'
import { aiStructured } from '../ai'
import type { KnowledgeEntry } from '../knowledge'
import { numbersIn, scrubDashes, unsupportedNumbers } from './text'

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
Plain enthusiasm or intent ("I would like to bring this to your team") is not a claim; list no claims for it.
Numbers must match the source exactly. "Over 6 years" is supported by "6+ years". "8 years" is not.

For each unsupported line, write a rewrite that keeps only the supported facts and adds nothing new, in the line's own voice (a first-person line stays in first person), or set rewrite to null when nothing supported remains.
Never use an em dash or an en dash in a rewrite.
Return one check for every line id, in order.`

export type Check = z.infer<typeof CheckSchema>['checks'][number]

async function runChecks(lines: ClaimLine[], sources: string, purpose: string, ref?: { type: string; id: number }) {
  const result = await aiStructured(CheckSchema, {
    purpose,
    system: CHECK_SYSTEM,
    maxTokens: 12000,
    effort: 'medium',
    ref,
    prompt: `SOURCES
${sources}

LINES
${lines.map(l => `${l.id}: ${l.text}`).join('\n')}`,
  })
  return new Map(result.checks.map(c => [c.id.trim(), c]))
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

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
    if (/^posting$/i.test(src)) text = g.posting
    else {
      const e = g.entries.find(x => norm(`${x.category}/${x.key}`) === norm(src) || norm(x.key) === norm(src))
      if (e) { text = `${e.key}\n${e.value}`; entryKey = `${e.category}/${e.key}` }
    }
    if (!text) return `Cites a source that does not exist: "${src}"`
    if (/^posting$/i.test(src) && /\bdevin\b|^(i|my|he|his)\b/i.test(cl.claim.trim())) return `A fact about Devin cannot come from the posting: "${cl.claim}"`
    const q = norm(cl.quote ?? '')
    if (q.length < 8 || !norm(text).includes(q)) return `The quote for "${cl.claim}" is not in ${src}`
    const claimNorm = norm(cl.claim)
    for (const emp of g.employers) {
      if (claimNorm.includes(norm(emp.name)) && entryKey !== emp.key && !/^posting$/i.test(src)) {
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
  const sources = `KNOWLEDGE BASE (facts about Devin)\n${kb}${posting ? `\n\nPOSTING (facts about the employer and the role)\n${posting}` : ''}`
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
    const rewrite = c.rewrite?.trim() ? scrubDashes(c.rewrite.trim()) : null
    return { id: line.id, original: line.text, final: rewrite, status: rewrite ? 'rewritten' : 'dropped', evidence: evidenceOf(c), problem: failed ?? c.problem }
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
        o.problem = `${o.problem ?? 'Unsupported'}; the rewrite was also unsupported${c?.problem ? ` (${c.problem})` : failed && failed !== 'unsupported' ? ` (${failed})` : ''}`
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
export function evidenceReport(title: string, outcomes: ClaimOutcome[]): string {
  const supported = outcomes.filter(o => o.status === 'supported').length
  const rewritten = outcomes.filter(o => o.status === 'rewritten')
  const dropped = outcomes.filter(o => o.status === 'dropped')
  const lines = [`${title}: ${outcomes.length} lines checked against the knowledge base. ${supported} supported, ${rewritten.length} rewritten, ${dropped.length} dropped.`]
  for (const o of rewritten) lines.push(`Rewritten: "${o.original}" became "${o.final}" (${o.problem ?? 'unsupported claim'})`)
  for (const o of dropped) lines.push(`Dropped: "${o.original}" (${o.problem ?? 'unsupported claim'})`)
  return lines.join('\n')
}
