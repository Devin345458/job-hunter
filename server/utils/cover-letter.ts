import { z } from 'zod'
import type { InferSelectModel } from 'drizzle-orm'
import type { jobs } from '../db/schema'
import type { TailoredResume } from '#shared/types/pipeline'
import { aiStructured } from './ai'
import type { KnowledgeEntry } from './knowledge'
import { profileValue } from './knowledge'
import { evidenceReport, knowledgeForPrompt, verifyClaims, type ClaimOutcome } from './apply/evidence'
import { scrubDashes, splitSentences } from './apply/text'
import { postingTextOf } from './tailor'

type JobRow = InferSelectModel<typeof jobs>

// Cover letter in two Claude calls, the same way as the resume: write it, then check every
// sentence. Claims about Devin must come from the knowledge base; claims about the company
// or the role must come from the posting. Unsupported sentences are rewritten or dropped.

const LetterSchema = z.object({
  paragraphs: z.array(z.string()).describe('Three or four short paragraphs, no greeting and no sign-off'),
})

const LETTER_SYSTEM = `You write short cover letters for Devin Hollister-Graham, in his voice (first person, plain, direct, no flattery).
Rules you must follow:
- 150 to 230 words across three or four short paragraphs. No greeting line and no sign-off; those are added for you.
- Specific to this company and this role: name what the posting asks for and match it to Devin's real experience.
- Facts about Devin come only from the KNOWLEDGE BASE and the TAILORED RESUME. Facts about the company come only from the POSTING. Never invent a number, a product, a mission statement, a person, or a past result.
- Never mention a skill or tool he lacks, has not used, or would need to learn. If the knowledge base does not cover a requirement, leave that requirement out of the letter.
- No cliches ("I am writing to express my interest", "passionate", "rockstar", "fast-paced environment").
- Never use an em dash or an en dash. Use periods and commas.
- American English.`

export interface CoverLetterResult {
  text: string
  evidence: ClaimOutcome[]
  notes: string
}

export async function writeCoverLetter(
  job: JobRow,
  entries: KnowledgeEntry[],
  resume: TailoredResume,
  ref?: { type: string; id: number },
): Promise<CoverLetterResult> {
  const posting = postingTextOf(job)
  const draft = await aiStructured(LetterSchema, {
    purpose: 'cover_letter',
    system: LETTER_SYSTEM,
    effort: 'medium',
    maxTokens: 3000,
    ref,
    prompt: `KNOWLEDGE BASE
${knowledgeForPrompt(entries)}

TAILORED RESUME (already checked against the knowledge base)
Summary: ${resume.summary}
${resume.experience.map(e => `${e.title}, ${e.company} (${e.period})\n${e.bullets.map(b => `- ${b}`).join('\n')}`).join('\n')}

POSTING: ${job.title} at ${job.company}
${posting}`,
  })

  const paragraphs = draft.paragraphs.map(p => splitSentences(scrubDashes(p.trim()))).filter(p => p.length > 0)
  const lines = paragraphs.flatMap((sentences, i) => sentences.map((s, j) => ({ id: `P${i + 1}.S${j + 1}`, text: s })))
  const evidence = await verifyClaims(lines, { entries, posting, purpose: 'cover_letter_verify', ref })
  const finalOf = (id: string) => evidence.find(o => o.id === id)?.final ?? null

  const body = paragraphs
    .map((sentences, i) => sentences.map((_, j) => finalOf(`P${i + 1}.S${j + 1}`)).filter(Boolean).join(' '))
    .filter(p => p.trim().length > 0)

  const name = profileValue(entries, 'Full Name', 'name') || 'Devin Hollister-Graham'
  const text = [`Dear Hiring Team at ${job.company},`, ...body, `Sincerely,\n${name}`].join('\n\n')
  return { text, evidence, notes: evidenceReport('Cover letter evidence check', evidence) }
}
