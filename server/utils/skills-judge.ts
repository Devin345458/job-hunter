import { and, eq, inArray } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { questions } from '../db/schema'
import type { GapAnalysis, GapItem, Requirement, ScoreBreakdown } from '#shared/types/pipeline'
import { isProfileFact, isSoftSkill } from '#shared/utils/requirement-kinds'
import { plainQuestionContext } from '#shared/utils/plain-text'
import { availableToolchains, primaryLanguage } from './demo/exec'
import { demoLanguageName, noIdeaSentence, noToolchainSentence, oneDemoSentence, tooLargeSentence, wrongLanguageSentence } from './demo/gap-text'
import type { KnowledgeEntry } from './knowledge'

// Decide-first: the gap analysis is part of scoring. One scoring call judges every posting
// requirement against the knowledge base and says, for each one Devin does not plainly have,
// whether real experience covers it (reframe, citing the entry), whether to ask him (the knowledge
// base is silent), or whether it is truly missing. This module turns those judgments into the
// final requirement statuses, the must-have part of the skills score, and the gap plan, in code,
// so the card's Matched and Missing, the score, and the gap plan come from one set of statuses.
//
// Rules enforced here, whatever the model said:
// - Evidence: have, reframe, partial, and lack must cite a knowledge base entry that exists. A
//   reframe without one is unknown. An answered question counts through the entry its answer wrote.
// - Devin's answers win: Yes is have, Some experience is partial, No is lack.
// - Profile facts (work authorization, location, degrees) and soft skills are never gaps and are
//   left out of the must-have share, as the card leaves them out of Missing.
// - No question is created here (scoring runs for every job). An ask item points at an existing
//   question when there is one; the read-forms step asks the rest for jobs that reach the threshold.

type QuestionRow = InferSelectModel<typeof questions>

/** One requirement as the scoring call judged it. index is 1-based, as the prompt numbers them. */
export interface RequirementJudgment {
  index: number
  status: string
  evidence: string | null
  subject: string
  askKind: string
  question: string | null
  codeShowable: boolean
  rationale: string
  demoIdea?: { title: string; summary: string; stack: string[]; scopeHours: number } | null
  /** False for the gap plan's leave-out kinds (soft skills, attitudes, leadership, years, education, authorization, location). */
  inGapPlan?: boolean
}

export interface JudgedSkills {
  /** The posting requirements with their final statuses, written back to jobs.requirements_json. */
  requirements: Requirement[]
  gap: GapAnalysis
  /** 0 to 45 from the final statuses; null when no countable must-have was extracted (the model's part is used). */
  mustHaves: number | null
  matched: string[]
  missing: string[]
}

export const MUST_HAVE_POINTS = 45
const MAX_DEMO_HOURS = 6

const YES = /^(y|yes|yeah|yep|true|i have|i do)\b/i
const SOME = /^(some|partly|a little|somewhat)\b/i
const NO = /^(n|no|nope|false|never|i have not|i haven't|i do not|i don't|not really)\b/i

/** Requirements that count toward the must-have share and can be gaps: not profile facts, not soft skills. */
export function countable(r: Pick<Requirement, 'text'>): boolean {
  return !isProfileFact(r.text) && !isSoftSkill(r.text)
}

/** "8+ years of experience ...", "3+ years with Go": counted in the score, never a gap a project or a question closes. */
const YEARS = /^\s*(?:at least\s+|minimum (?:of\s+)?)?\d+\s*\+?\s*(?:or more\s+)?(?:years?|yrs?)\b/i

/** Requirements the gap plan leaves out, as the old gap step did: years, education, certifications, and what the call marks. */
function leftOutOfPlan(r: Pick<Requirement, 'text' | 'kind'>, j: Pick<RequirementJudgment, 'inGapPlan'>): boolean {
  return j.inGapPlan === false || YEARS.test(r.text) || r.kind === 'education' || r.kind === 'certification'
}

/** "6+" in profile/Years of Experience, as a number. Null when the profile states none. */
function profileYears(entries: KnowledgeEntry[]): { years: number; key: string } | null {
  const e = entries.find(x => x.category === 'profile' && /years of experience/i.test(x.key))
  const n = e ? Number(/\d+/.exec(e.value)?.[0]) : Number.NaN
  return e && Number.isFinite(n) ? { years: n, key: entryKey(e) } : null
}

/**
 * A plain years requirement ("8+ years of software engineering") against the profile's years:
 * more than the profile states is lack, the same or fewer is have. The comparison is arithmetic,
 * so code makes it whatever the call said. Years with a named technology ("3+ years with Go") are
 * left to the call, since the profile's total does not say how long Devin used Go.
 */
function yearsStatus(r: Pick<Requirement, 'text'>, profile: { years: number; key: string } | null): { status: 'have' | 'lack'; evidence: string } | null {
  if (!profile) return null
  const m = /^\s*(?:at least\s+|minimum (?:of\s+)?)?(\d+)\s*\+?\s*(?:or more\s+)?(?:years?|yrs?)\b(?:\s+of)?\s*(.*)$/i.exec(r.text)
  if (!m) return null
  const rest = m[2]!.toLowerCase()
  const general = /^(?:professional\s+|relevant\s+|hands-on\s+|industry\s+)?(?:experience|software|engineering|development|building|web|full[- ]?stack|programming)\b/.test(rest) || rest === ''
  if (!general) return null
  return { status: Number(m[1]) > profile.years ? 'lack' : 'have', evidence: profile.key }
}

const SUBJECT_STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'with', 'for', 'to', 'on', 'making', 'building', 'using', 'working', 'experience', 'approach', 'strong', 'proven', 'knowledge', 'skills', 'skill', 'ability', 'years', 'year', 'plus'])

function subjectTokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9+#.\s-]/g, ' ').split(/[\s-]+/)
    .filter(w => w && !/^\d+\+?$/.test(w) && !SUBJECT_STOP.has(w))
    .map(w => w.slice(0, 6)))
}

/**
 * The same subject in other words: "Non-deterministic systems reliability" and "Making
 * non-deterministic systems reliable". Exact dedupe keys first; then most of the shorter
 * subject's words (cut to six letters) must appear in the longer one, and at least two words,
 * so "Go" never matches "Google Cloud".
 */
export function sameSubject(a: string, b: string): boolean {
  if (dedupeKeyOf('knows', a) === dedupeKeyOf('knows', b)) return true
  const x = subjectTokens(a)
  const y = subjectTokens(b)
  const [small, large] = x.size <= y.size ? [x, y] : [y, x]
  if (small.size < 2) return false
  const shared = [...small].filter(w => large.has(w)).length
  return shared / small.size >= 0.75
}

function matching(subject: string, rows: QuestionRow[], status: string): QuestionRow[] {
  const keys = new Set([dedupeKeyOf('has_done', subject), dedupeKeyOf('knows', subject)])
  const exact = rows.filter(r => r.status === status && keys.has(r.dedupeKey ?? ''))
  return exact.length ? exact : rows.filter(r => r.status === status && !!r.subject && sameSubject(subject, r.subject))
}

/** The must-have share from final statuses: have 1, partial a half, anything else 0. Null with no countable must-have. */
export function mustHavePoints(reqs: Requirement[]): number | null {
  const must = reqs.filter(r => r.mustHave && countable(r))
  if (!must.length) return null
  const credit = must.reduce((n, r) => n + (r.status === 'have' ? 1 : r.status === 'partial' ? 0.5 : 0), 0)
  return Math.round((MUST_HAVE_POINTS * credit) / must.length)
}

function entryKey(e: KnowledgeEntry) {
  return `${e.category}/${e.key.trim()}`
}

/** "skill/Laravel", "[skill/Laravel]", or "skill:Laravel" resolved to the entry's own key, or null. */
export function resolveEvidence(raw: string | null | undefined, entries: KnowledgeEntry[]): string | null {
  if (!raw) return null
  const want = raw.replace(/^\[|\]$/g, '').replace(/^([a-z]+):/i, '$1/').trim().toLowerCase()
  return entries.map(entryKey).find(k => k.toLowerCase() === want) ?? null
}

/** Devin's answer about a subject (knows or has_done), and the knowledge base entry it wrote. */
function answerFor(subject: string, rows: QuestionRow[]): { answer: string; id: number; knowledgeKey: string | null } | null {
  const hits = matching(subject, rows, 'answered').filter(r => r.answer)
  const row = hits.find(r => r.kind === 'has_done') ?? hits[0]
  return row ? { answer: row.answer!.trim(), id: row.id, knowledgeKey: row.knowledgeKey } : null
}

function pendingFor(subject: string, rows: QuestionRow[]): QuestionRow | null {
  return matching(subject, rows, 'pending')[0] ?? null
}

function skippedFor(subject: string, rows: QuestionRow[]): boolean {
  return matching(subject, rows, 'skipped').length > 0
}

/** Knows and has_done questions in every state, loaded once per scoring call. */
export function skillQuestions(): QuestionRow[] {
  return useDb().select().from(questions)
    .where(and(inArray(questions.kind, ['has_done', 'knows']), inArray(questions.status, ['pending', 'answered', 'skipped'])))
    .all()
}

function normStatus(s: string): 'have' | 'reframe' | 'partial' | 'lack' | 'unknown' {
  const v = s.toLowerCase().trim()
  if (v.startsWith('reframe') || v.startsWith('covered')) return 'reframe'
  if (v === 'have' || v === 'partial' || v === 'lack') return v
  return 'unknown'
}

/** Languages the demo build server has, for the demo hard rules. */
async function demoLanguages(): Promise<string[]> {
  try {
    return [...new Set((await availableToolchains()).flatMap(t => t.languages))]
  }
  catch {
    return []
  }
}

/**
 * Final statuses, the must-have share, and the gap plan from one scoring call's judgments.
 * Requirements the call did not judge keep their stored status.
 */
export async function applyJudgments(reqs: Requirement[], judgments: RequirementJudgment[], entries: KnowledgeEntry[], rows: QuestionRow[] = skillQuestions()): Promise<JudgedSkills> {
  const analyzedAt = new Date().toISOString()
  const years = profileYears(entries)
  const items: GapItem[] = []
  const confirmed: Array<{ item: GapItem; subject: string; lack: boolean; j: RequirementJudgment }> = []
  const seen = new Set<string>()

  const requirements = reqs.map((r, i): Requirement => {
    const j = judgments.find(x => x.index === i + 1)
    if (!j) return r
    const subject = (j.subject || r.text).trim()
    const cited = resolveEvidence(j.evidence, entries)
    let status = normStatus(j.status)
    let note: string | null = null
    // Evidence rule: a status that claims something about Devin needs an entry that exists.
    if (status !== 'unknown' && !cited) status = 'unknown'
    let evidence = status === 'unknown' ? null : cited
    const byYears = yearsStatus(r, years)
    if (byYears) {
      status = byYears.status
      evidence = byYears.evidence
    }

    const answered = countable(r) ? answerFor(subject, rows) : null
    if (answered) {
      const wrote = resolveEvidence(answered.knowledgeKey, entries)
      if (YES.test(answered.answer)) { status = 'have'; evidence = wrote ?? evidence }
      else if (SOME.test(answered.answer)) { status = 'partial'; evidence = wrote ?? evidence }
      else if (NO.test(answered.answer)) { status = 'lack'; evidence = wrote ?? evidence }
      note = `You answered "${answered.answer}" when asked about ${subject}.`
    }

    const out: Requirement = {
      ...r,
      status: status === 'reframe' ? 'have' : status,
      evidence,
      reframed: status === 'reframe' || undefined,
      note: status === 'reframe' ? j.rationale.trim() || null : note,
    }
    if (!countable(r) || leftOutOfPlan(r, j)) return out

    // The gap plan: everything Devin does not plainly have, once per subject.
    const key = subject.toLowerCase()
    if (status === 'have' || seen.has(key)) return out
    seen.add(key)
    const base: GapItem = { requirement: r.text, mustHave: r.mustHave, decision: 'skip', rationale: '', demoIdea: null, questionId: answered?.id ?? null, evidence, subject }
    if (status === 'reframe') {
      items.push({ ...base, decision: 'reframe', rationale: j.rationale.trim() || `Your ${evidence} experience covers this.` })
      return out
    }
    if (status === 'unknown') {
      if (skippedFor(subject, rows)) {
        items.push({ ...base, decision: 'skip', rationale: `The knowledge base does not mention ${subject} and you skipped the question about it.` })
        return out
      }
      const pending = pendingFor(subject, rows)
      const askKind = j.askKind === 'has_done' ? 'has_done' : 'knows'
      const question = (j.question ?? '').trim() || `Have you worked with ${subject}?`
      items.push({
        ...base,
        decision: 'ask',
        questionId: pending?.id ?? null,
        rationale: `The knowledge base does not say whether you have ${subject}.${pending ? ` Asked: "${pending.question}"` : ''}`,
        ask: { kind: askKind, question, codeShowable: j.codeShowable },
      })
      return out
    }
    if (!j.codeShowable) {
      items.push({ ...base, decision: 'skip', rationale: j.rationale.trim() || `${subject} is experience a code project cannot show, so no demo is planned.` })
      return out
    }
    confirmed.push({ item: base, subject, lack: status === 'lack', j })
    return out
  })

  // Truly missing and showable in code: the demo decision is recorded with the same hard rules as
  // before (a toolchain on the build server, the right language, about four hours, one per job).
  // Builds stay off while NUXT_DEMOS_ENABLED is false; nothing here builds anything.
  if (confirmed.length) {
    const languages = await demoLanguages()
    for (const c of confirmed) {
      const idea = c.j.demoIdea ?? null
      const item: GapItem = { ...c.item, decision: idea ? 'demo' : 'skip', rationale: c.j.rationale.trim(), demoIdea: idea }
      if (item.decision === 'demo' && idea) {
        const lang = primaryLanguage(idea.stack ?? [])
        const subjectLang = primaryLanguage([c.subject])
        if (!languages.includes(lang)) { item.decision = 'skip'; item.rationale = noToolchainSentence(c.subject, demoLanguageName(lang, [c.subject, ...idea.stack])); item.demoIdea = null }
        else if (subjectLang !== 'other' && subjectLang !== lang) { item.decision = 'skip'; item.rationale = wrongLanguageSentence(c.subject, demoLanguageName(lang, idea.stack)); item.demoIdea = null }
        else if (idea.scopeHours > MAX_DEMO_HOURS) { item.decision = 'skip'; item.rationale = tooLargeSentence(c.subject, idea.scopeHours); item.demoIdea = null }
      }
      else if (!item.rationale) {
        item.rationale = noIdeaSentence(c.subject)
      }
      items.push(item)
    }
    const demos = items.filter(i => i.decision === 'demo')
    if (demos.length > 1) {
      const lackOf = new Map(confirmed.map(c => [c.item.requirement, c.lack]))
      const rank = (i: GapItem) => (lackOf.get(i.requirement) ? 0 : 2) + (i.mustHave ? 0 : 1)
      const keep = [...demos].sort((a, b) => rank(a) - rank(b))[0]!
      for (const i of demos) {
        if (i === keep) continue
        i.decision = 'skip'
        i.rationale = oneDemoSentence(i.subject, keep.demoIdea?.title)
        i.demoIdea = null
      }
    }
  }

  const count = (d: GapItem['decision']) => items.filter(i => i.decision === d).length
  const demo = items.find(i => i.decision === 'demo')
  const parts = [
    demo ? `Demo idea: ${demo.demoIdea?.title} (for ${demo.requirement}).` : 'No demo planned.',
    count('reframe') ? `${count('reframe')} covered by existing experience.` : null,
    count('ask') ? `${count('ask')} to confirm with you.` : null,
    count('skip') ? `${count('skip')} truly missing.` : null,
  ].filter(Boolean)
  const gap: GapAnalysis = {
    items,
    demoRecommended: Boolean(demo),
    summary: items.length ? `${items.length} ${items.length === 1 ? 'gap' : 'gaps'}. ${parts.join(' ')}` : 'No gaps: the knowledge base covers every requirement.',
    analyzedAt,
  }
  // Short names, as the old call returned them: learning turns matched names into rule terms.
  const label = (r: Requirement) => {
    const i = reqs.findIndex(x => x.text === r.text)
    return (judgments.find(x => x.index === i + 1)?.subject || r.text).trim()
  }
  return {
    requirements,
    gap,
    mustHaves: mustHavePoints(requirements),
    matched: requirements.filter(r => countable(r) && (r.status === 'have' || r.status === 'partial')).map(label).slice(0, 15),
    missing: requirements.filter(r => r.mustHave && countable(r) && (r.status === 'lack' || r.status === 'unknown')).map(label).slice(0, 15),
  }
}

/** The gap plan the job's scoring call made, or null for a job scored before decide-first. */
export function scoredGap(job: { scoreBreakdown: string | null }): GapAnalysis | null {
  try {
    const b = job.scoreBreakdown ? JSON.parse(job.scoreBreakdown) as ScoreBreakdown : null
    return b?.skills?.gap ?? null
  }
  catch {
    return null
  }
}

function asSentence(requirement: string): string {
  return `${plainQuestionContext(requirement).trim().replace(/[.\s]+$/, '')}.`
}

/**
 * For a job that reached the threshold (its Decide card is being made): asks the gap plan's open
 * questions that no question covers yet, on that application, and returns the plan with their ids.
 * Never for sandbox jobs, which create no questions.
 */
export function askGapQuestions(gap: GapAnalysis, ctx: { applicationId: number; job: { id: number; title: string; company: string; isSandbox: boolean } }, previous: GapAnalysis | null = null): GapAnalysis {
  // A question this card already asked for the same requirement or subject is kept, whatever the
  // new call called it, so a rescore never asks the same thing twice.
  const carried = gap.items.map((i) => {
    if (i.decision !== 'ask' || i.questionId) return i
    const before = previous?.items.find(p => p.questionId && (p.requirement === i.requirement || (!!p.subject && !!i.subject && sameSubject(p.subject, i.subject))))
    return before ? { ...i, questionId: before.questionId } : i
  })
  if (ctx.job.isSandbox) return { ...gap, items: carried }
  const items = carried.map((i) => {
    if (i.decision !== 'ask' || i.questionId || !i.ask || !i.subject) return i
    const q = askQuestion({
      question: i.ask.question,
      context: `${ctx.job.title} at ${ctx.job.company} asks for: ${asSentence(i.requirement)} The knowledge base does not say whether you have this. ${i.ask.codeShowable ? GAP_CONTEXT_CODE : GAP_CONTEXT_EXPERIENCE}`,
      kind: i.ask.kind,
      subject: i.subject,
      answerType: 'yes_no',
      knowledgeKey: `skill:${i.subject}`,
      applicationId: ctx.applicationId,
      jobId: ctx.job.id,
      blocking: false,
    })
    return { ...i, questionId: q.id, rationale: `The knowledge base does not say whether you have ${i.subject}. Asked: "${q.question}"` }
  })
  return { ...gap, items }
}
