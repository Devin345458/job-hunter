import { z } from 'zod'
import { and, eq, inArray, like, ne } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { applications, jobs, questions } from '../../db/schema'
import type { FormAnswer, FormField, FormSnapshot, TailoredResume } from '#shared/types/pipeline'
import { aiStructured, cachedPrompt } from '../ai'
import { cleanStoredAnswer, factForQuestion, factStatements, isHistoryDate, matchFact, resolveFacts, resolveField, type FactValues } from '../facts'
import { loadKnowledge, type KnowledgeEntry } from '../knowledge'
import { ADDRESS_CONTEXT, answeredValue, askOrReuse, askQuestion, appSkipNote, canonicalQuestion, labelTiedTo, skipForApp, type AskInput, type AskOutcome, type QuestionRow } from '../questions'
import { nowSql, parseJson, setApplicationStatus } from '../review'
import { ATS_LABELS } from './ats'
import { joinKeptParagraphs, knowledgeForPrompt, knowledgeText, verifyClaims } from './evidence'
import { bestOption } from './fill'
import { fitAnswersToFields } from './fit'
import { recordNameList, withoutRecordNames } from '../repos/describe'
import { dropRepeatsInValue, normalizeLabel, scrubDashes, splitSentences, truncate, unsupportedNumbers } from './text'
import { cleanFieldLabel } from '#shared/utils/plain-text'

type JobRow = InferSelectModel<typeof jobs>

// Turns a form snapshot into answers, without a browser. Order of resolution per field:
// 1. deterministic rules (files, EEO decline options, cover letter, current employer and title,
//    marketing opt-outs);
// 2. the personal-fact registry (server/utils/facts.ts): name, initials, address and every part
//    of it, contact details, work authorization, sponsorship, relocation, start date, salary.
//    Values come from the knowledge base or are derived from it (initials from the full name, city
//    and state from the home address). An unknown fact asks its one fixed question: the whole
//    address is one question, however many address fields a form has;
// 3. one Claude call for everything else, whose free-text answers go through the evidence check.
// A field nobody can answer becomes a question: blocking when the field is required (and always
// for the five sensitive facts), and skipped without a question when it is optional. Before any
// question is created, askOrReuse() looks for one that already asks the same thing.

export interface AnswerContext {
  applicationId: number
  job: JobRow
  entries: KnowledgeEntry[]
  resume: TailoredResume | null
  coverLetter: string | null
}

// ── Personal facts ───────────────────────────────────────────
// The registry in server/utils/facts.ts decides which labels ask for a personal fact (name,
// address, contact, work authorization, sponsorship, relocation, start date, salary) and derives
// each value from what the knowledge base stores. resolveField() turns a fact into a field answer.

/** Value for a field from a resolved fact, or null when the options need mapToOptions. */
function valueFromFact(field: FormField, res: { value: string; choices: string[] }): FormAnswer['value'] | null {
  const options = field.options ?? []
  switch (field.type) {
    case 'number':
      return res.value.replace(/,/g, '').match(/\d+(\.\d+)?/)?.[0] ?? null
    case 'checkbox':
      return /^yes$/i.test(res.value) ? true : null
    case 'select':
    case 'radio': {
      // A select with no options is a type-ahead box: the text itself is the answer.
      if (options.length === 0) return res.value
      for (const c of res.choices) {
        const pick = bestOption(c, options)
        if (pick) return pick
      }
      return null
    }
    case 'checkbox_group': {
      for (const c of res.choices) {
        const pick = bestOption(c, options)
        if (pick) return [pick]
      }
      return null
    }
    default:
      return res.value
  }
}

function factSource(detail: string): 'knowledge' | 'question' {
  return detail.startsWith('question:') ? 'question' : 'knowledge'
}

// ── Deterministic profile fields ─────────────────────────────

const EEO_DECLINE = /decline|don.?t wish|do not wish|prefer not|not (to )?(disclose|say|answer|specify|self.?identify|identify)|choose not|rather not|wish not|i do not want|not declared|no answer/i

function currentJob(entries: KnowledgeEntry[]) {
  const e = entries.find(x => x.category === 'experience' && /present/i.test(x.value.split('\n')[0] ?? ''))
  if (!e) return null
  const [company, ...title] = e.key.split(/\s+-\s+/)
  return { company: (company ?? '').trim(), title: title.join(' - ').trim(), key: `experience/${e.key}` }
}

function answer(field: FormField, partial: Partial<FormAnswer>): FormAnswer {
  return {
    fieldId: field.id,
    label: field.label,
    value: null,
    source: 'skipped',
    sourceDetail: null,
    confidence: 'high',
    needsQuestionId: null,
    filled: false,
    fillError: null,
    ...partial,
  }
}

function deterministic(field: FormField, ctx: AnswerContext): FormAnswer | null {
  const label = normalizeLabel(field.label)
  const entries = ctx.entries
  const kb = (value: string | null | undefined, detail: string, confidence: FormAnswer['confidence'] = 'high') =>
    value ? answer(field, { value, source: 'knowledge', sourceDetail: detail, confidence }) : null

  if (field.type === 'file') {
    if (/resume|cv\b|curriculum/.test(label)) return answer(field, { value: 'resume.pdf', source: 'resume', sourceDetail: 'Tailored resume PDF, attached only after you approve' })
    if (/cover/.test(label)) return answer(field, { value: 'cover-letter.pdf', source: 'cover_letter', sourceDetail: 'Cover letter PDF, attached only after you approve' })
    return answer(field, { value: null, source: 'skipped', sourceDetail: 'The pipeline has no document for this upload', fillError: field.required ? 'Needs a document the pipeline does not have' : null })
  }

  if (field.isEeo) {
    const options = field.options ?? []
    const decline = options.find(o => EEO_DECLINE.test(o))
    if (decline) return answer(field, { value: decline, source: 'eeo_decline', sourceDetail: 'Voluntary self-identification: declined' })
    return null // handled by the caller: blank when optional, a question when required
  }

  if (/cover letter/.test(label) && (field.type === 'textarea' || field.type === 'text') && ctx.coverLetter) {
    return answer(field, { value: ctx.coverLetter, source: 'cover_letter', sourceDetail: 'Cover letter for this application' })
  }
  // Names, email, phone, GitHub, and the address come from the fact registry (matchFact), not from here.
  // Whole-label matches only: "Are you subject to agreements with your current employer?" is not a name field.
  if (/^(current |present |most recent |current most recent )?(company|employer|organization)( name)?$/.test(label)) {
    const cj = currentJob(entries)
    return cj ? kb(cj.company, cj.key) : null
  }
  if (/^(current |most recent |current most recent )?(job )?title$|^current (role|position)$/.test(label)) {
    const cj = currentJob(entries)
    return cj ? kb(cj.title, cj.key) : null
  }
  return null
}

const OPT_IN = /\b(sms|text messages?|texts? (me|you)|whatsapp|newsletter|marketing|promotional|future (job )?(opportunit|openings|roles)|talent (community|pool|network)|job alerts?|contact me about)/i

/** Communication and marketing opt-ins: always declined, never asked. */
function optOut(field: FormField): FormAnswer | null {
  if (!OPT_IN.test(field.label)) return null
  if (field.type === 'checkbox') return answer(field, { value: false, source: 'generated', sourceDetail: 'Opt-in declined by rule (the pipeline never opts in to messages or marketing)' })
  const no = (field.options ?? []).find(o => /^no\b/i.test(o.trim()))
  if ((field.type === 'select' || field.type === 'radio') && no) return answer(field, { value: no, source: 'generated', sourceDetail: 'Opt-in declined by rule (the pipeline never opts in to messages or marketing)' })
  if (field.type === 'checkbox_group') return answer(field, { value: null, source: 'skipped', sourceDetail: 'Opt-in left unchecked by rule' })
  return null
}

/** A rule-based value for a choice field must be one of its options. */
function checkOptions(field: FormField, a: FormAnswer | null): FormAnswer | null {
  if (!a || a.value === null || !['select', 'radio'].includes(field.type) || !(field.options ?? []).length) return a
  const pick = bestOption(String(a.value), field.options!)
  return pick ? { ...a, value: pick } : null
}

// ── Claude: option mapping and free answers ──────────────────

const MapSchema = z.object({
  picks: z.array(z.object({
    fieldId: z.string(),
    option: z.string().nullable().describe('With options: one option copied exactly. Without options: the short answer the fact implies, e.g. the country of a US city. Null when the fact does not clearly determine it.'),
  })),
})

/** Picks the option a stated fact implies, for each field. Null when it is not clear. */
export async function mapToOptions(items: Array<{ field: FormField; fact: string }>, ref?: { type: string; id: number }): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  const need: typeof items = []
  for (const it of items) {
    // Plain answers like "Yes" against plain options need no model.
    const direct = bestOption(it.fact.split(': ').pop() ?? '', it.field.options ?? [])
    if (direct && /^(yes|no)$/i.test(direct) && !/without|not require|no sponsorship|unable/i.test(it.field.label)) out.set(it.field.id, direct)
    else need.push(it)
  }
  if (need.length === 0) return out
  const res = await aiStructured(MapSchema, {
    purpose: 'form_option_map',
    maxTokens: 2000,
    effort: 'low',
    ref,
    system: 'You map a known fact about a job applicant onto a form field. Read the question carefully, including negations ("without sponsorship" flips the answer). For a field with options, copy the chosen option exactly. For a field without options, write the short answer the fact directly implies (a US city is in the United States and in its state\'s time zone). If the fact does not clearly determine the answer, return null. Never guess and never add facts.',
    prompt: need.map(it => `FIELD ${it.field.id} (${it.field.type}): ${it.field.label}\n${it.field.options?.length ? `OPTIONS: ${it.field.options.slice(0, 250).map(o => `"${o}"`).join(', ')}` : 'NO OPTIONS (free text)'}\nFACT: ${it.fact}`).join('\n\n'),
  })
  for (const it of need) {
    const pick = res.picks.find(p => p.fieldId === it.field.id)?.option ?? null
    out.set(it.field.id, !pick ? null : it.field.options?.length ? bestOption(pick, it.field.options) : scrubDashes(pick.trim()).slice(0, 200))
  }
  return out
}

// status, source, and confidence are plain strings normalized in code: Haiku 4.5 (the only model
// the production key reaches) sometimes writes a label outside an enum, and a strict enum made the
// whole call fail to parse. A stray label now costs one answer at most, never the whole form.
const FreeSchema = z.object({
  answers: z.array(z.object({
    fieldId: z.string(),
    status: z.string().describe('"answered", "unknown", or "leave_blank"'),
    value: z.string().nullable().describe('select/radio: one option copied exactly. checkbox: "true" or "false". checkbox_group: options copied exactly, joined with " | ". Text: the answer.'),
    source: z.string().describe('"knowledge", "resume", "cover_letter", or "generated"'),
    sourceDetail: z.string().nullable().describe('Knowledge base key such as "skill/PHP", or a short note on where the answer came from'),
    confidence: z.string().describe('"high", "medium", or "low"'),
    questionForDevin: z.string().nullable().describe('When status is unknown: one plain question Devin can answer in a tap or a sentence'),
  })),
})

type FreeStatus = 'answered' | 'unknown' | 'leave_blank'
type FreeSource = 'knowledge' | 'resume' | 'cover_letter' | 'generated'

function normStatus(s: string): FreeStatus {
  const v = s.toLowerCase()
  if (/blank|skip|leave/.test(v)) return 'leave_blank'
  if (/^answer/.test(v)) return 'answered'
  return 'unknown'
}

/** Anything that is not clearly the knowledge base or the resume counts as written by the pipeline. */
function normSource(s: string): FreeSource {
  const v = s.toLowerCase()
  if (v.includes('knowledge')) return 'knowledge'
  if (v.includes('resume')) return 'resume'
  if (v.includes('cover')) return 'cover_letter'
  return 'generated'
}

function normConfidence(s: string): FormAnswer['confidence'] {
  const v = s.toLowerCase()
  return v === 'high' || v === 'low' ? v : 'medium'
}

const FREE_SYSTEM = `You fill in a job application form for Devin Hollister-Graham.
Facts about Devin may come ONLY from the KNOWLEDGE BASE, the TAILORED RESUME, the COVER LETTER, and the KNOWN FACTS. Facts about the employer may come only from the POSTING.

For each field return one answer:
- status "answered" when the sources give the answer. For select and radio fields copy one option exactly. For checkbox fields answer "true" or "false".
- status "unknown" when the field asks for a fact about Devin that the sources do not state. Write questionForDevin. Never guess a fact, a number, a date, a URL, a username, or a yes/no about his history.
- status "leave_blank" for optional fields that are better left empty (marketing opt-ins, referral names, "anything else" boxes with nothing useful to add).

Specific rules:
- Never invent numbers. "Years of experience with X" may only use a number the knowledge base states for X or for his overall experience.
- Yes/no questions about his experience ("Have you used X?", "Have you run Y in production?") may be answered only from what the knowledge base states. A skill the knowledge base does not mention is "unknown", never "No".
- Facts about Devin never come from the cover letter or from your own reasoning; the cover letter may only be reused for motivation questions.
- A question asking whether he previously worked for this employer may be answered "No" only when the employer is absent from his full work history in the knowledge base.
- "How did you hear about this job": use the HOW FOUND line.
- Motivation questions ("Why do you want to work here?"): two to four sentences built from the posting and his real experience. source "generated".
- Experience questions answered in prose ("Describe your experience with X", "Tell us about your work with Y"): Devin's house style, short, skill-forward, and the way he would say it to an interviewer (contractions, plain words, no filler or self-praise). The answer first, then what he did and where, starting with "I" and a plain verb, then the skills he used in that work (a specific decision stated as the skill it shows, not step by step), then at most one supporting project. Each sentence starts with its subject and holds one idea in about 25 words, never over 30. Never open a sentence with context ("On <project>,", "After <event>,"). Two to four sentences, about 350 to 650 characters, never over 800, and within any limit the field states. Leave out dates and months (years of experience such as "8+ years" may stay), a definition of the term asked about, any debugging story, file, field, function, and package names, and numbers that are not meaningful scope. A knowledge base example he wrote is the source: shorten it this way, never add to it.
- Never check a marketing, newsletter, or "contact me about future jobs" box.
- A required box that only confirms the information in the application is true and accurate may be checked.
- Any other box or statement that says Devin did, read, agreed to, or set up something ("I have marked the sender address as safe", "I have read the privacy policy", "I consent to...") is status "unknown". Devin decides those himself.
- Never answer voluntary self-identification questions (gender, race, veteran, disability); they are handled elsewhere.
- Never name a client, a client's product, a repo, or a GitHub organization, and never write the word repo: describe the project instead ("car wash management software", "a telehealth application"). Employers on his resume may be named.
- Plain American English. Never use an em dash or an en dash.`

// ── Derivation ───────────────────────────────────────────────

function questionContext(ctx: AnswerContext, field: FormField, ats: string) {
  return `${ctx.job.company} (${ctx.job.title}) asks "${truncate(field.label, 160)}" on its ${ats} application form. ${field.required ? 'The field is required, so the application waits on your answer.' : 'The field is optional.'}`
}

const OPTIONAL_ASKED = /^Optional: asked you as question #(\d+)/

type AskShape = Omit<AskInput, 'applicationId' | 'jobId' | 'context'>

/** A field that needs a question. Collected while the form is read, resolved together by askOrReuse(). */
interface PendingAsk {
  field: FormField
  input: AskShape
  optional: boolean
  /** The registry's fixed question for a personal fact, and which fact the field wants. */
  registry: boolean
  factKey?: string
}

function askContext(ctx: AnswerContext, ask: PendingAsk, ats: string): string {
  // A fact question is one row shared by every application that needs it, so its context must
  // read true on all of them. A form_field question is specific to the label that asked it.
  if (ask.input.kind === 'form_field') return questionContext(ctx, ask.field, ats)
  if (ask.input.subject === 'home address') return ADDRESS_CONTEXT
  return `Application forms ask for this (first seen on ${ctx.job.company}'s ${ats} form). Your answer is saved to the knowledge base and fills every form that asks.`
}

/**
 * The field's answer once its question is known. needsQuestionId is set only when this
 * application must wait for the answer: a question row is shared across applications and can be
 * blocking because another form requires it, so an optional field here never points at it. Its
 * sourceDetail keeps the question id instead, and refresh fills the field once it is answered.
 */
function answerFromQuestion(field: FormField, q: QuestionRow, ask: PendingAsk): FormAnswer {
  if (q.status === 'answered' && q.answer) {
    // An answered question about another part of the address does not answer this field.
    const sameFact = !ask.registry || !ask.factKey || factForQuestion(q)?.key === ask.factKey || factForQuestion(q)?.group !== 'address'
    const value = sameFact ? valueFromAnswerText(field, cleanStoredAnswer(q.answer)) : null
    if (value !== null && value !== undefined) return answer(field, { value, source: 'question', sourceDetail: `question #${q.id}: ${truncate(q.answer, 80)}`, confidence: 'high' })
    if (!sameFact) {
      return answer(field, { value: null, source: 'skipped', sourceDetail: `question #${q.id} was answered without this part of the address; answer it again with the full address`, confidence: 'low', fillError: field.required ? 'Needs the full home address' : null })
    }
  }
  if (ask.optional) return answer(field, { value: null, source: 'skipped', sourceDetail: `Optional: asked you as question #${q.id}`, confidence: 'low' })
  return answer(field, { value: null, source: 'question', sourceDetail: `question #${q.id}: ${q.question}`, confidence: 'low', needsQuestionId: q.id })
}

/** Resolves every pending ask: an existing question or profile entry when one already covers it, else a new question. */
async function resolveAsks(ctx: AnswerContext, asks: PendingAsk[], ats: string, ref: { type: string; id: number }): Promise<Map<string, FormAnswer>> {
  const out = new Map<string, FormAnswer>()
  if (asks.length === 0) return out
  const { outcomes } = await askOrReuse(asks.map(a => ({
    label: a.field.label,
    input: { ...a.input, applicationId: ctx.applicationId, jobId: ctx.job.id, context: askContext(ctx, a, ats) },
    registry: a.registry,
    factKey: a.factKey,
  })), ref)
  asks.forEach((a, i) => {
    const o = outcomes[i] as AskOutcome
    if ('knowledge' in o) {
      const value = valueFromAnswerText(a.field, cleanStoredAnswer(o.knowledge.value))
      if (value !== null && value !== undefined && value !== '') {
        out.set(a.field.id, answer(a.field, { value, source: 'knowledge', sourceDetail: `${o.knowledge.category}/${o.knowledge.key} (the same thing this label asks)`, confidence: 'medium' }))
        return
      }
      // The entry says it but not as one of the options: ask after all.
      out.set(a.field.id, answerFromQuestion(a.field, askQuestion({ ...a.input, applicationId: ctx.applicationId, jobId: ctx.job.id, context: askContext(ctx, a, ats) }), a))
      return
    }
    out.set(a.field.id, answerFromQuestion(a.field, o.question, a))
  })
  return out
}

function formFieldQuestion(field: FormField, prompt: string | null): AskShape {
  const options = field.options ?? []
  const yesNo = options.length > 0 && options.every(o => /^(yes|no)$/i.test(o.trim()))
  return {
    question: (prompt && prompt.trim()) || field.label,
    kind: 'form_field',
    subject: truncate(field.label, 200),
    answerType: field.type === 'checkbox' || yesNo ? 'yes_no' : options.length > 0 ? 'choice' : field.type === 'number' ? 'number' : 'text',
    choices: options.length > 0 && !yesNo ? options.slice(0, 50) : undefined,
    blocking: field.required,
    category: 'technical',
  }
}

/** Value for a field from Devin's answer text, or null when it needs a model to map. */
function valueFromAnswerText(field: FormField, text: string): FormAnswer['value'] | null {
  const t = text.trim()
  if (field.type === 'checkbox') return /^(yes|true|y|1)$/i.test(t)
  if (field.type === 'number') return t.replace(/,/g, '').match(/\d+(\.\d+)?/)?.[0] ?? null
  if (field.type === 'select' || field.type === 'radio') {
    if (!field.options?.length) return t
    return bestOption(t, field.options)
  }
  if (field.type === 'checkbox_group') {
    const picks = t.split(/\s*[|,;]\s*/).map(p => bestOption(p, field.options ?? [])).filter((p): p is string => !!p)
    return picks.length ? picks : null
  }
  return t
}

/** Every fact the knowledge base states or implies, with answered questions as the fallback. */
function currentFacts(entries: KnowledgeEntry[]): FactValues {
  return resolveFacts(entries, { answered: answeredValue })
}

/** The note on a stage-1 field that Claude answers once Devin taps Apply. */
export const AT_APPLY_DETAIL = 'Written when you tap Apply'

export interface DeriveOptions {
  /**
   * decide (stage 1, before Devin chooses the job): rules, personal facts, option mapping
   * (form_option_map), and the questions the form needs. Fields that need Claude's judgment are
   * left for Apply (atApply), so no form_answers call is made. full (after Apply): everything.
   */
  mode?: 'decide' | 'full'
  /** The stage-1 answers, so preparing reuses an option mapping while its fact is unchanged. */
  prior?: FormAnswer[]
}

export async function deriveAnswers(snapshot: FormSnapshot, ctx: AnswerContext, opts: DeriveOptions = {}): Promise<FormAnswer[]> {
  const mode = opts.mode ?? 'full'
  const ats = ATS_LABELS[snapshot.atsType] ?? 'employer'
  const ref = { type: 'application', id: ctx.applicationId }
  const results = new Map<string, FormAnswer>()
  const factMaps: Array<{ field: FormField; fact: string; detail: string }> = []
  const free: FormField[] = []
  const asks: PendingAsk[] = []
  const facts = currentFacts(ctx.entries)
  const formFieldAsk = (field: FormField, prompt: string | null, blocking = field.required) =>
    asks.push({ field, input: { ...formFieldQuestion(field, prompt), blocking }, optional: false, registry: false })

  for (const field of snapshot.fields) {
    const opt = optOut(field)
    if (opt) { results.set(field.id, opt); continue }
    const det = checkOptions(field, deterministic(field, ctx))
    if (det) { results.set(field.id, det); continue }

    if (field.isEeo) {
      // No decline option: never infer. Blank when optional, Devin's call when required.
      if (field.required) formFieldAsk(field, `${field.label} (voluntary self-identification; the form gives no decline option)`, true)
      else results.set(field.id, answer(field, { value: null, source: 'eeo_decline', sourceDetail: 'Voluntary self-identification left blank', confidence: 'high' }))
      continue
    }

    const matched = matchFact(field, snapshot.fields)
    if (matched) {
      const { def, res } = resolveField(matched, field, facts, snapshot.fields)
      if (res.kind === 'value') {
        const value = valueFromFact(field, res)
        // "United States" picked for "What is your location?" says it is the country option.
        const detail = typeof value === 'string' && value !== res.value ? `${res.detail}, as the option "${value}"` : res.detail
        if (value !== null) results.set(field.id, answer(field, { value, source: factSource(res.detail), sourceDetail: detail, confidence: res.confidence }))
        else factMaps.push({ field, fact: res.statement, detail: res.detail })
      }
      else if (res.kind === 'map') {
        // Pick the option, or derive the short answer (a city's time zone), from the fact.
        factMaps.push({ field, fact: res.statement, detail: res.detail })
      }
      else if (res.kind === 'blank') {
        results.set(field.id, answer(field, { value: null, source: 'skipped', sourceDetail: res.detail, confidence: 'high', fillError: field.required ? `Required, but ${res.detail.replace(/^Left blank: /, '')}` : null }))
      }
      else {
        const q = res.question
        const input: AskShape = { question: q.question, kind: q.kind, subject: q.subject, answerType: q.answerType, knowledgeKey: q.knowledgeKey, category: q.category }
        // Optional and not sensitive: ask once without blocking, so the knowledge base fills in for next time.
        const blocking = field.required || def.alwaysBlocking
        asks.push({ field, input: { ...input, blocking }, optional: !blocking, registry: true, factKey: def.key })
      }
      continue
    }
    free.push(field)
  }

  // Facts that must be mapped onto a list of options, or need judgment on top of the fact.
  if (factMaps.length > 0) {
    // A mapping made at stage 1 from the same fact, for the same label and options, is reused.
    const reused = new Map<string, string>()
    for (const f of factMaps) {
      const p = opts.prior?.find(x => x.fieldId === f.field.id)
      if (p && p.mappedFrom === f.fact && p.label === f.field.label && typeof p.value === 'string' && p.value
        && (!f.field.options?.length || f.field.options.includes(p.value))) reused.set(f.field.id, p.value)
    }
    const need = factMaps.filter(f => !reused.has(f.field.id))
    const picks = need.length ? await mapToOptions(need.map(f => ({ field: f.field, fact: f.fact })), ref) : new Map<string, string | null>()
    for (const [id, v] of reused) picks.set(id, v)
    for (const f of factMaps) {
      const pick = picks.get(f.field.id)
      if (pick) results.set(f.field.id, answer(f.field, { value: pick, source: factSource(f.detail), sourceDetail: f.detail, confidence: 'high', mappedFrom: f.fact }))
      else if (f.field.required) formFieldAsk(f.field, null)
      else results.set(f.field.id, answer(f.field, { value: null, source: 'skipped', sourceDetail: `Could not map "${truncate(f.fact, 80)}" to an answer`, confidence: 'low' }))
    }
  }

  // Stage 1: everything else waits for Apply. Nothing is written for it and nothing is asked.
  if (mode === 'decide') {
    for (const field of free) results.set(field.id, answer(field, { value: null, source: 'skipped', sourceDetail: AT_APPLY_DETAIL, confidence: 'low', atApply: true }))
  }

  // Everything else: one Claude call.
  const recordNames = mode === 'full' ? recordNameList(ctx.entries) : []
  if (mode === 'full' && free.length > 0) {
    const knownFacts = factStatements(facts).map(s => `- ${s}`)
    const posting = (ctx.job.postingText || ctx.job.description || '').replace(/<[^>]+>/g, ' ').slice(0, 7000)
    const res = await aiStructured(FreeSchema, {
      purpose: 'form_answers',
      system: FREE_SYSTEM,
      maxTokens: 8000,
      effort: 'medium',
      ref,
      // The knowledge base and the facts drawn from it are a cached prefix; this application follows.
      prompt: cachedPrompt([`KNOWLEDGE BASE
${knowledgeForPrompt(ctx.entries)}

KNOWN FACTS
${knownFacts.join('\n') || '(none)'}`], `

TAILORED RESUME
${ctx.resume ? `${ctx.resume.summary}\n${ctx.resume.experience.map(e => `${e.title}, ${e.company} (${e.period}): ${e.bullets.join(' ')}`).join('\n')}` : '(none)'}

COVER LETTER
${ctx.coverLetter ?? '(none)'}

HOW FOUND: The pipeline found this posting on ${ctx.job.source === 'sandbox' ? 'a job board' : `the ${ctx.job.source} job board`}.

POSTING: ${ctx.job.title} at ${ctx.job.company}
${posting}

FIELDS
${free.map(f => `${f.id} | ${f.type}${f.required ? ' | required' : ' | optional'}${f.maxLength ? ` | max ${f.maxLength} characters` : ''} | ${f.label}${f.options?.length ? `\n  options: ${f.options.slice(0, 120).map(o => `"${o}"`).join(', ')}` : ''}`).join('\n')}`),
    })

    const sourceText = `${knowledgeText(ctx.entries)}\n${ctx.coverLetter ?? ''}\n${posting}\n${knownFacts.join('\n')}`
    const toVerify: Array<{ field: FormField; a: FormAnswer; sentences: string[] }> = []

    for (const field of free) {
      const raw = res.answers.find(x => x.fieldId === field.id)
      const r = raw ? { ...raw, status: normStatus(raw.status), source: normSource(raw.source), confidence: normConfidence(raw.confidence) } : undefined
      const unknown = (why: string | null) => {
        if (field.required) formFieldAsk(field, r?.questionForDevin ?? null)
        else results.set(field.id, answer(field, { value: null, source: 'skipped', sourceDetail: why ?? 'Optional, and the knowledge base has no answer', confidence: 'low' }))
      }

      if (!r || r.status === 'unknown' || (r.status === 'answered' && (r.value === null || r.value.trim() === ''))) {
        unknown(null)
        continue
      }
      if (r.status === 'leave_blank') {
        if (field.required) unknown(null)
        else results.set(field.id, answer(field, { value: null, source: 'skipped', sourceDetail: 'Optional, left blank', confidence: 'medium' }))
        continue
      }
      let value: FormAnswer['value'] = scrubDashes(r.value!.trim())
      // Text answers never name a client, repo, or organization; the evidence check reads the described text.
      if (!['select', 'radio', 'checkbox', 'checkbox_group'].includes(field.type)) value = withoutRecordNames(value, recordNames)
      if (['select', 'radio'].includes(field.type) && field.options?.length) {
        value = bestOption(value, field.options)
        if (!value) { unknown(`"${r.value}" is not one of the options`); continue }
        const yesNo = field.options.every(o => /^(yes|no)\b/i.test(o.trim()))
        if (yesNo && !['knowledge', 'resume'].includes(r.source)) {
          unknown(`A yes/no answer about Devin needs a knowledge base source; the model gave "${r.source}"`)
          continue
        }
      }
      else if (field.type === 'checkbox_group') {
        const picks = String(value).split(/\s*\|\s*/).map(p => bestOption(p, field.options ?? [])).filter((p): p is string => !!p)
        if (!picks.length) { unknown('No listed option matched'); continue }
        value = picks
      }
      else if (field.type === 'checkbox') {
        value = /^true$/i.test(String(value))
      }
      else {
        const bad = unsupportedNumbers(String(value), sourceText)
        if (bad.length) { unknown(`Answer had numbers found in no source: ${bad.join(', ')}`); continue }
      }
      const a = answer(field, { value, source: r.source, sourceDetail: r.sourceDetail, confidence: r.confidence })
      if (typeof value === 'string' && (field.type === 'textarea' || value.length > 120) && ['generated', 'resume', 'cover_letter'].includes(r.source)) {
        toVerify.push({ field, a, sentences: splitSentences(value) })
      }
      results.set(field.id, a)
    }

    // Free-text answers get the same evidence check as the resume and the cover letter.
    if (toVerify.length > 0) {
      const lines = toVerify.flatMap(v => v.sentences.map((s, i) => ({ id: `${v.field.id}.S${i + 1}`, text: s })))
      const outcomes = await verifyClaims(lines, { entries: ctx.entries, posting, purpose: 'form_answers_verify', ref })
      for (const v of toVerify) {
        // A sentence left opening on a reference to a dropped one ("Also, ...") is repaired, as in the cover letter.
        const kept = joinKeptParagraphs([v.sentences], outcomes, (_, i) => `${v.field.id}.S${i + 1}`)
        const dropped = v.sentences.length - v.sentences.filter((_, i) => outcomes.find(o => o.id === `${v.field.id}.S${i + 1}`)?.final).length
        if (kept.length === 0) {
          results.delete(v.field.id)
          if (v.field.required) formFieldAsk(v.field, null)
          else results.set(v.field.id, answer(v.field, { value: null, source: 'skipped', sourceDetail: 'Every sentence failed the evidence check', confidence: 'low' }))
        }
        else {
          results.set(v.field.id, { ...v.a, value: kept.join(' '), sourceDetail: `${v.a.sourceDetail ?? ''}${dropped ? ` (evidence check removed ${dropped} sentence${dropped > 1 ? 's' : ''})` : ' (evidence check passed)'}`.trim() })
        }
      }
    }
  }

  // Every question this form needs, asked once: an existing question or profile entry that
  // already covers a field is used before anything new is created.
  for (const [id, a] of await resolveAsks(ctx, asks, ats, ref)) results.set(id, a)

  const all = withoutRepeats(snapshot.fields.map(f => results.get(f.id) ?? answer(f, { value: null, source: 'skipped', sourceDetail: 'No answer', confidence: 'low' })))
  // An answer longer than its field's limit gets a copy condensed to fit (stage 1 writes no free text).
  if (mode !== 'full') return all
  const posting = (ctx.job.postingText || ctx.job.description || '').replace(/<[^>]+>/g, ' ').slice(0, 7000)
  return await fitAnswersToFields(all, snapshot.fields, { entries: ctx.entries, posting, ref })
}

/** The last guard before answers are stored: a paragraph or sentence repeated inside one text answer is dropped (dropRepeats). */
export function withoutRepeats(answers: FormAnswer[]): FormAnswer[] {
  return answers.map((a) => {
    const value = dropRepeatsInValue(a.value)
    return value === a.value ? a : { ...a, value }
  })
}

// ── Blockers and refresh ─────────────────────────────────────

function hasValue(v: FormAnswer['value']): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.trim().length > 0
  if (Array.isArray(v)) return v.length > 0
  return true
}

/** Question ids the answers wait on that are still pending and blocking. */
export function openBlockingQuestionIds(answers: FormAnswer[], snapshot?: FormSnapshot | null): number[] {
  // With the snapshot, blocking is decided for THIS application: a pending question blocks it
  // only when one of its own required fields waits on it. The question row's blocking flag is
  // shared by every application that asked the same thing (askQuestion dedupes by subject),
  // so another employer's required field must not block this one.
  const required = snapshot ? new Set(snapshot.fields.filter(f => f.required).map(f => f.id)) : null
  const ids = [...new Set(answers
    .filter(a => typeof a.needsQuestionId === 'number' && (!required || required.has(a.fieldId)))
    .map(a => a.needsQuestionId as number))]
  if (ids.length === 0) return []
  return useDb().select().from(questions).where(inArray(questions.id, ids)).all()
    .filter(q => q.status === 'pending' && (required ? true : q.blocking))
    .map(q => q.id)
}

/** The refresh running (or waiting) per application id. */
const refreshRuns = new Map<number, Promise<unknown>>()

/**
 * Called after Devin answers a question. Re-derives the stored answers from the stored snapshot
 * (no browser): every answer waiting on an answered question takes Devin's answer, and the
 * application moves from needs_input to proposed once nothing blocks it.
 * Returns the number of answers that changed and the resulting status.
 */
/**
 * Waiting applications with a field that waits on a personal-fact question the registry no longer
 * reads the field as (CircleCI's "Are you located in and willing to work in the location where the
 * job is posted?" waited on the home address question). Each is refreshed, which lets the field go
 * of that question and asks its own. Run by learn:daily; a refresh after an answer does the same.
 */
export async function releaseMisreadFactFields(log: (m: string) => void = () => {}): Promise<number[]> {
  const db = useDb()
  const apps = db.select().from(applications).where(inArray(applications.status, ['to_decide', 'needs_input', 'proposed'])).all()
  const misread: number[] = []
  for (const app of apps) {
    const snapshot = parseJson<FormSnapshot | null>(app.formSnapshotJson, null)
    if (!snapshot) continue
    const answers = parseJson<FormAnswer[]>(app.answersJson, [])
    const found = answers.some((a) => {
      const qid = a.needsQuestionId ?? (a.source === 'skipped' && a.sourceDetail ? Number(a.sourceDetail.match(OPTIONAL_ASKED)?.[1]) || null : null)
      if (!qid) return false
      const field = snapshot.fields.find(f => f.id === a.fieldId)
      const q = canonicalQuestion(qid)
      return !!field && !!q && q.kind === 'fact' && !!factForQuestion(q) && !matchFact(field, snapshot.fields)
        && !labelTiedTo([field.label, formFieldQuestion(field, null).subject], q.id)
    })
    if (found) misread.push(app.id)
  }
  const refreshed: number[] = []
  for (const id of misread) {
    try {
      await refreshStoredAnswers(id)
      refreshed.push(id)
    }
    catch (e) {
      console.error(`[answers] refresh of application ${id} after a misread fact field failed`, e)
    }
  }
  if (misread.length) log(`misread fact fields: refreshed applications ${refreshed.join(', ') || 'none'}${refreshed.length < misread.length ? ` (failed: ${misread.filter(id => !refreshed.includes(id)).join(', ')})` : ''}`)
  return refreshed
}

export async function refreshStoredAnswers(applicationId: number): Promise<{ updated: number; status: string; blockingQuestionIds: number[] }> {
  // One refresh per application at a time. Two answers saved close together each refresh the
  // applications that share their questions, and a refresh waits on Claude between reading the
  // stored answers and writing them back. Run side by side, the later write dropped the other's
  // filled field, so an answered question came back on the card as one its answer "did not fill".
  const before = refreshRuns.get(applicationId) ?? Promise.resolve()
  const run = before.catch(() => {}).then(() => refreshStoredAnswersNow(applicationId))
  refreshRuns.set(applicationId, run)
  try {
    return await run
  }
  finally {
    if (refreshRuns.get(applicationId) === run) refreshRuns.delete(applicationId)
  }
}

async function refreshStoredAnswersNow(applicationId: number): Promise<{ updated: number; status: string; blockingQuestionIds: number[] }> {
  const db = useDb()
  const app = db.select().from(applications).where(eq(applications.id, applicationId)).get()
  if (!app) throw new Error(`Application ${applicationId} not found`)
  const snapshot = parseJson<FormSnapshot | null>(app.formSnapshotJson, null)
  const answers = parseJson<FormAnswer[]>(app.answersJson, [])
  if (!snapshot || answers.length === 0) return { updated: 0, status: app.status, blockingQuestionIds: [] }

  // Answers waiting on a question, and optional fields whose question was asked without blocking.
  const questionIdOf = (a: FormAnswer): number | null => a.needsQuestionId ?? (a.source === 'skipped' && a.sourceDetail ? Number(a.sourceDetail.match(OPTIONAL_ASKED)?.[1]) || null : null)
  const ids = [...new Set(answers.map(questionIdOf).filter((x): x is number => typeof x === 'number'))]
  const rows = ids.length ? db.select().from(questions).where(inArray(questions.id, ids)).all() : []
  // A duplicate the tidy merged points at its canonical question from here on.
  const qById = new Map(rows.map(r => [r.id, canonicalQuestion(r.id) ?? r] as const))
  const facts = currentFacts(loadKnowledge())
  let updated = 0
  const needModel: Array<{ field: FormField; fact: string; index: number; source: 'knowledge' | 'question'; detail: string; answerText: string | null }> = []
  /** Fact questions a field let go of because the field is not that fact. */
  const misread = new Set<number>()
  /** Required fields that let go of a misread fact question and need their own question. */
  const reask: number[] = []

  let next = answers.map((original, index) => {
    const qid = questionIdOf(original)
    if (!qid) return original
    const field = snapshot.fields.find(f => f.id === original.fieldId)
    const q = qById.get(qid)
    if (!q || !field) return original
    let a = original
    if (q.id !== qid) {
      // Assignments keep the answer's key order (releaseStaleQuestions matches the JSON text).
      a = { ...original }
      if (a.needsQuestionId) a.needsQuestionId = q.id
      if (a.sourceDetail) a.sourceDetail = a.sourceDetail.replace(/question #\d+/, `question #${q.id}`)
      updated++
    }
    // A personal fact the knowledge base now answers fills the field whatever the question's
    // state: the address answer is split into parts, and each field takes the part it asks for.
    // Except when Devin answered the field's own question: that question exists only because the
    // fact could not fill the field ("Location Preference" reads as his home city, which matches
    // none of Upstart's options), so his answer wins. Taking the fact again left the field waiting
    // on an answered question forever, with nothing to answer on the card.
    const matched = matchFact(field, snapshot.fields)
    // A registry fact question waiting on a field that is no personal fact at all: an education
    // "Start date month" once read as "when could you start". The field lets go of the question
    // instead of taking its answer. An optional field is left blank; a required one is asked as
    // its own form question below.
    // A field the semantic check or a merge tied to this question asks what it asks, even though
    // the registry does not read the label as that fact.
    if (q.kind === 'fact' && !matched && factForQuestion(q) && !labelTiedTo([field.label, formFieldQuestion(field, null).subject], q.id)) {
      updated++
      misread.add(q.id)
      const why = isHistoryDate(field, snapshot.fields) ? 'a date in your education or work history, not when you could start' : `not what question #${q.id} asks`
      if (field.required) reask.push(index)
      return { ...a, value: null, source: 'skipped' as const, sourceDetail: `${field.required ? 'Required' : 'Optional'}, left blank: ${why}`, confidence: 'high' as const, needsQuestionId: null, filled: false, fillError: null }
    }
    const ownAnswer = q.kind === 'form_field' && q.status === 'answered'
    if (matched && !ownAnswer && (q.status === 'answered' || a.needsQuestionId)) {
      const { res } = resolveField(matched, field, facts, snapshot.fields)
      if (res.kind === 'value') {
        const value = valueFromFact(field, res)
        if (value !== null) {
          updated++
          const detail = typeof value === 'string' && value !== res.value ? `${res.detail}, as the option "${value}"` : res.detail
          return { ...a, value, source: factSource(res.detail), sourceDetail: detail, confidence: res.confidence, needsQuestionId: null, filled: false, fillError: null }
        }
        if (q.status === 'answered') {
          needModel.push({ field, fact: res.statement, index, source: factSource(res.detail), detail: res.detail, answerText: null })
          return a
        }
      }
      else if (res.kind === 'map' && q.status === 'answered') {
        needModel.push({ field, fact: res.statement, index, source: factSource(res.detail), detail: res.detail, answerText: null })
        return a
      }
    }
    if (!a.needsQuestionId && q.status !== 'answered') return a
    if (q.status === 'skipped' && !field.required) {
      updated++
      return { ...a, needsQuestionId: null, source: 'skipped' as const, sourceDetail: appSkipNote(q) ? `The app skipped question #${q.id}` : `You skipped question #${q.id}` }
    }
    if (q.status !== 'answered' || !q.answer) return a
    const answerText = cleanStoredAnswer(q.answer)
    const value = valueFromAnswerText(field, answerText)
    if (value === null || value === undefined) {
      needModel.push({ field, fact: `Asked "${q.question}", Devin answered: ${answerText}`, index, source: 'question', detail: `question #${q.id}: ${truncate(q.answer, 80)}`, answerText })
      return a
    }
    updated++
    return { ...a, value, source: 'question' as const, sourceDetail: `question #${q.id}: ${truncate(q.answer, 80)}`, confidence: 'high' as const, needsQuestionId: null, filled: false, fillError: null }
  })

  if (needModel.length > 0) {
    const picks = await mapToOptions(needModel.map(n => ({ field: n.field, fact: n.fact })), { type: 'application', id: applicationId })
    for (const n of needModel) {
      const pick = picks.get(n.field.id)
      if (!pick) {
        next[n.index] = { ...next[n.index]!, sourceDetail: `${n.answerText !== null ? `${n.detail.split(':')[0]} answered "${truncate(n.answerText, 60)}"` : `"${truncate(n.detail, 60)}"`}, which matches none of the options; pick one by hand` }
        continue
      }
      updated++
      next[n.index] = { ...next[n.index]!, value: pick, source: n.source, sourceDetail: n.detail, confidence: 'high', needsQuestionId: null, filled: false, fillError: null }
    }
  }

  // A required field whose question was skipped or is gone is asked again, and so is a required
  // field that let go of a misread fact question, so the card always has a question for it under
  // Answer first. Both go through askOrReuse(): a question merged into another, or one the semantic
  // check says asks the same thing, is reused instead of asked a second time. The question a field
  // just let go of is never the answer: that field asks its own question.
  const job = db.select({ company: jobs.company }).from(jobs).where(eq(jobs.id, app.jobId)).get()
  const askAgain: Array<{ index: number; field: FormField; released: boolean }> = []
  for (let i = 0; i < next.length; i++) {
    const a = next[i]!
    const field = snapshot.fields.find(f => f.id === a.fieldId)
    if (!field?.required || !a.needsQuestionId || hasValue(a.value)) continue
    const status = [...qById.values()].find(q => q.id === a.needsQuestionId)?.status
    if (status === 'pending' || status === 'answered') continue
    askAgain.push({ index: i, field, released: false })
  }
  for (const i of reask) {
    const field = snapshot.fields.find(f => f.id === next[i]!.fieldId)
    if (field) askAgain.push({ index: i, field, released: true })
  }
  if (askAgain.length > 0) {
    const inputs: AskInput[] = askAgain.map(({ field }) => ({
      ...formFieldQuestion(field, null),
      applicationId,
      jobId: app.jobId,
      context: `${job?.company || 'The employer'} asks "${cleanFieldLabel(field.label)}" on its application form. The field is required, so the application waits on your answer.`,
      blocking: true,
    }))
    const { outcomes } = await askOrReuse(askAgain.map((r, n) => ({ label: r.field.label, input: inputs[n]!, registry: false })), { type: 'application', id: applicationId })
    askAgain.forEach((r, n) => {
      const o = outcomes[n]!
      const asked = 'question' in o && !misread.has(o.question.id) ? o.question : askQuestion(inputs[n]!)
      qById.set(asked.id, asked)
      const a = next[r.index]!
      const label = cleanFieldLabel(r.field.label)
      if (!r.released) updated++
      next[r.index] = r.released
        ? { ...a, source: 'question', confidence: 'low', needsQuestionId: asked.id, sourceDetail: `question #${asked.id}: ${truncate(label, 80)}` }
        : { ...a, needsQuestionId: asked.id, sourceDetail: `question #${asked.id}: ${truncate(label, 80)}` }
    })
  }

  // A misread fact question this application asked, now waited on by no field of any
  // application, was only ever asked by mistake. It is skipped with the app's note, so it leaves
  // this application's card and the open questions. A form that really asks it asks again
  // (askQuestion re-asks when only a skipped row exists).
  for (const id of misread) {
    const q = qById.get(id)
    if (!q || q.id !== id || q.status !== 'pending' || q.applicationId !== applicationId) continue
    if (next.some(a => questionIdOf(a) === id)) continue
    const elsewhere = db.select({ id: applications.id, answersJson: applications.answersJson }).from(applications)
      .where(and(ne(applications.id, applicationId), like(applications.answersJson, `%${id}%`))).all()
      .some(o => parseJson<FormAnswer[]>(o.answersJson, []).some(x => questionIdOf(x) === id))
    if (elsewhere) continue
    skipForApp(id, 'asked by mistake: the form field that asked it was not this question, and no other field waits on it')
    qById.set(id, { ...q, status: 'skipped', blocking: false })
  }

  const blocking = openBlockingQuestionIds(next, snapshot)
  const statusOf = (id: number) => [...qById.values()].find(q => q.id === id)?.status
  // A required field still waiting on a question that is not pending (answered but the answer
  // did not fit, skipped, or gone) keeps the application waiting: it never goes to review blank.
  const unresolvedRequired = next.filter((a) => {
    const f = snapshot.fields.find(x => x.id === a.fieldId)
    return f?.required && a.needsQuestionId && !hasValue(a.value) && !blocking.includes(a.needsQuestionId) && statusOf(a.needsQuestionId) !== 'pending'
  })
  let status = app.status
  next = withoutRepeats(next)
  // Devin's answer (an example can run to 5,000 characters) gets a copy condensed to each field's limit.
  const fitJob = db.select({ postingText: jobs.postingText, description: jobs.description }).from(jobs).where(eq(jobs.id, app.jobId)).get()
  next = await fitAnswersToFields(next, snapshot.fields, {
    entries: loadKnowledge(),
    posting: (fitJob?.postingText || fitJob?.description || '').replace(/<[^>]+>/g, ' ').slice(0, 7000),
    ref: { type: 'application', id: applicationId },
  })
  const extra: Record<string, unknown> = { answersJson: JSON.stringify(next) }
  if (app.status === 'needs_input' && blocking.length === 0 && unresolvedRequired.length === 0) {
    status = 'proposed'
    setApplicationStatus(applicationId, 'proposed', 'Ready for review', { ...extra, proposedAt: nowSql() } as any)
  }
  else if (app.status === 'needs_input') {
    const n = blocking.length + unresolvedRequired.length
    setApplicationStatus(applicationId, 'needs_input', `Waiting on ${n} answer${n === 1 ? '' : 's'} from you`, extra as any)
  }
  else {
    db.update(applications).set({ answersJson: JSON.stringify(next), updatedAt: nowSql() }).where(eq(applications.id, applicationId)).run()
  }
  return { updated, status, blockingQuestionIds: blocking }
}
