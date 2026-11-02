import { and, eq, inArray } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { decisions, jobs, questions } from '../db/schema'
import type { RejectSkillOption, RejectSkillsMode, RejectSkillsRecord, Requirement, ScoreBreakdown } from '#shared/types/pipeline'
import { loadKnowledge, upsertKnowledge } from './knowledge'
import { ruleTerm } from './learned-score'
import { GENERIC_TERMS } from './learning'
import { answerQuestion, cleanSkillSubject, findKnowledgeEntry, isNegativeKnowledge, negativeSkillValue } from './questions'
import { parseJson } from './review'

// "Wrong tech stack" rejections that name the skills at fault. The dialog offers the job's
// requirements as chips; the reject route validates the picks here, learning makes evidence
// only for them, and "I don't have these" writes each one to the knowledge base as a No.

type JobRow = InferSelectModel<typeof jobs>

const MAX_SKILLS = 20
const MAX_SKILL_LENGTH = 80
const MAX_OPTIONS = 24

/** "Nice to have: Go in production" names Go in production. */
const OPTIONAL_PREFIX = /^(nice to have|nice-to-have|bonus|plus|a plus|preferred|optional|desired)\s*:\s*/i
/** Requirements that are tasks rather than skills ("Run CI/CD in GitHub Actions", "Design MySQL schemas"). */
const TASK_START = /^(run|build|deploy|design|tune|write|lead|leading|own|ship|manage|create|develop|implement|maintain|drive|work|collaborate|communicate|mentor|mentoring|identify|resolve)\b/i
/** Requirement kinds that never name a stack. */
const NOT_STACK_KINDS = new Set<Requirement['kind']>(['education', 'certification'])
/** Requirement kinds whose lists ("Ruby, Java, Go, or Python") are split into one chip per skill. */
const SPLIT_KINDS = new Set<Requirement['kind']>(['skill', 'language', 'framework', 'domain'])
const STATUS_ORDER: Record<Requirement['status'], number> = { lack: 0, unknown: 0, partial: 1, have: 2 }

/** The short skill name a requirement line names, or null when it is generic or not a skill. */
export function rejectSkillLabel(text: string): string | null {
  const label = cleanSkillSubject(text.replace(OPTIONAL_PREFIX, '').trim())
  if (!label || TASK_START.test(label)) return null
  const term = ruleTerm(label)
  return term && !GENERIC_TERMS.has(term) ? label : null
}

/** One label per skill in a list requirement: "a language like Ruby, Java, Go, or Python" gives Ruby, Java, Go, Python. */
function listLabels(text: string): string[] {
  let t = text.replace(OPTIONAL_PREFIX, '')
  const example = t.match(/\b(?:like|such as|e\.g\.?|including|for example)\s+(.+)$/i)
  if (example) t = example[1]!
  return t.split(/,|\/|&|;|\s+or\s+|\s+and\s+/i)
    .map(p => p.replace(/^\s*(or|and)\s+/i, '').trim())
    .map(rejectSkillLabel)
    .filter((l): l is string => !!l && l.split(' ').length <= 2)
}

/**
 * Skills the knowledge base now says Devin does not have, as rule terms. A requirement's status
 * was judged when the job was enriched; a No saved since (an answer, or a rejection here) wins.
 */
export function negativeSkillTerms(): Set<string> {
  const out = new Set<string>()
  for (const e of loadKnowledge()) {
    if ((e.category !== 'skill' && e.category !== 'experience') || !isNegativeKnowledge(e.value)) continue
    const t = ruleTerm(e.key.replace(/^has done:\s*/i, ''))
    if (t) out.add(t)
  }
  return out
}

/**
 * The chips the reject dialog offers under "Wrong tech stack": lack and unknown first, then
 * partial, then the ones the knowledge base says Devin has. Generic requirements are left out.
 */
export function rejectSkillOptions(requirements: Requirement[], negative: Set<string> = new Set()): RejectSkillOption[] {
  const all: Array<RejectSkillOption & { term: string; i: number }> = []
  requirements.forEach((r, i) => {
    if (!r?.text || NOT_STACK_KINDS.has(r.kind)) return
    const one = rejectSkillLabel(r.text)
    const labels = one ? [one] : SPLIT_KINDS.has(r.kind) ? listLabels(r.text) : []
    for (const label of labels) {
      const term = ruleTerm(label)
      if (term) all.push({ label, term, i, status: negative.has(term) ? 'lack' : r.status, requirement: r.text })
    }
  })
  all.sort((a, b) => (STATUS_ORDER[a.status] ?? 0) - (STATUS_ORDER[b.status] ?? 0) || a.i - b.i)
  const out: RejectSkillOption[] = []
  const seen = new Set<string>()
  for (const o of all) {
    if (seen.has(o.term)) continue
    seen.add(o.term)
    out.push({ label: o.label, status: o.status, requirement: o.requirement })
  }
  return out.slice(0, MAX_OPTIONS)
}

function norm(s: string) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Validates the optional skills and skillsMode of a reject body against the job.
 * Each skill must be one of the job's requirement texts, chip labels, skills, or tags.
 * Returns null when no skills were named, so the rejection learns as it always did.
 */
export function resolveRejectSkills(job: JobRow, reasonCode: string, rawSkills: unknown, rawMode: unknown): RejectSkillsRecord | null {
  if (rawSkills == null || (Array.isArray(rawSkills) && rawSkills.length === 0)) return null
  if (!Array.isArray(rawSkills)) throw createError({ statusCode: 400, statusMessage: 'skills must be a list of skill names' })
  if (reasonCode !== 'wrong_stack') throw createError({ statusCode: 400, statusMessage: 'Skills can only be named for Wrong tech stack' })
  if (rawSkills.length > MAX_SKILLS) throw createError({ statusCode: 400, statusMessage: `Pick at most ${MAX_SKILLS} skills` })
  const mode: RejectSkillsMode = rawMode == null ? 'lack' : rawMode as RejectSkillsMode
  if (mode !== 'lack' && mode !== 'avoid') throw createError({ statusCode: 400, statusMessage: 'skillsMode must be "lack" or "avoid"' })

  const requirements = parseJson<Requirement[]>(job.requirementsJson, [])
  const score = parseJson<ScoreBreakdown | null>(job.scoreBreakdown, null)
  // Value Devin may send, to the skill name learning and the knowledge base use.
  const allowed = new Map<string, string>()
  for (const o of rejectSkillOptions(requirements)) allowed.set(norm(o.label), o.label)
  const raw = [
    ...requirements.map(r => r?.text),
    ...(score?.skills.missing ?? []),
    ...(score?.skills.matched ?? []),
    ...parseJson<string[]>(job.tags, []),
  ].filter((s): s is string => typeof s === 'string' && !!s.trim())
  for (const s of raw) if (!allowed.has(norm(s))) allowed.set(norm(s), rejectSkillLabel(s) ?? s.trim().replace(/\s+/g, ' '))

  const skills: RejectSkillsRecord['skills'] = []
  const seen = new Set<string>()
  for (const s of rawSkills) {
    if (typeof s !== 'string') throw createError({ statusCode: 400, statusMessage: 'Each skill must be text' })
    const value = s.trim().replace(/\s+/g, ' ')
    if (!value) continue
    if (value.length > MAX_SKILL_LENGTH) throw createError({ statusCode: 400, statusMessage: `Each skill must be ${MAX_SKILL_LENGTH} characters or fewer` })
    const label = allowed.get(norm(value))
    if (!label) throw createError({ statusCode: 400, statusMessage: `"${value}" is not one of this job's requirements` })
    const term = ruleTerm(label)
    if (!term || seen.has(term)) continue
    seen.add(term)
    // A skill the knowledge base says Devin has is never overwritten from the reject dialog;
    // "I don't have these" then only lowers jobs that ask for it.
    const existing = mode === 'lack' ? findKnowledgeEntry('skill', label) : null
    const kept = !!existing && !isNegativeKnowledge(existing.value)
    skills.push(kept ? { value, label, term, kept } : { value, label, term })
  }
  return skills.length ? { mode, skills } : null
}

/**
 * "I don't have these": writes each named skill to the knowledge base as a No (the same entry a
 * No answer to "Have you used X?" writes, so it is never claimed), and answers every pending
 * knows or has_done question about the skill with No through the normal answer path, which
 * refreshes the applications waiting on it and rescores the jobs it touches.
 * Never writes a positive value. Runs after onDecision() so those rescores see the new rules.
 * The outcome is stored on the decision's features_json.
 */
export async function applyRejectSkillKnowledge(decisionId: number, record: RejectSkillsRecord, job: Pick<JobRow, 'title' | 'company'>): Promise<NonNullable<RejectSkillsRecord['knowledge']>> {
  const db = useDb()
  const outcome: NonNullable<RejectSkillsRecord['knowledge']> = { written: [], questionsAnswered: [], errors: [] }
  if (record.mode !== 'lack') return outcome
  const pending = db.select().from(questions)
    .where(and(eq(questions.status, 'pending'), inArray(questions.kind, ['knows', 'has_done'])))
    .all()
  for (const skill of record.skills.filter(s => !s.kept)) {
    let knowsAnswered = false
    for (const q of pending.filter(q => q.subject && ruleTerm(q.subject) === skill.term)) {
      if (outcome.questionsAnswered.includes(q.id)) continue
      try {
        const res = await answerQuestion(q.id, 'No')
        outcome.questionsAnswered.push(q.id)
        if (res.knowledge) outcome.written.push({ category: res.knowledge.category, key: res.knowledge.key, replaced: null })
        if (q.kind === 'knows') knowsAnswered = true
      }
      catch (e: any) {
        const msg = `Question ${q.id} (${q.subject}): ${e?.statusMessage || e?.message || String(e)}`
        console.error(`[reject-skills] could not answer ${msg}`)
        outcome.errors.push(msg)
      }
    }
    // A knows question answered No has written skill:<subject> already.
    if (knowsAnswered) continue
    try {
      const existing = findKnowledgeEntry('skill', skill.label)
      // An entry that already says No keeps its own wording; a positive one is never overwritten here.
      if (existing) continue
      const key = existing?.key ?? skill.label
      const value = negativeSkillValue(skill.label, `(Said when rejecting ${job.title} at ${job.company} for the wrong tech stack.)`)
      upsertKnowledge('skill', key, value, 'user_answer')
      outcome.written.push({ category: 'skill', key, replaced: existing ? existing.value.slice(0, 300) : null })
    }
    catch (e: any) {
      const msg = `Knowledge for ${skill.label}: ${e?.message || String(e)}`
      console.error(`[reject-skills] could not write ${msg}`)
      outcome.errors.push(msg)
    }
  }
  const d = db.select().from(decisions).where(eq(decisions.id, decisionId)).get()
  if (d) {
    const f = parseJson<Record<string, unknown>>(d.featuresJson, {})
    db.update(decisions)
      .set({ featuresJson: JSON.stringify({ ...f, rejectSkills: { ...record, knowledge: outcome } }) })
      .where(eq(decisions.id, decisionId))
      .run()
  }
  return outcome
}
