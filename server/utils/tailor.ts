import { z } from 'zod'
import type { InferSelectModel } from 'drizzle-orm'
import type { jobs } from '../db/schema'
import type { TailoredResume } from '#shared/types/pipeline'
import { aiStructured, cachedPrompt } from './ai'
import type { KnowledgeEntry } from './knowledge'
import { htmlToText } from './review'
import { evidenceReport, joinKeptParagraphs, knowledgeForPrompt, knowledgeText, verifyClaims, type ClaimLine, type ClaimOutcome } from './apply/evidence'
import { dropRepeats, normalizeLabel, periodText, scrubDashes, splitSentences } from './apply/text'

type JobRow = InferSelectModel<typeof jobs>

// Resume tailoring in two Claude calls:
// 1. reframe and reorder Devin's real experience for one posting;
// 2. check every summary sentence and bullet against the knowledge base, then rewrite or
//    drop what has no source.
// Company names, titles, dates, and education always come straight from the knowledge base,
// never from the model, so the structure of the resume cannot drift from the record.

export interface KbJob {
  key: string
  company: string
  title: string
  period: string
  location: string | null
  lines: string[]
}

/** "Applied Imagination - Senior Developer" + "Oct 2021 - Present | Remote\n\n- ..." */
export function parseExperience(entries: KnowledgeEntry[]): KbJob[] {
  return entries.filter(e => e.category === 'experience').map((e) => {
    const [company, ...titleParts] = e.key.split(/\s+-\s+/)
    const firstLine = e.value.split('\n')[0] ?? ''
    const [period, location] = firstLine.split('|').map(s => s.trim())
    const lines = e.value.split('\n').map(l => l.trim()).filter(l => l.startsWith('- ')).map(l => l.slice(2).trim())
    return {
      key: e.key,
      company: (company ?? e.key).trim(),
      title: titleParts.join(' - ').trim() || 'Developer',
      period: periodText(period ?? ''),
      location: location || null,
      lines,
    }
  })
}

export function parseEducation(entries: KnowledgeEntry[]): TailoredResume['education'] {
  return entries.filter(e => e.category === 'education').map((e) => {
    const [degree] = e.value.split('|').map(s => s.trim())
    return { institution: e.key.trim(), degree: degree || '', year: '' }
  })
}

/** Whole-word, case-insensitive mention, so "Go" does not match "good" and "C#" still matches. */
export function mentions(haystackLower: string, term: string): boolean {
  const t = term.trim().toLowerCase()
  if (!t) return false
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(haystackLower)
}

export function postingTextOf(job: JobRow): string {
  return (job.postingText || htmlToText(job.description) || `${job.title} at ${job.company}`).slice(0, 14000)
}

const TailorSchema = z.object({
  summary: z.string().describe('Two or three sentences aimed at this role, built only from the knowledge base'),
  experience: z.array(z.object({
    key: z.string().describe('The experience key exactly as written in the knowledge base, e.g. "Applied Imagination - Senior Developer"'),
    bullets: z.array(z.string()).describe('Two to five bullets for this job, most relevant to the posting first'),
  })).describe('One entry for every experience key in the knowledge base'),
  skills: z.array(z.object({
    category: z.string().describe('e.g. "Languages", "Frameworks", "Data", "Cloud and DevOps"'),
    items: z.array(z.string()),
  })),
  projects: z.array(z.object({
    key: z.string().describe('A project key exactly as written in the knowledge base'),
    description: z.string().describe('One sentence about the project, from the knowledge base'),
  })).describe('Knowledge base projects worth listing for this role. Empty when none fit.'),
  tailoringNotes: z.string().describe('Two to four sentences: what you emphasized for this posting and why'),
})

const TAILOR_SYSTEM = `You tailor Devin Hollister-Graham's resume to one job posting.
Rules you must follow:
- Use only facts in the KNOWLEDGE BASE. Never add a skill, tool, employer, title, number, metric, team size, date, degree, or result that it does not state.
- Reframe and reorder: choose the most relevant accomplishments and responsibilities for each job, lead with what the posting asks for, and use the posting's wording only where the knowledge base already supports it.
- Keep every number exactly as the knowledge base states it. Do not round, combine, or estimate numbers.
- Include every job in the knowledge base, using its key exactly as written.
- Skills: list only skills the knowledge base names, one skill per item with no parentheses (write "Vue.js", not "Vue.js (Vue 3)"). Put the ones the posting asks for first.
- Never mention a skill he lacks or has not used.
- Write in plain American English. Bullets start with a past-tense verb (present tense for the current job is fine). No first person in bullets.
- Never use an em dash or an en dash.`

export interface TailorResult {
  resume: TailoredResume
  evidence: ClaimOutcome[]
  notes: string
}

export async function tailorResumeForJob(job: JobRow, entries: KnowledgeEntry[], ref?: { type: string; id: number }): Promise<TailorResult> {
  const kbJobs = parseExperience(entries)
  const projectsKb = entries.filter(e => e.category === 'project')
  const posting = postingTextOf(job)

  const draft = await aiStructured(TailorSchema, {
    purpose: 'tailor',
    system: TAILOR_SYSTEM,
    effort: 'high',
    maxTokens: 6000,
    ref,
    // The knowledge base and its keys are a cached prefix; the posting follows.
    prompt: cachedPrompt([`KNOWLEDGE BASE
${knowledgeForPrompt(entries)}

EXPERIENCE KEYS (use these exactly)
${kbJobs.map(j => `- ${j.key}`).join('\n')}${projectsKb.length ? `\n\nPROJECT KEYS\n${projectsKb.map(p => `- ${p.key}`).join('\n')}` : ''}`], `

TARGET POSTING: ${job.title} at ${job.company}
${posting}`),
  })

  // Assemble from the knowledge base structure; the model only supplies wording.
  const byKey = new Map(draft.experience.map(e => [normalizeLabel(e.key), e]))
  const experience = kbJobs.map((kj) => {
    const hit = byKey.get(normalizeLabel(kj.key))
      ?? draft.experience.find(e => normalizeLabel(e.key).includes(normalizeLabel(kj.company)))
    const bullets = (hit?.bullets ?? []).map(b => scrubDashes(b.trim())).filter(Boolean)
    return { company: kj.company, title: kj.title, period: kj.period, bullets: bullets.length ? bullets : kj.lines.slice(0, 3) }
  })

  const projects = draft.projects
    .map((p) => {
      const kb = projectsKb.find(e => normalizeLabel(e.key) === normalizeLabel(p.key))
      return kb ? { name: kb.key, description: scrubDashes(p.description.trim()), url: null } : null
    })
    .filter((p): p is NonNullable<typeof p> => !!p)

  // Skills: keep only items the knowledge base names somewhere.
  const kbSkillNames = entries.filter(e => e.category === 'skill').map(e => normalizeLabel(e.key))
  const kbLower = knowledgeText(entries).toLowerCase()
  const droppedSkills: string[] = []
  const skills: Record<string, string[]> = {}
  const known = (item: string) => {
    const n = normalizeLabel(item)
    return kbSkillNames.includes(n) || kbSkillNames.some(k => k.split(' ').includes(n)) || mentions(kbLower, item)
  }
  for (const group of draft.skills) {
    const kept: string[] = []
    for (const raw of group.items) {
      const item = scrubDashes(raw.trim())
      const m = item.match(/^([^()]+)\(([^)]*)\)\s*$/)
      const base = m ? m[1]!.trim() : item
      if (!known(base)) { droppedSkills.push(item); continue }
      const details = m ? m[2]!.split(',').map(d => d.trim()).filter(Boolean) : []
      if (details.length && details.every(known)) kept.push(item)
      else { kept.push(base); if (details.length) droppedSkills.push(`${item} (kept as "${base}")`) }
    }
    const unique = [...new Set(kept)]
    if (unique.length) skills[scrubDashes(group.category)] = unique
  }

  // Evidence check on every sentence and bullet.
  const summarySentences = splitSentences(scrubDashes(draft.summary))
  const lines: ClaimLine[] = [
    ...summarySentences.map((s, i) => ({ id: `S${i + 1}`, text: s })),
    ...experience.flatMap((e, i) => e.bullets.map((b, j) => ({ id: `E${i}.B${j}`, text: `${b} (as ${e.title} at ${e.company})` }))),
    ...projects.map((p, i) => ({ id: `P${i}`, text: `${p.name}: ${p.description}` })),
  ]
  const evidence = await verifyClaims(lines, { entries, purpose: 'tailor_verify', ref })
  const finalOf = (id: string) => evidence.find(o => o.id === id)?.final ?? null
  const stripContext = (s: string) => s.replace(/\s*\(as [^)]*\)\s*$/, '').trim()

  // dropRepeats is the last guard: a sentence that already appeared is dropped before the resume is stored.
  const summary = dropRepeats(joinKeptParagraphs([summarySentences], evidence, (_, j) => `S${j + 1}`).join(' '))
    || entries.find(e => e.category === 'profile' && /summary/i.test(e.key))?.value
    || ''
  const verifiedExperience = experience.map((e, i) => {
    const kept = e.bullets.map((_, j) => finalOf(`E${i}.B${j}`)).filter((b): b is string => !!b).map(stripContext)
    // A job left with no bullets falls back to the knowledge base's own lines, which are the source.
    return { ...e, bullets: kept.length ? kept : (kbJobs[i]?.lines.slice(0, 2) ?? []) }
  })
  const verifiedProjects = projects
    .map((p, i) => {
      const f = finalOf(`P${i}`)
      return f ? { ...p, description: f.replace(new RegExp(`^${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*`), '') } : null
    })
    .filter((p): p is NonNullable<typeof p> => !!p)

  const notesParts = [
    scrubDashes(draft.tailoringNotes.trim()),
    evidenceReport('Resume evidence check', evidence),
  ]
  if (droppedSkills.length) notesParts.push(`Skills removed because the knowledge base does not name them: ${[...new Set(droppedSkills)].join(', ')}`)
  const notes = notesParts.join('\n\n')

  return {
    resume: {
      summary,
      experience: verifiedExperience,
      skills,
      education: parseEducation(entries),
      projects: verifiedProjects,
      tailoringNotes: notes,
      generatedQuestions: [],
    },
    evidence,
    notes,
  }
}
