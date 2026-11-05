import { z } from 'zod'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { appSettings, jobs, questions } from '../db/schema'
import type { Requirement } from '#shared/types/pipeline'
import { aiStructured, cachedPrompt, stepModel } from './ai'
import { ruleTerm } from './learned-score'
import { nowSql, parseJson } from './review'
import {
  appSkipNote,
  canonicalQuestion,
  codeFlagOf,
  dedupeKeyOf,
  exactQuestionFor,
  inferenceUndoneQuestionIds,
  inferredFromId,
  isInterestText,
  mergedIntoId,
  mergeQuestionInto,
  namesTool,
  parseYesNo,
  repointMergedQuestions,
  sameCoreSkill,
  skillCore,
  skillSubjectParts,
  subjectTarget,
  withoutAppNote,
  withoutInferredNote,
  type QuestionRow,
} from './questions'

// ── The skill catalog: one question per skill a posting checks ──
// Devin (2026-11-05): "when looking at questions on the application I first think which skill are
// they trying to check I have, then from there we write a generic question around that skill and
// match all questions that fall into the skill." Postings word one skill many ways ("AI-first",
// "AI-collaborative", "Proficiency using AI-powered development tools"); word matching made each
// wording its own question. Each catalog entry is a skill with a short generic name, one generic
// question, a one-line scope, the posting phrasings that mapped to it, and the question asked for it.
//
// Stored in app_settings, one row per entry (key skill_catalog:<slug>): the unit forbids schema
// changes, and one row per entry means adding a skill never rewrites or races another write.
//
// A new knows or has_done requirement goes through the cheap exact checks first (the same dedupe
// key, the same skill once qualifiers are dropped, a phrasing already mapped). Otherwise one distill
// call reads its full wording and posting sentence and names the catalog skill it checks, or
// proposes a new skill; a second review call checks every proposal against the catalog (really new,
// a rewording, too narrow, too broad). Code keeps the never-merge rules (meaningGuard). A failed or
// budget-stopped call stores nothing, and askQuestion() falls back to the word match. The distill
// runs only once the catalog holds entries (applyApprovedCatalogOnce), so a deploy before Devin
// approves the catalog changes nothing.

export const DISTILL_PURPOSE = 'skill_distill'
export const REVIEW_PURPOSE = 'skill_review'
/** Models the two steps use unless NUXT_AI_STEP_MODELS maps their purpose. */
export const DISTILL_DEFAULT_MODEL = 'claude-haiku-5-5'
export const REVIEW_DEFAULT_MODEL = 'claude-haiku-5-5'

const ENTRY_PREFIX = 'skill_catalog:'
/** app_settings key: normalized phrasing to catalog slug, so a phrasing seen once costs no call again. */
const PHRASINGS_KEY = 'skill_catalog_phrasings'
/** app_settings key: set once the approved catalog has been applied. */
const APPLIED_KEY = 'skill_catalog_applied'

/** Requirements per distill call. */
const CHUNK = 20
/** Posting phrasings listed in a question's "Asked as" note. */
const ASKED_AS_MAX = 8

export type SkillKind = 'knows' | 'has_done'

export interface SkillEntry {
  slug: string
  /** Short generic name: "Using AI for supervised coding", "Docker". */
  name: string
  kind: SkillKind
  /** One generic yes or no question about the skill, never about one posting. */
  question: string
  /** One line: what the skill covers and what it does not. */
  scope: string
  /** Posting phrasings that mapped to it ("AI-first", "AI-collaborative"). */
  phrasings: string[]
  /** The question asked for this skill, once one is. */
  questionId: number | null
  /** A core skill; Devin may reserve longer answers for these. Editable later; nothing reads it yet. */
  core: boolean
  source: 'seed' | 'distill' | 'bootstrap' | 'approved'
  createdAt: string
}

/** Devin's split of the AI questions (2026-11-05); the catalog starts from these. */
export const SEED_SKILLS: Array<Pick<SkillEntry, 'name' | 'kind' | 'question' | 'scope'>> = [
  {
    name: 'Using AI for supervised coding',
    kind: 'has_done',
    question: 'Have you used AI coding tools in your day-to-day development, reviewing what they produce?',
    scope: 'Covers driving AI coding assistants and coding agents (Copilot, Cursor, Claude Code, Codex) to write, change, and review code while he checks the output. Does not cover AI that runs inside a product or process without a person in the loop.',
  },
  {
    name: 'Using AI in unsupervised processes',
    kind: 'has_done',
    question: 'Have you built agents or LLM steps that run without a person in the loop, in a product or in operations?',
    scope: 'Covers LLM calls and agents that run on their own inside a product or an operational process, and the agent frameworks and platforms they run on. Does not cover using AI tools to write his own code.',
  },
]

// ── Storage ──

export function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9+#]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'skill'
}

/** The subject a phrasing is stored under: the skill without qualifiers, lowercased, punctuation dropped. */
export function phrasingKey(subject: string): string {
  return skillCore(subject).toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim()
}

/** Every entry, in the order they were added (the order the prompt lists them, so its start is cached). */
export function loadCatalog(): SkillEntry[] {
  return useDb().select().from(appSettings).where(like(appSettings.key, `${ENTRY_PREFIX}%`)).all()
    .map(r => parseJson<SkillEntry | null>(r.valueJson, null))
    .filter((e): e is SkillEntry => !!e?.slug)
    .map(e => ({ ...e, core: e.core ?? false }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug))
}

export function catalogEntry(slug: string): SkillEntry | null {
  const row = useDb().select().from(appSettings).where(eq(appSettings.key, `${ENTRY_PREFIX}${slug}`)).get()
  const e = parseJson<SkillEntry | null>(row?.valueJson, null)
  return e ? { ...e, core: e.core ?? false } : null
}

export function saveEntry(e: SkillEntry) {
  const valueJson = JSON.stringify(e)
  useDb().insert(appSettings).values({ key: `${ENTRY_PREFIX}${e.slug}`, valueJson, updatedAt: nowSql() })
    .onConflictDoUpdate({ target: appSettings.key, set: { valueJson, updatedAt: nowSql() } }).run()
}

/** A new entry, or the existing one with the same name. */
function addEntry(fields: Pick<SkillEntry, 'name' | 'kind' | 'question' | 'scope'>, source: SkillEntry['source'], at = nowSql()): SkillEntry {
  const same = loadCatalog().find(e => normName(e.name) === normName(fields.name))
  if (same) return same
  let slug = slugOf(fields.name)
  for (let n = 2; catalogEntry(slug); n++) slug = `${slugOf(fields.name)}-${n}`
  const entry: SkillEntry = { slug, ...fields, phrasings: [], questionId: null, core: false, source, createdAt: at }
  saveEntry(entry)
  return entry
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim()
}

/** Adds Devin's two AI skills to an empty catalog. Tests and evals use it; production gets them with the approved catalog. */
export function ensureSeedSkills(): SkillEntry[] {
  return SEED_SKILLS.map((s, i) => addEntry(s, 'seed', `2026-11-05 00:00:0${i}`))
}

export function phrasingDecisions(): Record<string, { slug: string; at: string }> {
  const row = useDb().select().from(appSettings).where(eq(appSettings.key, PHRASINGS_KEY)).get()
  return parseJson<Record<string, { slug: string; at: string }>>(row?.valueJson, {})
}

/** One statement per phrasing (json_set), so two processes saving at once never drop each other's. */
function savePhrasings(entries: Array<[string, string]>) {
  const list = entries.filter(([key]) => key && !key.includes('"'))
  if (!list.length) return
  const at = nowSql()
  useDb().transaction((tx) => {
    for (const [key, slug] of list) {
      const value = JSON.stringify({ slug, at })
      tx.run(sql`insert into app_settings (key, value_json, updated_at) values (${PHRASINGS_KEY}, json_object(${key}, json(${value})), ${at})
        on conflict(key) do update set value_json = json_set(app_settings.value_json, ${`$."${key}"`}, json(${value})), updated_at = ${at}`)
    }
  })
}

/** The question a skill is asked as: its canonical question, or the row itself when the app skipped it. */
export function skillQuestion(e: SkillEntry): QuestionRow | null {
  if (e.questionId == null) return null
  const canon = canonicalQuestion(e.questionId)
  if (canon) return canon
  const row = useDb().select().from(questions).where(eq(questions.id, e.questionId)).get()
  return row && row.status === 'skipped' && appSkipNote(row) && mergedIntoId(row) == null ? row : null
}

/** The catalog skill a subject was mapped to, or decided false when none was (the word match decides then). */
export function skillMatch(subject: string): { decided: false } | { decided: true; entry: SkillEntry } {
  const d = phrasingDecisions()[phrasingKey(subject)]
  const entry = d ? catalogEntry(d.slug) : null
  return entry ? { decided: true, entry } : { decided: false }
}

const ASKED_AS = / Asked as: [^\n]*$/

/** A context with the skill's phrasings at its end ("Asked as: AI-first, AI-collaborative."), after any notes. */
export function withAskedAs(context: string | null | undefined, phrasings: string[]): string | null {
  const base = (context ?? '').replace(ASKED_AS, '').trim()
  const list = [...new Set(phrasings.map(p => p.trim()).filter(Boolean))].slice(0, ASKED_AS_MAX)
  if (!list.length) return base || null
  const note = `Asked as: ${list.join(', ')}.`
  return base ? `${base} ${note}` : note
}

/** Records a posting phrasing on its skill and on the skill's question. */
export function notePhrasing(e: SkillEntry, phrasing: string, row?: QuestionRow | null) {
  const p = phrasing.trim()
  if (!p) return
  const fresh = catalogEntry(e.slug) ?? e
  if (!fresh.phrasings.some(x => normName(x) === normName(p))) {
    fresh.phrasings = [...fresh.phrasings, p]
    saveEntry(fresh)
  }
  if (row && normName(p) !== normName(row.subject ?? '')) {
    const context = withAskedAs(row.context, fresh.phrasings.filter(x => normName(x) !== normName(row.subject ?? '')))
    if (context !== row.context) useDb().update(questions).set({ context }).where(eq(questions.id, row.id)).run()
  }
}

/** Ties a skill to the question asked for it. */
export function linkSkillQuestion(e: SkillEntry, questionId: number) {
  const fresh = catalogEntry(e.slug) ?? e
  if (fresh.questionId === questionId) return
  saveEntry({ ...fresh, questionId })
}

// ── What never merges, whatever a reply says ──

interface GuardSide {
  subject: string | null
  question?: string | null
  context?: string | null
}

function sideText(s: GuardSide): string {
  return `${s.subject ?? ''} ${s.question ?? ''} ${withoutInferredNote(withoutAppNote(s.context ?? null)) ?? ''}`
}

/** One named tool, one word: "React", "Docker", "C#", "Next.js". "AI-first" (a hyphenated qualifier) is not. */
function singleTool(subject: string): boolean {
  return skillSubjectParts(subject).length === 1 && namesTool(subject) && /^[^\s-]+$/.test(skillCore(subject))
}

/** The tools a subject that names several lists ("FastAPI or Flask", "Fastify and Zod"), or null. */
function toolList(subject: string): string[] | null {
  const parts = skillSubjectParts(subject)
  if (parts.length < 2) return null
  return parts.every(p => namesTool(p) && skillCore(p).split(/\s+/).length <= 2) ? parts.map(p => ruleTerm(skillCore(p))) : null
}

/**
 * Why a requirement can never be a skill (or two questions one skill), or null: interest ("Interest
 * in fintech") against having done it; two different single tools (React and Vue, Docker and
 * Kubernetes); a question naming several tools against one tool or a different set of tools. A fact
 * or form question never reaches the catalog: only knows and has_done questions are distilled.
 */
export function meaningGuard(a: GuardSide, b: GuardSide): string | null {
  const sa = (a.subject ?? '').trim()
  const sb = (b.subject ?? '').trim()
  if (!sa || !sb) return 'a question without a subject'
  if (isInterestText(sideText(a)) !== isInterestText(sideText(b))) return 'one asks about interest, the other about experience'
  if (singleTool(sa) && singleTool(sb) && !sameCoreSkill(sa, sb)) return 'two different tools'
  const la = toolList(sa)
  const lb = toolList(sb)
  if (la && lb && !(la.length === lb.length && la.every(t => lb.includes(t)))) return 'two questions that name different sets of tools'
  // Against a general skill ("Using AI for supervised coding") the model decides: "Claude Code or Cursor" is one.
  if ((la && !lb && namesTool(sb)) || (lb && !la && namesTool(sa))) return 'a question that names several tools against one tool'
  return null
}

/** The guard between a requirement and a catalog skill, by the skill's name and question. */
function guardSkill(a: GuardSide, e: Pick<SkillEntry, 'name' | 'question'>): string | null {
  return meaningGuard(a, { subject: e.name, question: e.question })
}

// ── Posting sentences ──

/** The posting's words a question was asked for, read from its context ("... asks for: React.js. ..."). */
export function postingPhrase(context: string | null | undefined): string | null {
  const c = (withoutInferredNote(withoutAppNote(context ?? null)) ?? '').replace(ASKED_AS, '')
  const m = c.match(/\basks? for:? (.+?)(?:\.\s+(?:The knowledge base|Your answer|A No means)\b|\.?$)/)
  const phrase = m?.[1]?.replace(/\s+/g, ' ').trim()
  return phrase ? phrase.slice(0, 160) : null
}

const SENTENCE_STOP = new Set(['in', 'of', 'to', 'the', 'a', 'an', 'for', 'with', 'and', 'or', 'on', 'at', 'by', 'using', 'use', 'into'])

function sentenceWords(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9+#.]+/).filter(w => w.length > 1 && !SENTENCE_STOP.has(w))
}

/**
 * The posting sentence each question came from: the requirement on its job that holds every word of
 * the fragment its context quotes ("Proficiency using AI-powered" is "Proficiency using AI-powered
 * development tools"). A daily question's context keeps only the cut fragment, so without this the
 * model judges "AI-powered" alone. Falls back to the quoted phrase.
 */
export function postingSentences(rows: QuestionRow[]): Map<number, string> {
  const out = new Map<number, string>()
  const jobIds = [...new Set(rows.map(q => q.jobId).filter((id): id is number => id != null))]
  const reqs = new Map<number, string[]>()
  for (let i = 0; i < jobIds.length; i += 500) {
    for (const j of useDb().select({ id: jobs.id, r: jobs.requirementsJson }).from(jobs).where(inArray(jobs.id, jobIds.slice(i, i + 500))).all()) {
      reqs.set(j.id, parseJson<Requirement[]>(j.r, []).map(x => x.text).filter(Boolean))
    }
  }
  for (const q of rows) {
    const phrase = postingPhrase(q.context)
    const want = sentenceWords(phrase ?? q.subject ?? '')
    const hit = want.length && q.jobId != null
      ? (reqs.get(q.jobId) ?? []).filter((t) => {
          const have = new Set(sentenceWords(t))
          return want.every(w => have.has(w))
        }).sort((a, b) => a.length - b.length)[0]
      : undefined
    const sentence = (hit ?? phrase)?.replace(/\s+/g, ' ').trim()
    if (sentence) out.set(q.id, sentence.slice(0, 240))
  }
  return out
}

/**
 * Questions the catalog is built from: knows and has_done questions that are open, answered, or
 * skipped by the app (not merged duplicates, and not ones Devin skipped himself), by id.
 */
export function catalogCandidates(): QuestionRow[] {
  return useDb().select().from(questions)
    .where(and(inArray(questions.kind, ['knows', 'has_done']), inArray(questions.status, ['pending', 'answered', 'skipped'])))
    .orderBy(questions.id)
    .all()
    .filter(q => !!q.subject?.trim() && (q.status !== 'skipped' || (!!appSkipNote(q) && mergedIntoId(q) == null)))
}

// ── Prompts ──

const RULES = `How to find the skill behind a requirement:
- Name the general skill the employer wants to know he has, the way a recruiter would, not the posting's words. Many wordings check one skill: "AI-first", "AI-collaborative", "AI-native", "AI coding", "AI-powered coding", "AI-augmented engineering", "Proficiency using AI-powered development tools", "Experience leveraging AI in software development", "AI tools like Claude, ChatGPT, or Copilot", "modern agentic coding tools like Codex or Claude Code", "Bringing AI into day-to-day development", and "Productively leverage AI tools" all check "Using AI for supervised coding": he drives AI coding tools and agents and reviews what they produce.
- "Using AI in unsupervised processes" is a different skill: agents or LLM steps that run without a person in the loop, inside a product or an operational process. Using AI to write his own code is never that skill, and running AI inside a product is never supervised coding.
- One tool written different ways is one skill: "Python3", "Expert-level Python", and "Python"; "Docker" and "Docker containerization"; "IaC" and "Infrastructure-as-code". Two general wordings of one kind of work are one skill: "Startup experience" and "Fast-paced startups"; "ML frameworks" and "modern ML libraries"; "Emerging AI frameworks" and "Modern AI frameworks".
- A requirement that names one specific tool, protocol, or pattern checks that one, not the broad skill around it: "Terraform" is not infrastructure as code in general, "PyTorch" is not machine learning in general, "Temporal" is not workflow orchestration in general, "Anthropic Claude" is not AI coding in general, and "used AI to drive a large code migration" or "run several agent workflows at once" are narrower than the AI skills. A Yes to the broad skill would not answer them.
- Two tools that are related or alternatives are two skills: React and Vue, Docker and Kubernetes, PostgreSQL and MySQL, LangChain and LangGraph.
- Lists of different width are different skills. A requirement that lists alternatives ("X, Y, or Z") is met by any one of them, and one that names two things together ("X and Y") needs both, so two of them are one skill only when they name the same things. "Accessible UI and product instincts" is not "Accessibility"; "FastAPI or Flask" is not "Python FastAPI". "AI tools like Claude, ChatGPT, or Copilot" is the exception: its list only gives examples of one skill.
- Interest in something ("Interest in fintech") is never the skill of having done it.
- Read every requirement by its full posting sentence. Some subjects are fragments cut from a posting ("AI-powered", "leveraging AI", "AI in day-to-day"): judge a fragment by what its sentence means, never by the fragment alone. Two questions can share asked wording because it was copied from one to the other; judge each by its own posting sentence.
- A one-word or vague subject whose posting sentence does not say which skill it means ("LLM", "Leveraging LLM systems") gets its own skill rather than a guess.
- When unsure between an existing skill and a new one, propose the new one: the review decides, and a wrong match records a claim Devin never made.`

const DISTILL_SYSTEM = `You keep Devin, a job seeker, from being asked the same thing twice. Job postings check for skills in many wordings. For each REQUIREMENT, decide which skill it is checking that Devin has.

Answer an existing SKILL ("S<n>") when one Yes, Some experience, or No about that skill would answer the requirement too, whichever he picks. Otherwise answer "new" and propose the skill: a short generic name; one generic yes or no question about the skill that does not mention any one posting; its scope in one line (what it covers, and what it does not); and its kind ("knows" for a tool, language, framework, or platform; "has_done" for a kind of work, domain, or practice). Leave the name, question, scope, and kind empty when you answer an existing skill.

${RULES}`

const REVIEW_SYSTEM = `You review new skills proposed for Devin's skill catalog before they are added. Devin is a job seeker; each skill gets one generic yes or no question, and his answer is saved as one claim in his knowledge base. Each PROPOSED skill lists the requirements (and question ids) it would cover.

For each proposal decide:
- "new" when it is a real skill the catalog lacks, at the breadth its requirements check. You may improve its name, question, and scope.
- "S<n>" when it rewords an existing skill: one Yes, Some experience, or No about that skill would answer every one of its requirements.
- "P<k>" when it rewords an earlier proposal in this list.
A proposal that is too narrow maps to the broader skill only when the broader skill's answer would answer its requirements too; otherwise it stays new. A proposal that is too broad gets a narrower name, question, and scope that match what its requirements check.
Also check every requirement listed under an existing skill or a proposal: when one sits under the wrong skill, move it ("moves") to the skill it checks. Give every decision and move a one-line reason naming the rule.

${RULES}`

const DistillSchema = z.object({
  skills: z.array(z.object({
    item: z.string().describe('The requirement\'s id, e.g. "R1"'),
    skill: z.string().describe('"S<n>" of the existing skill it checks, or "new"'),
    name: z.string().describe('For "new": the skill\'s short generic name; else empty'),
    question: z.string().describe('For "new": one generic yes or no question about the skill; else empty'),
    scope: z.string().describe('For "new": one line, what it covers and what it does not; else empty'),
    kind: z.string().describe('For "new": "knows" or "has_done"; else empty'),
    reason: z.string().describe('A few words: why this skill'),
  })),
})

const ReviewSchema = z.object({
  proposals: z.array(z.object({
    proposal: z.string().describe('The proposal\'s id, e.g. "P1"'),
    decision: z.string().describe('"new", "S<n>" of the existing skill it rewords, or "P<k>" of an earlier proposal it rewords'),
    name: z.string().describe('For "new": the final short generic name'),
    question: z.string().describe('For "new": the final generic yes or no question'),
    scope: z.string().describe('For "new": the final one-line scope'),
    reason: z.string().describe('One line: the rule behind the decision'),
  })),
  moves: z.array(z.object({
    id: z.string().describe('"Q<id>" or "R<n>" of a requirement under the wrong skill'),
    to: z.string().describe('"S<n>" or "P<k>" of the skill it checks'),
    reason: z.string().describe('One line: why'),
  })),
})

function skillLine(e: Pick<SkillEntry, 'name' | 'scope' | 'kind'>, n: number): string {
  return `S${n}: ${e.name} (${e.kind}) | ${e.scope}`
}

interface RequirementLine {
  /** "Q<id>" for an existing question, "R<n>" for a new requirement. */
  ref: string
  subject: string
  question: string
  posting: string | null
}

function requirementText(r: RequirementLine): string {
  return `${r.ref}: ${r.subject} | asked: "${r.question}"${r.posting && phrasingKey(r.posting) !== phrasingKey(r.subject) ? ` | posting: "${r.posting}"` : ''}`
}

const parseRef = (s: string, letter: string): number | null => {
  const m = s.trim().toUpperCase().match(new RegExp(`^${letter}(\\d+)$`))
  return m ? Number(m[1]) : null
}

const asKind = (k: string, fallback: SkillKind): SkillKind => (k === 'knows' || k === 'has_done' ? k : fallback)

// ── The two calls ──

interface DistillItem extends RequirementLine {
  kind: SkillKind
  guardSide: GuardSide
}

export interface Proposal {
  name: string
  kind: SkillKind
  question: string
  scope: string
  /** Indexes into the items the proposal covers. */
  items: number[]
}

interface DistillOutcome {
  /** Per item: the index of the existing skill, or of a proposal. */
  mapped: Array<{ skill: number } | { proposal: number }>
  reasons: string[]
  proposals: Proposal[]
}

/** One distill call: each item to an existing skill (index into `catalog`) or a proposal. */
async function distillCall(items: DistillItem[], catalog: Array<Pick<SkillEntry, 'name' | 'kind' | 'question' | 'scope'>>, opts: { ref?: { type: string; id: number }; model?: string } = {}): Promise<DistillOutcome> {
  const reply = await aiStructured(DistillSchema, {
    purpose: DISTILL_PURPOSE,
    model: opts.model ?? stepModel(DISTILL_PURPOSE) ?? DISTILL_DEFAULT_MODEL,
    effort: 'low',
    maxTokens: 6000,
    ref: opts.ref,
    system: DISTILL_SYSTEM,
    // The catalog first (a cached prefix, in the order skills were added), then the requirements.
    prompt: cachedPrompt([`SKILLS\n${catalog.map((e, n) => skillLine(e, n + 1)).join('\n') || '(none yet)'}`], `\n\nREQUIREMENTS\n${items.map(requirementText).join('\n')}`),
  })
  const out: DistillOutcome = { mapped: [], reasons: [], proposals: [] }
  items.forEach((it, i) => {
    const d = reply.skills.find(x => x.item.trim().toUpperCase() === it.ref.toUpperCase())
    const s = d ? parseRef(d.skill, 'S') : null
    const existing = s != null ? catalog[s - 1] : undefined
    out.reasons.push(d?.reason?.trim() ?? '')
    if (existing && !guardSkill(it.guardSide, existing)) {
      out.mapped.push({ skill: s! - 1 })
      return
    }
    if (existing) out.reasons[i] = `kept apart from "${existing.name}": ${guardSkill(it.guardSide, existing)}`
    // A new skill, or one the guard kept apart: proposals with the same name are one proposal.
    const name = d?.name?.trim() || it.subject
    const at = out.proposals.findIndex(p => normName(p.name) === normName(name))
    if (at >= 0) {
      out.proposals[at]!.items.push(i)
      out.mapped.push({ proposal: at })
      return
    }
    out.proposals.push({ name, kind: asKind(d?.kind?.trim() ?? '', it.kind), question: d?.question?.trim() || it.question, scope: d?.scope?.trim() || '', items: [i] })
    out.mapped.push({ proposal: out.proposals.length - 1 })
  })
  return out
}

export interface ReviewOutcome {
  /** Per proposal: stays new (with its final fields), or the existing skill or earlier proposal it rewords. */
  decisions: Array<{ to: { skill: number } | { proposal: number } | null; name: string; question: string; scope: string; reason: string }>
  /** Requirements moved to another skill: item ref to the skill or proposal it checks. */
  moves: Array<{ ref: string; to: { skill: number } | { proposal: number }; reason: string }>
}

/**
 * One review call: every proposal against the catalog. `members` lists the requirements under each
 * existing skill (the bootstrap), so the review can move one that sits under the wrong skill.
 */
async function reviewCall(
  catalog: Array<Pick<SkillEntry, 'name' | 'kind' | 'question' | 'scope'>>,
  proposals: Array<Pick<Proposal, 'name' | 'kind' | 'question' | 'scope'> & { lines: RequirementLine[] }>,
  opts: { members?: RequirementLine[][]; model?: string; ref?: { type: string; id: number } } = {},
): Promise<ReviewOutcome> {
  const skills = catalog.map((e, n) => {
    const members = opts.members?.[n] ?? []
    return `${skillLine(e, n + 1)}${members.length ? `\n${members.map(m => `  ${requirementText(m)}`).join('\n')}` : ''}`
  }).join('\n')
  const reply = await aiStructured(ReviewSchema, {
    purpose: REVIEW_PURPOSE,
    model: opts.model ?? stepModel(REVIEW_PURPOSE) ?? REVIEW_DEFAULT_MODEL,
    effort: 'medium',
    maxTokens: 16000,
    ref: opts.ref,
    system: REVIEW_SYSTEM,
    prompt: cachedPrompt([`SKILLS\n${skills || '(none yet)'}`], `\n\nPROPOSED SKILLS\n${proposals.map((p, k) => `P${k + 1}: ${p.name} (${p.kind}) | question: "${p.question}" | scope: ${p.scope}\n${p.lines.map(l => `  ${requirementText(l)}`).join('\n')}`).join('\n')}`),
  })
  const target = (s: string, before?: number): { skill: number } | { proposal: number } | null => {
    const sn = parseRef(s, 'S')
    if (sn != null && catalog[sn - 1]) return { skill: sn - 1 }
    const pn = parseRef(s, 'P')
    if (pn != null && proposals[pn - 1] && (before == null || pn - 1 < before)) return { proposal: pn - 1 }
    return null
  }
  const decisions = proposals.map((p, k) => {
    const d = reply.proposals.find(x => x.proposal.trim().toUpperCase() === `P${k + 1}`)
    const to = d && d.decision.trim().toLowerCase() !== 'new' ? target(d.decision, k) : null
    return { to, name: d?.name?.trim() || p.name, question: d?.question?.trim() || p.question, scope: d?.scope?.trim() || p.scope, reason: d?.reason?.trim() ?? '' }
  })
  const moves = reply.moves.flatMap((m) => {
    const to = target(m.to)
    return to ? [{ ref: m.id.trim().toUpperCase(), to, reason: m.reason.trim() }] : []
  })
  return { decisions, moves }
}

// ── At ask time ──

export interface SkillAsk {
  subject: string
  kind: string
  question: string
  /** The posting sentence, e.g. "Proficiency using AI-powered development tools". */
  phrase?: string | null
  context?: string | null
  /** The tidy's own question: only an older question, or an answered one, can absorb it. */
  selfId?: number
}

export interface DistillResult {
  called: boolean
  /** The error of a failed call; nothing is stored then, so askQuestion() uses the word match. */
  error: string | null
  decided: Array<{ subject: string; slug: string; created: boolean; reason: string }>
}

/** An older question, or an answered one, about the same skill: the tidy merges it without a call. */
function exactForTidy(a: SkillAsk, rows: QuestionRow[]): boolean {
  return rows.some(c => c.id !== a.selfId && (c.status === 'pending' || c.status === 'answered')
    && (c.id < a.selfId! || c.status === 'answered') && sameCoreSkill(a.subject, c.subject!))
}

/**
 * Maps every skill or experience requirement in `asks` that no exact check or stored phrasing
 * settles to a catalog skill, adding the skills the review accepts as new, and stores each mapping
 * for askQuestion() to read. Runs only once the catalog holds entries.
 */
export async function distillSkills(asks: SkillAsk[], ref?: { type: string; id: number }): Promise<DistillResult> {
  const result: DistillResult = { called: false, error: null, decided: [] }
  const catalog = loadCatalog()
  if (!catalog.length) return result
  const stored = phrasingDecisions()
  let rows: QuestionRow[] | null = null
  const seen = new Set<string>()
  const open: SkillAsk[] = []
  for (const a of asks) {
    if (a.kind !== 'knows' && a.kind !== 'has_done') continue
    const key = phrasingKey(a.subject ?? '')
    if (!key || seen.has(key) || stored[key]) continue
    seen.add(key)
    if (a.selfId == null ? exactQuestionFor(a.kind, a.subject) : exactForTidy(a, rows ??= catalogCandidates())) continue
    open.push(a)
  }
  if (!open.length) return result
  const selfRows = useDb().select().from(questions).where(inArray(questions.id, open.map(a => a.selfId).filter((id): id is number => id != null).concat(-1))).all()
  const sentences = postingSentences(selfRows)
  for (let start = 0; start < open.length; start += CHUNK) {
    const chunk = open.slice(start, start + CHUNK)
    const items: DistillItem[] = chunk.map((a, i) => ({
      ref: `R${i + 1}`,
      subject: a.subject,
      question: a.question,
      posting: (a.selfId != null ? sentences.get(a.selfId) : null) ?? a.phrase ?? null,
      kind: a.kind as SkillKind,
      guardSide: { subject: a.subject, question: a.question, context: a.context ?? null },
    }))
    const current = loadCatalog()
    let saved: Array<[string, string]> = []
    try {
      result.called = true
      const d = await distillCall(items, current, { ref })
      const finalOf: Array<SkillEntry | null> = items.map(() => null)
      d.mapped.forEach((m, i) => { if ('skill' in m) finalOf[i] = current[m.skill]! })
      if (d.proposals.length) {
        const r = await reviewCall(current, d.proposals.map(p => ({ ...p, lines: p.items.map(i => items[i]!) })), { ref })
        const made: Array<SkillEntry | null> = []
        d.proposals.forEach((p, k) => {
          const dec = r.decisions[k]!
          let entry: SkillEntry | null = null
          if (dec.to && 'skill' in dec.to) entry = current[dec.to.skill]!
          else if (dec.to && 'proposal' in dec.to) entry = made[dec.to.proposal] ?? null
          // A rewording the guard rejects for any of its requirements stays a skill of its own.
          if (entry && p.items.some(i => guardSkill(items[i]!.guardSide, entry!))) entry = null
          entry ??= addEntry({ name: dec.name, kind: p.kind, question: dec.question, scope: dec.scope }, 'distill')
          made.push(entry)
          for (const i of p.items) {
            finalOf[i] = entry
            d.reasons[i] = dec.reason || d.reasons[i]!
          }
        })
      }
      saved = items.map((it, i) => [phrasingKey(it.subject), finalOf[i]!.slug] as [string, string])
      items.forEach((it, i) => {
        notePhrasing(finalOf[i]!, it.subject)
        result.decided.push({ subject: it.subject, slug: finalOf[i]!.slug, created: !current.some(e => e.slug === finalOf[i]!.slug), reason: d.reasons[i] ?? '' })
      })
    }
    catch (e: any) {
      result.error = `${e?.constructor?.name ?? 'Error'}: ${e?.message ?? e}`
      console.warn(`[questions] skill distill failed, so these subjects use the word match: ${chunk.map(a => a.subject).join(' | ')}. ${result.error}`)
      return result
    }
    savePhrasings(saved)
  }
  return result
}

/**
 * For askQuestion(): the input a skill or experience question is asked with once its skill is
 * known. Reuses the skill's question when it has one (recording the phrasing), else returns the
 * skill's generic question to insert: subject is the skill name, the posting wording goes to the
 * context as "Asked as: ...", and the knowledge key follows the skill.
 */
export function skillAskFor<T extends { subject: string; kind: string; question: string; context?: string | null }>(input: T): { reuse: QuestionRow; entry: SkillEntry } | { input: T; entry: SkillEntry } | null {
  const m = skillMatch(input.subject)
  if (!m.decided) return null
  const entry = m.entry
  const existing = skillQuestion(entry) ?? exactQuestionFor(entry.kind, entry.name)
  if (existing) {
    if (entry.questionId !== existing.id) linkSkillQuestion(entry, existing.id)
    notePhrasing(entry, input.subject, existing)
    return { reuse: existing, entry }
  }
  const phrasings = normName(input.subject) === normName(entry.name) ? [] : [input.subject]
  return { input: { ...input, subject: entry.name, kind: entry.kind, question: entry.question, context: withAskedAs(input.context, phrasings) } as T, entry }
}

// ── Bootstrap: a catalog from the questions asked before it ──

export interface CatalogPlanMember {
  id: number
  subject: string
  status: string
  answer: string | null
  posting: string | null
  action: 'canonical' | 'merge' | 'keep'
  reason: string | null
}

export interface CatalogPlanEntry {
  slug: string
  name: string
  kind: SkillKind
  question: string
  scope: string
  core: boolean
  source: 'seed' | 'bootstrap'
  canonicalId: number | null
  /** The canonical question is reworded to the skill's name and generic question (open ones only). */
  reword: boolean
  /** Devin's answer the skill keeps: the canonical question's, when it is answered. */
  answerFrom: { id: number; answer: string } | null
  /** Two of his answers in this skill differ: nothing in it is merged. */
  conflict: string | null
  members: CatalogPlanMember[]
}

export interface CatalogPlan {
  name: string
  approved: boolean
  candidates: number
  models: { distill: string; review: string }
  entries: CatalogPlanEntry[]
  /** The review's decisions and moves, each with its reason. */
  review: Array<{ what: string; reason: string }>
  error: string | null
}

/**
 * Builds a proposed catalog from every open, answered, and app-skipped knows and has_done question:
 * seeded with Devin's two AI skills, the questions are distilled in id order, 25 to a call, each
 * call seeing the catalog so far; then one review call reads every proposed skill with its
 * questions and can map it onto another, rename it, or move a question. Code then decides each
 * skill's canonical question (his own answer, else an answered one, else the oldest open) and what
 * merges. Writes nothing.
 */
export async function bootstrapCatalog(opts: { distillModel?: string; reviewModel?: string; batch?: number; log?: (m: string) => void } = {}): Promise<CatalogPlan> {
  const log = opts.log ?? (() => {})
  const rows = catalogCandidates()
  const distillModel = opts.distillModel ?? stepModel(DISTILL_PURPOSE) ?? DISTILL_DEFAULT_MODEL
  const reviewModel = opts.reviewModel ?? stepModel(REVIEW_PURPOSE) ?? REVIEW_DEFAULT_MODEL
  const plan: CatalogPlan = { name: `Proposed ${nowSql().slice(0, 10)} from ${rows.length} questions`, approved: false, candidates: rows.length, models: { distill: distillModel, review: reviewModel }, entries: [], review: [], error: null }
  const sentences = postingSentences(rows)
  const lineOf = (q: QuestionRow): RequirementLine => ({ ref: `Q${q.id}`, subject: q.subject!, question: q.question, posting: sentences.get(q.id) ?? null })
  type Draft = Pick<SkillEntry, 'name' | 'kind' | 'question' | 'scope'> & { source: 'seed' | 'bootstrap'; ids: number[] }
  const drafts: Draft[] = SEED_SKILLS.map(s => ({ ...s, source: 'seed', ids: [] }))
  const byId = new Map(rows.map(r => [r.id, r]))
  const batch = opts.batch ?? 25
  try {
    for (let start = 0; start < rows.length; start += batch) {
      const slice = rows.slice(start, start + batch)
      const items: DistillItem[] = slice.map(q => ({ ...lineOf(q), kind: q.kind as SkillKind, guardSide: q }))
      const d = await distillCall(items, drafts, { model: distillModel })
      const fresh = d.proposals.map((p) => {
        const same = drafts.find(x => normName(x.name) === normName(p.name))
        if (same) return same
        const draft: Draft = { name: p.name, kind: p.kind, question: p.question, scope: p.scope, source: 'bootstrap', ids: [] }
        drafts.push(draft)
        return draft
      })
      d.mapped.forEach((m, i) => ('skill' in m ? drafts[m.skill]! : fresh[m.proposal]!).ids.push(slice[i]!.id))
      log(`distilled questions ${slice[0]!.id} to ${slice.at(-1)!.id}: ${d.proposals.length} new skills, catalog ${drafts.length}`)
    }
    // The review: the seeds are the catalog, every other skill a proposal with its questions.
    const seeds = drafts.filter(x => x.source === 'seed')
    const proposed = drafts.filter(x => x.source === 'bootstrap')
    const r = await reviewCall(seeds, proposed.map(p => ({ ...p, lines: p.ids.map(id => lineOf(byId.get(id)!)) })), { members: seeds.map(s => s.ids.map(id => lineOf(byId.get(id)!))), model: reviewModel })
    const final: Draft[] = [...seeds]
    const into: Draft[] = []
    proposed.forEach((p, k) => {
      const dec = r.decisions[k]!
      let target: Draft | null = null
      if (dec.to && 'skill' in dec.to) target = seeds[dec.to.skill]!
      else if (dec.to && 'proposal' in dec.to) target = into[dec.to.proposal] ?? null
      if (target) {
        const blocked = p.ids.filter(id => !!guardSkill(byId.get(id)!, target!))
        const moving = p.ids.filter(id => !blocked.includes(id))
        target.ids.push(...moving)
        plan.review.push({ what: `"${p.name}" (${p.ids.map(id => `#${id}`).join(', ')}) into "${target.name}"${blocked.length ? `, except ${blocked.map(id => `#${id}`).join(', ')} (kept apart by code)` : ''}`, reason: dec.reason })
        if (blocked.length) {
          const kept: Draft = { ...p, ids: blocked }
          final.push(kept)
          into.push(kept)
        }
        else {
          into.push(target)
        }
        return
      }
      const renamed = dec.name !== p.name || dec.question !== p.question || dec.scope !== p.scope
      const kept: Draft = { ...p, name: dec.name, question: dec.question, scope: dec.scope }
      if (renamed) plan.review.push({ what: `"${p.name}" kept as "${dec.name}"`, reason: dec.reason })
      final.push(kept)
      into.push(kept)
    })
    for (const m of r.moves) {
      const id = parseRef(m.ref, 'Q')
      const to = 'skill' in m.to ? seeds[m.to.skill] : into[m.to.proposal]
      if (id == null || !byId.has(id) || !to) continue
      const guard = guardSkill(byId.get(id)!, to)
      if (guard) {
        plan.review.push({ what: `move #${id} to "${to.name}" refused by code: ${guard}`, reason: m.reason })
        continue
      }
      for (const d of final) d.ids = d.ids.filter(x => x !== id)
      to.ids.push(id)
      plan.review.push({ what: `moved #${id} ${byId.get(id)!.subject} to "${to.name}"`, reason: m.reason })
    }
    // Merged names: the same skill twice after the review becomes one.
    const unique: Draft[] = []
    for (const d of final) {
      const same = unique.find(u => normName(u.name) === normName(d.name))
      if (same) same.ids.push(...d.ids)
      else unique.push(d)
    }
    plan.entries = unique.filter(d => d.ids.length || d.source === 'seed').map(d => planEntry(d, byId, sentences))
  }
  catch (e: any) {
    plan.error = `${e?.constructor?.name ?? 'Error'}: ${e?.message ?? e}`
  }
  return plan
}

/** Decides a skill's canonical question and what merges, in code. */
function planEntry(d: Pick<SkillEntry, 'name' | 'kind' | 'question' | 'scope'> & { source: 'seed' | 'bootstrap'; ids: number[] }, byId: Map<number, QuestionRow>, sentences: Map<number, string>): CatalogPlanEntry {
  const undone = inferenceUndoneQuestionIds()
  const members = [...new Set(d.ids)].map(id => byId.get(id)!).sort((a, b) => a.id - b.id)
  const answered = members.filter(m => m.status === 'answered')
  const own = answered.filter(m => inferredFromId(m) == null)
  const levels = new Set(answered.map(m => parseYesNo(m.answer ?? '') ?? m.answer))
  const conflict = levels.size > 1 ? `you answered ${answered.map(m => `#${m.id} "${m.answer}"`).join(' and ')}` : null
  const canonical = conflict ? null : (own[0] ?? answered[0] ?? members.find(m => m.status === 'pending') ?? null)
  return {
    slug: slugOf(d.name),
    name: d.name,
    kind: d.kind,
    question: d.question,
    scope: d.scope,
    core: false,
    source: d.source,
    canonicalId: canonical?.id ?? null,
    reword: !!canonical && canonical.status === 'pending' && (normName(canonical.subject ?? '') !== normName(d.name) || canonical.question !== d.question),
    answerFrom: canonical?.status === 'answered' && canonical.answer ? { id: canonical.id, answer: canonical.answer } : null,
    conflict,
    members: members.map((m): CatalogPlanMember => {
      const base = { id: m.id, subject: m.subject!, status: m.status, answer: m.answer, posting: sentences.get(m.id) ?? null }
      if (conflict) return { ...base, action: 'keep', reason: 'answered differently in this skill; nothing merged' }
      if (!canonical) return { ...base, action: 'keep', reason: 'no open or answered question in the skill' }
      if (m.id === canonical.id) return { ...base, action: 'canonical', reason: null }
      if (m.status === 'answered') return { ...base, action: 'keep', reason: 'answered; stays as it is' }
      if (m.blocking) return { ...base, action: 'keep', reason: 'an application waits on it' }
      if (undone.has(m.id)) return { ...base, action: 'keep', reason: 'you undid an answer the app carried to it' }
      const guard = meaningGuard(m, canonical)
      if (guard) return { ...base, action: 'keep', reason: `kept apart: ${guard}` }
      return { ...base, action: 'merge', reason: null }
    }),
  }
}

// ── Applying an approved catalog ──

export interface CatalogApplied {
  entries: number
  merged: Array<{ id: number; into: number }>
  reworded: number[]
  skipped: Array<{ id: number; skill: string; reason: string }>
  repointed: number[]
}

/**
 * Applies a catalog plan by id: saves each skill (with its canonical question), rewords an open
 * canonical question to the skill's name and generic question (the knowledge key follows the
 * skill), merges the other open and app-skipped members into it with "Merged into question #N",
 * records every member's phrasing, and points waiting applications at the canonical questions.
 * Skips, and lists, any id that is gone, answered, skipped, or whose subject changed since the plan.
 */
export function applyCatalogPlan(plan: CatalogPlan): CatalogApplied {
  const db = useDb()
  const get = (id: number) => db.select().from(questions).where(eq(questions.id, id)).get() ?? null
  const out: CatalogApplied = { entries: 0, merged: [], reworded: [], skipped: [], repointed: [] }
  const mergeMap = new Map<number, number>()
  const phrasings: Array<[string, string]> = []
  plan.entries.forEach((p, n) => {
    const entry: SkillEntry = catalogEntry(p.slug) ?? { slug: p.slug, name: p.name, kind: p.kind, question: p.question, scope: p.scope, phrasings: [], questionId: null, core: p.core, source: 'approved', createdAt: `${nowSql().slice(0, 10)} ${String(n).padStart(6, '0')}` }
    Object.assign(entry, { name: p.name, kind: p.kind, question: p.question, scope: p.scope, core: p.core })
    let canon: QuestionRow | null = null
    if (p.canonicalId != null) {
      const row = get(p.canonicalId)
      const planned = p.members.find(m => m.id === p.canonicalId)
      const why = !row ? 'gone' : row.status !== planned?.status ? `now ${row.status}` : row.subject !== planned.subject ? `subject changed to "${row.subject}"` : null
      if (why) {
        out.skipped.push({ id: p.canonicalId, skill: p.name, reason: `canonical question ${why}; nothing in this skill merged` })
      }
      else {
        canon = row
        if (p.reword && row!.status === 'pending') {
          const target = subjectTarget(p.name, p.kind, codeFlagOf(row!.context))
          const others = p.members.filter(m => m.id !== row!.id).map(m => m.subject)
          db.update(questions).set({
            subject: p.name,
            question: p.question,
            kind: p.kind,
            dedupeKey: dedupeKeyOf(p.kind, p.name),
            knowledgeKey: `${target.category}:${target.key}`,
            context: withAskedAs(row!.context, [row!.subject!, ...others]),
          }).where(eq(questions.id, row!.id)).run()
          out.reworded.push(row!.id)
          canon = get(row!.id)
        }
      }
    }
    entry.questionId = canon?.id ?? entry.questionId
    entry.phrasings = [...new Set([...entry.phrasings, ...p.members.map(m => m.subject)])]
    saveEntry(entry)
    out.entries++
    for (const m of p.members) {
      phrasings.push([phrasingKey(m.subject), entry.slug])
      if (m.action !== 'merge' || !canon) continue
      const row = get(m.id)
      const why = !row ? 'gone' : mergedIntoId(row) != null ? `already merged into #${mergedIntoId(row)}` : row.status !== m.status ? `now ${row.status}` : row.subject !== m.subject ? `subject changed to "${row.subject}"` : null
      if (why) {
        out.skipped.push({ id: m.id, skill: p.name, reason: why })
        continue
      }
      mergeQuestionInto(row!, canon)
      mergeMap.set(row!.id, canon.id)
      out.merged.push({ id: row!.id, into: canon.id })
    }
    phrasings.push([phrasingKey(p.name), entry.slug])
  })
  savePhrasings(phrasings)
  out.repointed = repointMergedQuestions(mergeMap)
  return out
}

/**
 * Runs once (an app_settings marker), in learn:daily: applies the catalog Devin approved
 * (APPROVED_SKILL_CATALOG in skill-catalog-approved.ts). Does nothing while that file holds a plan
 * not yet approved, so the branch can ship before his review; the ask-time distill also waits,
 * because it runs only once the catalog holds entries.
 */
export function applyApprovedCatalogOnce(plan: CatalogPlan | null, log: (m: string) => void = () => {}): { ran: boolean; reason: string | null; applied: CatalogApplied | null } {
  const db = useDb()
  if (db.select().from(appSettings).where(eq(appSettings.key, APPLIED_KEY)).get()) return { ran: false, reason: 'already applied', applied: null }
  if (!plan || !plan.approved) return { ran: false, reason: 'no approved catalog yet', applied: null }
  const applied = applyCatalogPlan(plan)
  const valueJson = JSON.stringify({ plan: plan.name, entries: applied.entries, merged: applied.merged, reworded: applied.reworded, skipped: applied.skipped })
  db.insert(appSettings).values({ key: APPLIED_KEY, valueJson, updatedAt: nowSql() })
    .onConflictDoUpdate({ target: appSettings.key, set: { valueJson, updatedAt: nowSql() } }).run()
  log(`skill catalog: ${applied.entries} skills; merged ${applied.merged.map(m => `#${m.id} into #${m.into}`).join(', ') || 'none'}; reworded ${applied.reworded.map(id => `#${id}`).join(', ') || 'none'}${applied.skipped.length ? `; skipped ${applied.skipped.map(s => `#${s.id} (${s.reason})`).join(', ')}` : ''}`)
  return { ran: true, reason: null, applied }
}
