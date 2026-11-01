import { z } from 'zod'
import { aiStructured } from '../ai'
import type { KnowledgeEntry } from '../knowledge'
import { scrubDashes, unsupportedNumbers } from './text'

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
    supported: z.boolean().describe('True only when every factual claim in the line is stated in the sources'),
    evidence: z.array(z.string()).describe('Knowledge base keys like "skill/PHP" or "POSTING" that support the line'),
    problem: z.string().nullable().describe('For an unsupported line: which claim has no source'),
    rewrite: z.string().nullable().describe('For an unsupported line: the same line keeping only supported facts, or null to drop it'),
  })),
})

const CHECK_SYSTEM = `You are a strict fact checker for job application materials written for Devin Hollister-Graham.
You receive numbered LINES and the SOURCES they must come from. For each line, decide whether every factual claim in it is directly stated in the sources.

A line is UNSUPPORTED when it states anything about Devin that the knowledge base does not say: a skill, tool, language, framework, employer, job title, responsibility, result, metric, number, team size, duration, date, degree, certification, or industry.
A statement that Devin has NOT done something, lacks a skill, has not used a tool, or would need to learn something is also a claim about him. It is unsupported unless the knowledge base says it. The knowledge base being silent about a skill is not evidence that he lacks it.
A claim about the employer or the role is supported only when the POSTING says it.
Rewording, summarizing, combining two stated facts, and choosing which facts to emphasize are fine.
Plain enthusiasm or intent ("I would like to bring this to your team") is fine and needs no source.
Numbers must match the source exactly. "Over 6 years" is supported by "6+ years". "8 years" is not.

For each unsupported line, write a rewrite that keeps only the supported facts and adds nothing new, or set rewrite to null when nothing supported remains.
Never use an em dash or an en dash in a rewrite.
Return one check for every line id, in order.`

async function runChecks(lines: ClaimLine[], sources: string, purpose: string, ref?: { type: string; id: number }) {
  const result = await aiStructured(CheckSchema, {
    purpose,
    system: CHECK_SYSTEM,
    maxTokens: 8000,
    effort: 'medium',
    ref,
    prompt: `SOURCES
${sources}

LINES
${lines.map(l => `${l.id}: ${l.text}`).join('\n')}`,
  })
  return new Map(result.checks.map(c => [c.id.trim(), c]))
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
  const sources = `KNOWLEDGE BASE (facts about Devin)\n${kb}${opts.posting ? `\n\nPOSTING (facts about the employer and the role)\n${opts.posting.slice(0, 12000)}` : ''}`
  const numberSource = `${knowledgeText(opts.entries)}\n${opts.posting ?? ''}`

  let checks = await runChecks(lines, sources, opts.purpose, opts.ref)
  const missing = lines.filter(l => !checks.has(l.id))
  if (missing.length > 0) {
    const again = await runChecks(missing, sources, opts.purpose, opts.ref)
    checks = new Map([...checks, ...again])
  }

  const outcomes: ClaimOutcome[] = lines.map((line) => {
    const c = checks.get(line.id)
    if (!c) return { id: line.id, original: line.text, final: null, status: 'dropped', evidence: [], problem: 'The checker did not return a verdict for this line' }
    if (c.supported) return { id: line.id, original: line.text, final: line.text, status: 'supported', evidence: c.evidence, problem: null }
    const rewrite = c.rewrite?.trim() ? scrubDashes(c.rewrite.trim()) : null
    return { id: line.id, original: line.text, final: rewrite, status: rewrite ? 'rewritten' : 'dropped', evidence: c.evidence, problem: c.problem }
  })

  // A rewrite is new text, so it gets the same check before it is kept.
  const rewritten = outcomes.filter(o => o.status === 'rewritten' && o.final)
  if (rewritten.length > 0) {
    const recheck = await runChecks(rewritten.map(o => ({ id: o.id, text: o.final! })), sources, opts.purpose, opts.ref)
    for (const o of rewritten) {
      const c = recheck.get(o.id)
      if (!c?.supported) {
        o.problem = `${o.problem ?? 'Unsupported'}; the rewrite was also unsupported${c?.problem ? ` (${c.problem})` : ''}`
        o.final = null
        o.status = 'dropped'
      }
      else {
        o.evidence = c.evidence
      }
    }
  }

  // Deterministic guard: a number that appears in no source is invented, whatever the checker said.
  for (const o of outcomes) {
    if (!o.final) continue
    const bad = unsupportedNumbers(o.final, numberSource)
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
