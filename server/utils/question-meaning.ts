import { z } from 'zod'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { appSettings, questions } from '../db/schema'
import { aiStructured, cachedPrompt, fallbackModel, primaryModel, stepModel } from './ai'
import { ruleTerm } from './learned-score'
import { nowSql, parseJson } from './review'
import {
  appSkipNote,
  canonicalQuestion,
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
  withoutAppNote,
  withoutInferredNote,
  type QuestionRow,
} from './questions'

// ── One question per claim, decided by meaning ──
// "AI-assisted", "AI-first", "AI coding", and "modern agentic coding tools" share few words, yet one
// answer answers them all: using AI to build software. Word matching (skillCore, sameSubject) made
// each wording its own question. Before a skill or experience question is created, the cheap exact
// checks run (the same dedupe key, the same skill once qualifiers are dropped); when they find
// nothing, one Claude call (purpose question_same_subject, the fallback model unless
// NUXT_AI_STEP_MODELS maps the purpose) reads the new subject, its wording, and the posting's words
// against every existing knows and has_done question, and names the one whose answer would fully
// answer it as the same knowledge base claim, or none. The decision is stored per normalized
// subject in app_settings, so a repeat asks nothing. A failed or budget-stopped call stores nothing,
// and askQuestion() falls back to the word match. Code enforces what must never merge, whatever the
// reply says: a fact and a skill (only knows and has_done questions are listed), two different
// single tools (React and Vue), a question naming several tools and another one, and interest
// against experience.

export const SAME_SUBJECT_PURPOSE = 'question_same_subject'
/** The one-time repair's grouping call. */
export const SUBJECT_GROUPS_PURPOSE = 'question_subject_groups'

/** app_settings key: the meaning check's decisions, one per normalized subject. */
const DECISIONS_KEY = 'question_subject_meaning'
/** app_settings key: set once the existing questions have been grouped by meaning and merged. */
const REPAIR_KEY = 'question_meaning_repair'

/** New items per call; each can point at an earlier item of the same call. */
const CHUNK = 20

export interface MeaningAsk {
  subject: string
  kind: string
  question: string
  /** What the posting wrote, e.g. "Proficiency using AI-powered tools". */
  phrase?: string | null
  context?: string | null
  /**
   * The tidy's own question: only an older question, or an answered one, can absorb it, so the
   * oldest open question of a claim stays the one to answer.
   */
  selfId?: number
}

interface MeaningDecision {
  /** "Q<id>" (an existing question), "S:<key>" (the question asked for another new subject in the same call), or "none". */
  match: string
  reason?: string
  at: string
}

/** The subject a decision is stored under: the skill without qualifiers, lowercased, punctuation dropped. */
export function meaningKey(subject: string): string {
  return skillCore(subject).toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim()
}

export function meaningDecisions(): Record<string, MeaningDecision> {
  const row = useDb().select().from(appSettings).where(eq(appSettings.key, DECISIONS_KEY)).get()
  return parseJson<Record<string, MeaningDecision>>(row?.valueJson, {})
}

/** One statement per decision (json_set), so two processes saving at once never drop each other's. */
function saveDecisions(entries: Array<[string, Omit<MeaningDecision, 'at'>]>) {
  const list = entries.filter(([key]) => key && !key.includes('"'))
  if (!list.length) return
  const db = useDb()
  const at = nowSql()
  db.transaction((tx) => {
    for (const [key, d] of list) {
      const value = JSON.stringify({ ...d, at })
      tx.run(sql`insert into app_settings (key, value_json, updated_at) values (${DECISIONS_KEY}, json_object(${key}, json(${value})), ${at})
        on conflict(key) do update set value_json = json_set(app_settings.value_json, ${`$."${key}"`}, json(${value})), updated_at = ${at}`)
    }
  })
}

/**
 * Questions a new one can be the same claim as: knows and has_done questions that are open,
 * answered, or skipped by the app (not merged duplicates, which point at their question already,
 * and not ones Devin skipped himself). Ordered by id, so the prompt lists them the same way every
 * time and its start is cached.
 */
export function meaningCandidates(): QuestionRow[] {
  return useDb().select().from(questions)
    .where(and(inArray(questions.kind, ['knows', 'has_done']), inArray(questions.status, ['pending', 'answered', 'skipped'])))
    .orderBy(questions.id)
    .all()
    .filter(q => !!q.subject?.trim() && (q.status !== 'skipped' || (!!appSkipNote(q) && mergedIntoId(q) == null)))
}

/** The posting's words a question was asked for, read from its context ("... asks for: React.js. ..."). */
export function postingPhrase(context: string | null | undefined): string | null {
  const c = withoutInferredNote(withoutAppNote(context ?? null)) ?? ''
  const m = c.match(/\basks? for:? (.+?)(?:\.\s+(?:The knowledge base|Your answer|A No means)\b|\.?$)/)
  const phrase = m?.[1]?.replace(/\s+/g, ' ').trim()
  return phrase ? phrase.slice(0, 160) : null
}

/**
 * The question a stored decision points at: the canonical question of "Q<id>" (following merge
 * notes), or that row itself when the app skipped it; for "S:<key>", the question asked for that
 * subject. Null when the question is gone or Devin skipped it.
 */
function resolveDecision(match: string): QuestionRow | null {
  const q = match.match(/^Q(\d+)$/)
  if (q) {
    const id = Number(q[1])
    const canon = canonicalQuestion(id)
    if (canon) return canon
    const row = useDb().select().from(questions).where(eq(questions.id, id)).get()
    return row && row.status === 'skipped' && appSkipNote(row) && mergedIntoId(row) == null ? row : null
  }
  const s = match.match(/^S:(.+)$/)
  if (s) {
    const rank: Record<string, number> = { answered: 0, pending: 1, skipped: 2 }
    return meaningCandidates()
      .filter(r => meaningKey(r.subject!) === s[1])
      .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.id - b.id)[0] ?? null
  }
  return null
}

/**
 * The stored decision for a subject. decided false: no decision (the check failed or never ran,
 * or the question it named is gone), so the caller uses the word match. decided true with a row:
 * that question asks the same claim. decided true with null: Claude found none.
 */
export function meaningMatch(subject: string): { decided: false } | { decided: true; row: QuestionRow | null } {
  const d = meaningDecisions()[meaningKey(subject)]
  if (!d) return { decided: false }
  if (d.match === 'none') return { decided: true, row: null }
  const row = resolveDecision(d.match)
  return row ? { decided: true, row } : { decided: false }
}

// ── What never merges, whatever the reply says ──

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
 * Why two skill or experience questions can never be one claim, or null. Interest ("Interest in
 * fintech") against having done it; two different single tools (React and Vue, Docker and
 * Kubernetes); a question naming several tools against anything but the same set.
 */
export function meaningGuard(a: GuardSide, b: GuardSide): string | null {
  const sa = (a.subject ?? '').trim()
  const sb = (b.subject ?? '').trim()
  if (!sa || !sb) return 'a question without a subject'
  if (isInterestText(sideText(a)) !== isInterestText(sideText(b))) return 'one asks about interest, the other about experience'
  if (singleTool(sa) && singleTool(sb) && !sameCoreSkill(sa, sb)) return 'two different tools'
  const la = toolList(sa)
  const lb = toolList(sb)
  if ((la || lb) && !(la && lb && la.length === lb.length && la.every(t => lb.includes(t)))) return 'a question that names several tools is answered only by itself'
  return null
}

// ── The check ──

const RULES = `Most AI questions ask one of three claims. Every general question about the same one is that claim, whatever its words:
1. Using AI to build software (AI coding assistants and agents as his own tools): "AI-assisted", "AI-first", "AI-native", "AI-collaborative", "AI coding", "AI-powered coding", "AI-augmented engineering", "Proficiency using AI-powered tools", "AI tools like Claude, ChatGPT, or Copilot", "modern agentic coding tools like Codex or Claude Code", "AI coding tools daily", "AI in day-to-day work", "productively leverage AI". For an engineering job, using AI at work means using it to build software.
2. Building AI features into a product: LLM integration, calling AI APIs, generative AI features, AI in product features, LLMs in production workflows.
3. Building agents and agent tooling: agentic workflows, agent platforms, MCP servers, agent frameworks.
These three are different claims, never one. A question that mixes two of them ("AI tools and agentic workflows") is neither.

One tool written different ways is one claim too: "Python3", "Expert-level Python", and "Python"; "Docker" and "Docker containerization"; "IaC" and "Infrastructure-as-code".

These are different claims:
- A narrower question when the narrow part is the point: "used AI to drive a large code migration", "run several agent workflows at once", "Anthropic Claude" itself, "LangGraph" itself, "RAG" itself. A Yes to the broad question does not answer it.
- Two tools that are related or alternatives: React and Vue, Docker and Kubernetes, PostgreSQL and MySQL, LangChain and LangGraph.
- One tool and the kind of tool it is: "Temporal" and workflow orchestration engines, "Terraform" and infrastructure as code, "PyTorch" and machine learning.
- A question that names several things, joined by "and" or "or" ("FastAPI or Flask", "Payments and reconciliation", "Accessible UI and product instincts", "Financial systems or payments"), and a question about one of them or about another set. "AI tools like Claude, ChatGPT, or Copilot" is the exception: its list only gives examples of one claim.
- Interest in something ("Interest in fintech") and having done it.

Read each subject with its question and the posting's words: "AI-powered" from "Proficiency using AI-powered tools" is about using AI to build software, while "AI-powered products" is about building AI features. When you are unsure whether two questions are one claim, keep them apart: a second question costs Devin one tap, while a wrong match records a claim he never made.`

const SAME_SYSTEM = `You keep Devin, a job seeker, from being asked the same skill or experience question twice. Every question is a yes or no about him ("Have you used X in a real project?", "Have you done X?"), and his answer is saved as one claim in his knowledge base.

For each NEW ITEM, find the EXISTING QUESTION whose answer would fully answer the item as the same claim: one Yes, Some experience, or No would be true of both, whichever of the three he picks. Answer its id ("Q<id>"). When no existing question fits but an earlier new item asks the same claim, answer that item's id ("N<k>"). Otherwise answer "none". When several existing questions fit, answer the lowest id. An item marked with its own id may only match a lower id or a question marked answered, never itself.

${RULES}`

const SameSchema = z.object({
  decisions: z.array(z.object({
    item: z.string().describe('The new item\'s id, e.g. "N1"'),
    match: z.string().describe('"Q<id>" of the existing question that asks the same claim, "N<k>" of an earlier new item that does, or "none"'),
    reason: z.string().describe('A few words: the claim they share, or why none fits'),
  })),
})

function candidateLine(q: QuestionRow): string {
  const phrase = postingPhrase(q.context)
  const marker = q.status === 'answered' ? ' [answered]' : q.status === 'skipped' ? ' [skipped by the app]' : ''
  return `Q${q.id}${marker}: ${q.subject} | asked: "${q.question}"${phrase && meaningKey(phrase) !== meaningKey(q.subject!) ? ` | posting: "${phrase}"` : ''}`
}

function itemLine(a: MeaningAsk, n: number): string {
  const phrase = a.phrase?.trim()
  return `N${n}: ${a.subject} | asked: "${a.question}"${phrase && meaningKey(phrase) !== meaningKey(a.subject) ? ` | posting: "${phrase}"` : ''}${a.selfId ? ` [this is Q${a.selfId}: match only a lower id, or one marked answered]` : ''}`
}

/** An older question, or an answered one, about the same skill: the tidy merges it without asking Claude. */
function exactForTidy(a: MeaningAsk, candidates: QuestionRow[]): boolean {
  return candidates.some(c => c.id !== a.selfId && (c.status === 'pending' || c.status === 'answered')
    && (c.id < a.selfId! || c.status === 'answered') && sameCoreSkill(a.subject, c.subject!))
}

export interface MeaningCheck {
  /** True when a Claude call was made. */
  called: boolean
  /** The call's error; nothing is stored then, so askQuestion() uses the word match. */
  error: string | null
  decided: Array<{ subject: string; match: string; reason: string }>
}

/**
 * Decides, for every skill or experience subject in `asks` that has no stored decision and no exact
 * match, whether an existing question asks the same claim, and stores each decision for
 * askQuestion() to read. Items are sent 20 to a call; an item can point at an earlier item of the
 * same call ("AI-first" and "AI-native" both new today). Every reply is checked in code: the id
 * must be a listed question (never a fact or form question), and meaningGuard() must pass.
 */
export async function checkSameMeaning(asks: MeaningAsk[], ref?: { type: string; id: number }): Promise<MeaningCheck> {
  const result: MeaningCheck = { called: false, error: null, decided: [] }
  const stored = meaningDecisions()
  let candidates: QuestionRow[] | null = null
  const seen = new Set<string>()
  const open: MeaningAsk[] = []
  for (const a of asks) {
    if (a.kind !== 'knows' && a.kind !== 'has_done') continue
    const key = meaningKey(a.subject ?? '')
    if (!key || seen.has(key) || stored[key]) continue
    seen.add(key)
    if (a.selfId == null ? exactQuestionFor(a.kind, a.subject) : exactForTidy(a, candidates ??= meaningCandidates())) continue
    open.push(a)
  }
  if (!open.length) return result
  candidates ??= meaningCandidates()
  const byId = new Map(candidates.map(c => [c.id, c]))
  // Nothing to compare with: the first question of its kind.
  if (open.length === 1 && candidates.every(c => c.id === open[0]!.selfId)) {
    saveDecisions([[meaningKey(open[0]!.subject), { match: 'none', reason: 'no other questions yet' }]])
    result.decided.push({ subject: open[0]!.subject, match: 'none', reason: 'no other questions yet' })
    return result
  }
  const listing = candidates.map(candidateLine).join('\n')
  for (let start = 0; start < open.length; start += CHUNK) {
    const chunk = open.slice(start, start + CHUNK)
    let reply: z.infer<typeof SameSchema>
    try {
      result.called = true
      reply = await aiStructured(SameSchema, {
        purpose: SAME_SUBJECT_PURPOSE,
        model: stepModel(SAME_SUBJECT_PURPOSE) ?? fallbackModel(),
        effort: 'low',
        maxTokens: 3000,
        ref,
        system: SAME_SYSTEM,
        // The existing questions first (a cached prefix, ordered by id), then the new items.
        prompt: cachedPrompt([`EXISTING QUESTIONS\n${listing}`], `\n\nNEW ITEMS\n${chunk.map((a, i) => itemLine(a, i + 1)).join('\n')}`),
      })
    }
    catch (e: any) {
      result.error = `${e?.constructor?.name ?? 'Error'}: ${e?.message ?? e}`
      console.warn(`[questions] meaning check failed, so these subjects use the word match: ${chunk.map(a => a.subject).join(' | ')}. ${result.error}`)
      return result
    }
    const decisions: Array<[string, Omit<MeaningDecision, 'at'>]> = []
    chunk.forEach((a, i) => {
      const d = reply.decisions.find(x => x.item.trim().toUpperCase() === `N${i + 1}`)
      const raw = (d?.match ?? 'none').trim().toUpperCase()
      let match = 'none'
      let reason = d?.reason?.trim() || ''
      const q = raw.match(/^Q(\d+)$/)
      const n = raw.match(/^N(\d+)$/)
      if (q) {
        const row = byId.get(Number(q[1]))
        const usable = row && row.id !== a.selfId && (a.selfId == null || row.id < a.selfId || row.status === 'answered')
        const guard = row ? meaningGuard(a, row) : null
        if (usable && !guard) match = `Q${row!.id}`
        else reason = guard ? `kept apart: ${guard}` : `${raw} is not a question it can match`
      }
      else if (n && Number(n[1]) <= i) {
        const other = chunk[Number(n[1]) - 1]!
        const guard = meaningGuard(a, other)
        if (!guard && meaningKey(other.subject) !== meaningKey(a.subject)) match = `S:${meaningKey(other.subject)}`
        else if (guard) reason = `kept apart: ${guard}`
      }
      decisions.push([meaningKey(a.subject), { match, reason }])
      result.decided.push({ subject: a.subject, match, reason })
    })
    saveDecisions(decisions)
  }
  return result
}

// ── One-time repair: the questions asked before the check, grouped by meaning ──

const GROUP_SYSTEM = `You keep Devin, a job seeker, from being asked the same skill or experience question twice. Every question below is a yes or no about him ("Have you used X in a real project?", "Have you done X?"), and his answer is saved as one claim in his knowledge base. Some of them ask the same claim in different words.

Group the questions that ask the same claim: one Yes, Some experience, or No would be true of every question in the group, whichever of the three he picks. Read every question; most have no partner, and that is expected. A group has two or more ids, and a question belongs to one group at most. Leave a question out when no other question asks its claim. Name each group's claim in a few plain words.

${RULES}`

const VERIFY_SYSTEM = `You check proposed groups of questions for Devin, a job seeker. Every question is a yes or no about him, and his answer is saved as one claim in his knowledge base. A group is right only when one Yes, Some experience, or No would be true of every question in it, whichever of the three he picks. Apply the rules below strictly. For each group, list every question that does not ask exactly the group's claim, with the rule it breaks. List nothing for a group that is right. Never add a question to a group.

${RULES}`

const VerifySchema = z.object({
  removals: z.array(z.object({
    id: z.string().describe('"Q<id>" of a question to take out of its group'),
    reason: z.string().describe('The rule it breaks, in a few words'),
  })),
})

const GroupSchema = z.object({
  groups: z.array(z.object({
    claim: z.string().describe('The claim every question in the group asks, in a few plain words'),
    ids: z.array(z.string()).describe('"Q<id>" of every question in the group, two or more'),
  })),
})

export interface MeaningMember {
  id: number
  subject: string
  question: string
  status: string
  answer: string | null
  /** canonical: the one to answer; merge: merged into it; keep: left as it is (see reason). */
  action: 'canonical' | 'merge' | 'keep'
  reason: string | null
}

export interface MeaningGroup {
  claim: string
  canonicalId: number | null
  /** Set when Devin answered two questions of the group differently: nothing in it is merged. */
  conflict: string | null
  members: MeaningMember[]
}

export interface MeaningRepairPlan {
  groups: MeaningGroup[]
  /** Questions in no group: no other question asks their claim. */
  standalone: number[]
  /** Questions the second reading took out of a proposed group, and why. */
  removed: Array<{ id: number; reason: string }>
  candidates: number
  model: string
  error: string | null
}

/**
 * Groups the existing open, answered, and app-skipped knows and has_done questions by meaning in
 * one Claude call, has a second call take out members that break the rules, then decides each
 * group in code: the canonical question is the one Devin
 * answered himself (the oldest), else an answered one, else the oldest open one. Every other open or
 * app-skipped member is merged into it, except one an application blocks on, one whose carried
 * answer he undid, and one meaningGuard() keeps apart. An answered question is never merged. A
 * group in which he answered two questions differently is listed and left alone. Writes nothing.
 */
export async function planMeaningRepair(): Promise<MeaningRepairPlan> {
  const rows = meaningCandidates()
  const model = stepModel(SUBJECT_GROUPS_PURPOSE) ?? primaryModel()
  const plan: MeaningRepairPlan = { groups: [], standalone: [], removed: [], candidates: rows.length, model, error: null }
  if (rows.length < 2) {
    plan.standalone = rows.map(r => r.id)
    return plan
  }
  let reply: z.infer<typeof GroupSchema>
  try {
    reply = await aiStructured(GroupSchema, {
      purpose: SUBJECT_GROUPS_PURPOSE,
      // One call, once: worth the stronger reading.
      effort: 'high',
      maxTokens: 16000,
      system: GROUP_SYSTEM,
      prompt: `QUESTIONS\n${rows.map(candidateLine).join('\n')}`,
    })
  }
  catch (e: any) {
    plan.error = `${e?.constructor?.name ?? 'Error'}: ${e?.message ?? e}`
    return plan
  }
  const byId = new Map(rows.map(r => [r.id, r]))
  const undone = inferenceUndoneQuestionIds()
  const used = new Set<number>()
  const proposed: Array<{ claim: string; ids: number[] }> = []
  for (const g of reply.groups) {
    const ids = [...new Set(g.ids.map(s => Number(s.trim().replace(/^Q/i, ''))))].filter(id => byId.has(id) && !used.has(id))
    if (ids.length < 2) continue
    ids.forEach(id => used.add(id))
    proposed.push({ claim: g.claim.trim(), ids })
  }
  // A second reading of the groups alone, against the rules: a member that asks something narrower
  // or broader ("Temporal" in a group about orchestration engines) is taken out. Read the same way
  // as the grouping, so a failure stops the repair rather than merging unchecked groups.
  const removed = new Map<number, string>()
  if (proposed.length) {
    try {
      const check = await aiStructured(VerifySchema, {
        purpose: SUBJECT_GROUPS_PURPOSE,
        effort: 'high',
        maxTokens: 8000,
        system: VERIFY_SYSTEM,
        prompt: proposed.map((g, n) => `GROUP ${n + 1}: ${g.claim}\n${g.ids.map(id => candidateLine(byId.get(id)!)).join('\n')}`).join('\n\n'),
      })
      for (const r of check.removals) {
        const id = Number(r.id.trim().replace(/^Q/i, ''))
        if (byId.has(id)) removed.set(id, r.reason.trim())
      }
    }
    catch (e: any) {
      plan.error = `${e?.constructor?.name ?? 'Error'}: ${e?.message ?? e}`
      return plan
    }
  }
  plan.removed = [...removed].map(([id, reason]) => ({ id, reason }))
  used.clear()
  for (const g of proposed) {
    const ids = g.ids.filter(id => !removed.has(id))
    if (ids.length < 2) continue
    ids.forEach(id => used.add(id))
    const members = ids.map(id => byId.get(id)!).sort((a, b) => a.id - b.id)
    const answered = members.filter(m => m.status === 'answered')
    const own = answered.filter(m => inferredFromId(m) == null)
    const levels = new Set(answered.map(m => parseYesNo(m.answer ?? '') ?? m.answer))
    const canonical = own[0] ?? answered[0] ?? members.find(m => m.status === 'pending') ?? null
    const conflict = levels.size > 1
      ? `you answered ${answered.map(m => `#${m.id} "${m.answer}"`).join(' and ')}`
      : null
    plan.groups.push({
      claim: g.claim,
      canonicalId: conflict ? null : canonical?.id ?? null,
      conflict,
      members: members.map((m): MeaningMember => {
        const base = { id: m.id, subject: m.subject!, question: m.question, status: m.status, answer: m.answer }
        if (conflict) return { ...base, action: 'keep', reason: 'answered differently in this group; nothing merged' }
        if (!canonical) return { ...base, action: 'keep', reason: 'no open or answered question in the group' }
        if (m.id === canonical.id) return { ...base, action: 'canonical', reason: null }
        if (m.status === 'answered') return { ...base, action: 'keep', reason: 'answered; stays as it is' }
        if (m.blocking) return { ...base, action: 'keep', reason: 'an application waits on it' }
        if (undone.has(m.id)) return { ...base, action: 'keep', reason: 'you undid an answer the app carried to it' }
        const guard = meaningGuard(m, canonical)
        if (guard) return { ...base, action: 'keep', reason: `kept apart: ${guard}` }
        return { ...base, action: 'merge', reason: null }
      }),
    })
  }
  plan.standalone = rows.filter(r => !used.has(r.id)).map(r => r.id)
  return plan
}

export interface MeaningRepairApplied {
  merged: Array<{ id: number; into: number }>
  repointed: number[]
}

/**
 * Applies a plan: merges each group's members into its canonical question with the note
 * "Merged into question #N", points waiting applications at it, and stores every subject's
 * decision, so the tidy and new asks agree with the groups without another call.
 */
export function applyMeaningRepair(plan: MeaningRepairPlan): MeaningRepairApplied {
  const db = useDb()
  const mergeMap = new Map<number, number>()
  const decisions: Array<[string, Omit<MeaningDecision, 'at'>]> = []
  for (const g of plan.groups) {
    const into = g.canonicalId != null ? canonicalQuestion(g.canonicalId) : null
    for (const m of g.members) {
      if (m.action !== 'merge' || !into) {
        decisions.push([meaningKey(m.subject), { match: 'none', reason: g.conflict ?? m.reason ?? `the one to answer for ${g.claim}` }])
        continue
      }
      // The row as it is now: still open, or still skipped by the app, and not merged since.
      const row = db.select().from(questions).where(eq(questions.id, m.id)).get()
      const mergeable = row && (row.status === 'pending' || (row.status === 'skipped' && !!appSkipNote(row) && mergedIntoId(row) == null))
      if (!mergeable || row!.id === into.id) continue
      mergeQuestionInto(row!, into)
      mergeMap.set(row!.id, into.id)
      decisions.push([meaningKey(m.subject), { match: `Q${into.id}`, reason: g.claim }])
    }
  }
  for (const id of plan.standalone) {
    const row = db.select({ subject: questions.subject }).from(questions).where(eq(questions.id, id)).get()
    if (row?.subject) decisions.push([meaningKey(row.subject), { match: 'none', reason: 'no other question asks this claim' }])
  }
  // A merge decision wins over a "none" another member with the same key got.
  const merged = new Set(decisions.filter(([, d]) => d.match !== 'none').map(([k]) => k))
  saveDecisions(decisions.filter(([k, d]) => d.match !== 'none' || !merged.has(k)))
  const repointed = repointMergedQuestions(mergeMap)
  return { merged: [...mergeMap].map(([id, into]) => ({ id, into })), repointed }
}

export interface MeaningRepairResult {
  ran: boolean
  error: string | null
  merged: Array<{ id: number; into: number }>
  conflicts: Array<{ claim: string; conflict: string }>
}

/**
 * Runs once (an app_settings marker), in learn:daily after the skip repair: groups the questions
 * asked before the meaning check and merges each group into its canonical question. A failed or
 * budget-stopped call sets no marker, so the next learn:daily tries again. Additive: no row is
 * deleted, no answer changes, and every merged question can be reopened.
 */
export async function mergeSameMeaningOnce(log: (m: string) => void = () => {}): Promise<MeaningRepairResult> {
  const db = useDb()
  const result: MeaningRepairResult = { ran: false, error: null, merged: [], conflicts: [] }
  if (db.select().from(appSettings).where(eq(appSettings.key, REPAIR_KEY)).get()) return result
  const plan = await planMeaningRepair()
  if (plan.error) {
    result.error = plan.error
    log(`question meaning repair: waiting for the next run, the grouping call failed: ${plan.error}`)
    return result
  }
  result.ran = true
  const applied = applyMeaningRepair(plan)
  result.merged = applied.merged
  result.conflicts = plan.groups.filter(g => g.conflict).map(g => ({ claim: g.claim, conflict: g.conflict! }))
  const valueJson = JSON.stringify({ groups: plan.groups.length, merged: applied.merged, conflicts: result.conflicts, model: plan.model })
  db.insert(appSettings).values({ key: REPAIR_KEY, valueJson, updatedAt: nowSql() })
    .onConflictDoUpdate({ target: appSettings.key, set: { valueJson, updatedAt: nowSql() } }).run()
  log(`question meaning repair: ${plan.groups.length} groups from ${plan.candidates} questions; merged ${applied.merged.map(m => `#${m.id} into #${m.into}`).join(', ') || 'none'}${result.conflicts.length ? `; left alone (answered differently): ${result.conflicts.map(c => `${c.claim} (${c.conflict})`).join('; ')}` : ''}`)
  return result
}
