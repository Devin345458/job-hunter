import { z } from 'zod'
import type { Requirement } from '#shared/types/pipeline'
import { aiStructured } from '../ai'
import { type CompExtraction, CompExtractionSchema } from '../compensation'
import type { KnowledgeEntry } from '../knowledge'

// One Claude call per job at enrichment: compensation figures with quotes, and the posting's
// requirements judged against the knowledge base. Written first for claude-haiku-4-5; production
// calls NUXT_AI_MODEL. The 2026-11-03 model evaluation (scripts/eval) found the range, benefit
// amount, equity, requirement source, and instance-versus-category rules below missing.

const REQUIREMENT_KINDS = ['skill', 'language', 'framework', 'experience', 'domain', 'education', 'certification', 'other'] as const
const STATUSES = ['have', 'partial', 'lack', 'unknown'] as const

const RequirementSchema = z.object({
  text: z.string().describe('The requirement in a few words, as the posting states it.'),
  kind: z.string().describe(`One of: ${REQUIREMENT_KINDS.join(', ')}.`),
  mustHave: z.boolean(),
  status: z.string().describe('One of: have, partial, lack, unknown.'),
  evidence: z.string().nullable().describe('The knowledge base key from inside the square brackets, such as skill/Laravel. Null for unknown.'),
})

export const PostingExtractionSchema = z.object({
  compensation: CompExtractionSchema,
  requirements: z.array(RequirementSchema),
})

export type PostingExtraction = z.infer<typeof PostingExtractionSchema>

const PROMPT_TEXT_LIMIT = 15000
const MAX_REQUIREMENTS = 20

export function knowledgeKey(e: KnowledgeEntry) {
  return `${e.category}/${e.key.trim()}`
}

/** The knowledge base as one line per entry, keyed so Claude can cite it. Preferences and contact details are left out. */
export function knowledgeBlock(entries: KnowledgeEntry[]): string {
  return entries
    .filter(e => e.category !== 'preference' && !/^(email|phone|full name|github|linkedin)$/i.test(e.key.trim()))
    .map(e => `[${knowledgeKey(e)}] ${e.value.replace(/\s+/g, ' ').trim()}`)
    .join('\n')
}

const SYSTEM = 'You read job postings for a job seeker\'s automated pipeline. You copy facts exactly as written. You never invent a number, and you never say the candidate has a skill unless a knowledge base entry shows it.'

export function extractionPrompt(job: { title: string; company: string; location: string | null }, postingText: string, entries: KnowledgeEntry[]): string {
  return `Read the job posting below and do two things.

1. Compensation. Copy pay figures exactly as the posting writes them.
- base: the base salary or hourly rate. min and max as plain numbers (165000 for "$165,000" or "$165K"). period is year, month, or hour as the posting says, or null if it does not say. If several ranges are listed (by location, zone, tier, or level), take ONE range exactly as the posting lists it: the range for remote work in the United States if the posting names one; otherwise the range for locations the posting does not name individually (such as "all other locations"); otherwise the first US range listed. Never join the minimum of one range to the maximum of another. The quote is the line that states both of its figures. List the other ranges in notes.
- bonus: only a recurring bonus. A target such as "10% of base" goes in percentOfBase.
- equity: only a grant of stock, options, or RSUs to the employee. Describe it. Give dollar figures only when the posting states them. An employee stock purchase plan or a donation match is a benefit, not equity.
- benefits: list every benefit the posting names, even when it gives no dollar figure (most benefits have none). That includes health, dental and vision, 401(k) or retirement match, paid time off, parental leave, learning budget, equipment, wellness, home office or remote stipend, and life or disability insurance. For health insurance, say in detail how much the employer pays if the posting says (for example "100% of premiums"). amount only when the posting gives a US dollar amount that the employer pays or provides for that benefit. Leave amount null for a price or premium the employee pays, a count of hours or days, a percentage, or an amount in another currency; put those in detail. amountRecurrence is year, month, or one_time only when the posting says so; any other frequency (weekly, every 2 years) is unknown. percentOfBase only for a retirement match.
- quote: for every item, copy the exact words from the posting. Do not paraphrase, shorten words, or add text that is not in the posting.
- Do not calculate anything: no yearly conversions and no totals.
- If the posting states no pay, set base, bonus, and equity to null.

2. Requirements. List the requirements the posting states (skills, languages, frameworks, years of experience, domain knowledge, education, certifications), at most ${MAX_REQUIREMENTS}, most important first. A requirement is something the posting asks the candidate to have or to have done: its requirements, qualifications, "about you" or "what we're looking for" lists, and duties that name a skill. A technology named only in a description of past projects, the product, or the company is not a requirement. A technology named only in a list of the team's stack is a nice to have, unless the posting asks for experience with it. For each one:
- mustHave: true for required or minimum qualifications, and for items in a requirements, qualifications, or "about you" list that the posting does not mark otherwise. False for "nice to have", "preferred", "bonus", or "plus" items.
- status, judged ONLY against the candidate knowledge base below:
  - have: an entry directly shows it (the same technology, or stated years that meet the requirement). An entry for a specific technology also shows the general skill it is an example of: MySQL shows SQL, AWS shows cloud platforms, GitHub Actions shows CI/CD, JavaScript and Vue.js show browser and frontend work. The reverse is partial at most: a general entry does not show a product it does not name (AWS does not show ECS; Kubernetes does not show Helm). When the posting accepts alternatives ("PostgreSQL or MySQL", "Java or a similar object-oriented language", "React or another modern framework"), an entry that shows any one of them is have.
  - partial: an entry shows something close (a related technology, fewer years, a nearby domain).
  - lack: an entry contradicts it (for example the posting asks for 10+ years and the profile says 6+).
  - unknown: the knowledge base does not mention it. Use unknown rather than guessing.
- evidence: for have, partial, or lack, the key of the entry that shows it, copied exactly from inside the square brackets (for example skill/Laravel). Null for unknown.

## Candidate knowledge base
${knowledgeBlock(entries)}

## Job posting
Title: ${job.title}
Company: ${job.company}
Location: ${job.location ?? 'not stated'}

${postingText.slice(0, PROMPT_TEXT_LIMIT)}`
}

/** Keeps only requirements whose evidence names a real knowledge base entry; the rest become unknown. */
export function validateRequirements(raw: PostingExtraction['requirements'], entries: KnowledgeEntry[]): Requirement[] {
  const keys = new Map(entries.map(e => [knowledgeKey(e).toLowerCase(), knowledgeKey(e)]))
  return raw.slice(0, MAX_REQUIREMENTS).map((r) => {
    const cited = r.evidence ? keys.get(r.evidence.replace(/^\[|\]$/g, '').trim().toLowerCase()) ?? null : null
    const said = (STATUSES as readonly string[]).includes(r.status.toLowerCase().trim()) ? r.status.toLowerCase().trim() as Requirement['status'] : 'unknown'
    const status: Requirement['status'] = said !== 'unknown' && !cited ? 'unknown' : said
    const kind = (REQUIREMENT_KINDS as readonly string[]).includes(r.kind.toLowerCase().trim()) ? r.kind.toLowerCase().trim() as Requirement['kind'] : 'other'
    return { text: r.text, kind, mustHave: r.mustHave, status, evidence: status === 'unknown' ? null : cited }
  })
}

export async function extractPosting(
  job: { id: number; title: string; company: string; location: string | null },
  postingText: string,
  entries: KnowledgeEntry[],
): Promise<{ compensation: CompExtraction; requirements: Requirement[] }> {
  const out = await aiStructured(PostingExtractionSchema, {
    purpose: 'enrich',
    system: SYSTEM,
    prompt: extractionPrompt(job, postingText, entries),
    effort: 'low',
    maxTokens: 6000,
    ref: { type: 'job', id: job.id },
  })
  return { compensation: out.compensation, requirements: validateRequirements(out.requirements, entries) }
}
