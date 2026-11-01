import { z } from 'zod'
import { eq, inArray } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { applications, jobs, questions } from '../../db/schema'
import type { FormAnswer, FormField, FormSnapshot, TailoredResume } from '#shared/types/pipeline'
import { aiStructured } from '../ai'
import { profileValue, type KnowledgeEntry } from '../knowledge'
import { answeredValue, askQuestion, type AskInput } from '../questions'
import { nowSql, parseJson, setApplicationStatus } from '../review'
import { ATS_LABELS } from './ats'
import { knowledgeForPrompt, knowledgeText, verifyClaims } from './evidence'
import { bestOption } from './fill'
import { normalizeLabel, scrubDashes, splitSentences, truncate, unsupportedNumbers } from './text'

type JobRow = InferSelectModel<typeof jobs>

// Turns a form snapshot into answers, without a browser. Order of resolution per field:
// 1. deterministic lookups in the knowledge base (name, email, phone, GitHub, current employer,
//    files, EEO decline options);
// 2. canonical facts with a fixed question vocabulary (work authorization, sponsorship,
//    relocation, start date, salary, location, LinkedIn): knowledge base, then an answered
//    question, then a new question for Devin;
// 3. one Claude call for everything else, whose free-text answers go through the evidence check.
// A field nobody can answer becomes a question: blocking when the field is required (and always
// for the five sensitive facts), and skipped without a question when it is optional.

export interface AnswerContext {
  applicationId: number
  job: JobRow
  entries: KnowledgeEntry[]
  resume: TailoredResume | null
  coverLetter: string | null
}

// ── Canonical facts ──────────────────────────────────────────

interface CanonicalFact {
  key: string
  match: RegExp
  kind: AskInput['kind']
  /** Fixed subject so the question dedupes across every application and every ATS. */
  subject: string
  question: string
  knowledgeKey: string
  kbKeys: string[]
  answerType: 'yes_no' | 'text'
  /** The brief's five sensitive facts block approval even on optional fields. */
  alwaysBlocking: boolean
  statement: (v: string) => string
  /** Labels the stored value answers as written. Others (a city's country, its time zone) are derived by mapToOptions. */
  direct?: RegExp
}

export const CANONICAL_FACTS: CanonicalFact[] = [
  {
    key: 'sponsorship',
    match: /sponsor/i,
    kind: 'fact',
    subject: 'visa sponsorship',
    question: 'Will you now or in the future need visa sponsorship to work in the United States?',
    knowledgeKey: 'profile:Needs Visa Sponsorship',
    kbKeys: ['profile/needs visa sponsorship', 'profile/visa sponsorship', 'profile/sponsorship'],
    answerType: 'yes_no',
    alwaysBlocking: true,
    statement: v => `Asked whether he needs visa sponsorship now or in the future to work in the United States, Devin answered: ${v}`,
  },
  {
    key: 'work_authorization',
    // "able to work from a state where we are registered" is about location, so plain "able" is not enough.
    match: /(authori[sz]ed|eligible|permitted|entitled) to (legally |lawfully )?work|legally (able|permitted) to work|work authori[sz]ation|right to work|employment eligibility|(legally|lawfully) work/i,
    kind: 'fact',
    subject: 'US work authorization',
    question: 'Are you legally authorized to work in the United States?',
    knowledgeKey: 'profile:Work Authorization (US)',
    kbKeys: ['profile/work authorization us', 'profile/work authorization', 'profile/authorized to work in us'],
    answerType: 'yes_no',
    alwaysBlocking: true,
    statement: v => `Asked whether he is legally authorized to work in the United States, Devin answered: ${v}`,
  },
  {
    key: 'relocation',
    match: /relocat/i,
    kind: 'preference',
    subject: 'relocation',
    question: 'Are you willing to relocate for a job? If yes, where?',
    knowledgeKey: 'preference:Willing to Relocate',
    kbKeys: ['preference/willing to relocate', 'preference/relocation'],
    answerType: 'text',
    alwaysBlocking: true,
    statement: v => `Asked whether he is willing to relocate, Devin answered: ${v}`,
  },
  {
    key: 'start_date',
    match: /start date|when (can|could|would) you (start|begin)|earliest (possible )?(date|start)|available to start|availability to start|notice period|date available/i,
    kind: 'fact',
    subject: 'start date',
    question: 'When could you start a new job, or how much notice do you need to give?',
    knowledgeKey: 'preference:Earliest Start Date',
    kbKeys: ['preference/earliest start date', 'preference/start date', 'preference/notice period'],
    answerType: 'text',
    alwaysBlocking: true,
    statement: v => `Asked when he could start, Devin answered: ${v}`,
  },
  {
    key: 'salary',
    match: /salary|compensation (expectation|requirement)|expected (pay|compensation|salary)|desired (pay|salary|compensation)|pay expectation|compensation expectation|rate expectation|expected annual/i,
    kind: 'preference',
    subject: 'salary expectation',
    question: 'What salary should applications list as your expectation?',
    knowledgeKey: 'preference:Target Salary',
    kbKeys: ['preference/target salary', 'preference/salary expectation', 'preference/salary floor', 'preference/minimum salary'],
    answerType: 'text',
    alwaysBlocking: true,
    statement: v => `Devin's salary expectation (from his knowledge base): ${v}`,
  },
  {
    key: 'linkedin',
    match: /linked\s?in/i,
    kind: 'fact',
    subject: 'LinkedIn URL',
    question: 'What is your LinkedIn profile URL? Answer "none" if you do not use LinkedIn.',
    knowledgeKey: 'profile:LinkedIn',
    kbKeys: ['profile/linkedin', 'profile/linkedin url'],
    answerType: 'text',
    alwaysBlocking: false,
    statement: v => `Devin's LinkedIn profile: ${v}`,
  },
  {
    key: 'location',
    match: /^(current )?(location|city)\b|location \(city\)|where are you (currently )?(located|based)|current (city|location|address)|country of residence|(country|city|state) (are|do) you (currently )?(based|located|live|reside)|are you (currently )?(based|located|living|residing) in|do you (currently )?(reside|live)|where do you live|city,? state|state of residence|^address$|^city$|time ?zone|state where you (will )?(reside|live|work)/i,
    kind: 'fact',
    subject: 'current location',
    question: 'What city and state do you live in now?',
    knowledgeKey: 'profile:Location',
    kbKeys: ['profile/location', 'profile/city', 'profile/current location'],
    answerType: 'text',
    alwaysBlocking: false,
    statement: v => `Devin currently lives in: ${v}`,
    direct: /^(current )?(location|city|address)|location \(city\)|where are you (currently )?(located|based)\??$|current (city|location)|city,? state/i,
  },
  {
    key: 'postal_code',
    match: /zip|postal code|postcode/i,
    kind: 'fact',
    subject: 'zip code',
    question: 'What is your home zip code?',
    knowledgeKey: 'profile:Zip Code',
    kbKeys: ['profile/zip code', 'profile/zip', 'profile/postal code'],
    answerType: 'text',
    alwaysBlocking: false,
    statement: v => `Devin's home zip code: ${v}`,
  },
]

export function canonicalFactFor(field: FormField): CanonicalFact | null {
  if (field.isEeo || field.type === 'file') return null
  return CANONICAL_FACTS.find(f => f.match.test(field.label)) ?? null
}

function kbLookup(entries: KnowledgeEntry[], keys: string[]): KnowledgeEntry | null {
  const wanted = keys.map(k => normalizeLabel(k.replace('/', ' ')))
  return entries.find(e => wanted.includes(normalizeLabel(`${e.category} ${e.key}`))) ?? null
}

interface ResolvedFact { value: string; source: 'knowledge' | 'question'; detail: string }

/**
 * The learning unit stores a yes/no answer as "Yes. (Answer to: <question>)". Forms need the
 * answer itself, so the suffix and the lone period go.
 */
export function cleanStoredAnswer(value: string): string {
  return value
    .replace(/\s*\(Answer to:[\s\S]*\)\s*$/i, '')
    .replace(/^(yes|no|some experience)\.$/i, '$1')
    .trim()
}

function resolveFact(fact: CanonicalFact, entries: KnowledgeEntry[]): ResolvedFact | null {
  const kb = kbLookup(entries, fact.kbKeys)
  const kbValue = kb ? cleanStoredAnswer(kb.value) : ''
  if (kb && kbValue && !/^none$/i.test(kbValue)) return { value: kbValue, source: 'knowledge', detail: `${kb.category}/${kb.key}` }
  const answered = cleanStoredAnswer(answeredValue(fact.kind, fact.subject) ?? '')
  if (answered && !/^none$/i.test(answered)) return { value: answered, source: 'question', detail: `question: ${fact.subject}` }
  return null
}

// ── Deterministic profile fields ─────────────────────────────

const EEO_DECLINE = /decline|don.?t wish|do not wish|prefer not|not (to )?(disclose|say|answer|specify|self.?identify|identify)|choose not|rather not|wish not|i do not want|not declared|no answer/i

function currentJob(entries: KnowledgeEntry[]) {
  const e = entries.find(x => x.category === 'experience' && /present/i.test(x.value.split('\n')[0] ?? ''))
  if (!e) return null
  const [company, ...title] = e.key.split(/\s+-\s+/)
  return { company: (company ?? '').trim(), title: title.join(' - ').trim(), key: `experience/${e.key}` }
}

function githubUrl(entries: KnowledgeEntry[]): string | null {
  const v = profileValue(entries, 'GitHub')
  if (!v) return null
  return /^https?:\/\//i.test(v) ? v : `https://github.com/${v.replace(/^@/, '')}`
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
  const fullName = profileValue(entries, 'Full Name', 'name')
  const [first, ...rest] = (fullName ?? '').split(/\s+/)
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
  if (/^(legal )?first name$|^given name$|^first$/.test(label)) return kb(first, 'profile/Full Name')
  if (/^(legal )?last name$|^surname$|^family name$|^last$/.test(label)) return kb(rest.join(' '), 'profile/Full Name')
  if (/^(full |legal |your |candidate |full legal )?name$/.test(label)) return kb(fullName, 'profile/Full Name')
  if (/preferred (first )?name|name you d prefer|prefer us to use|nickname/.test(label)) return kb(first, 'profile/Full Name', 'medium')
  if (field.type === 'email' || /^e ?mail( address)?$|^your email/.test(label)) return kb(profileValue(entries, 'Email'), 'profile/Email')
  if (field.type === 'tel' || /^(phone|mobile|cell)( number)?$|phone number/.test(label)) return kb(profileValue(entries, 'Phone'), 'profile/Phone')
  if (/github/.test(label) && !/username|handle/.test(label)) return kb(githubUrl(entries), 'profile/GitHub')
  if (/github (username|handle)/.test(label)) return kb(profileValue(entries, 'GitHub'), 'profile/GitHub')
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

function factValueFor(field: FormField, fact: ResolvedFact, canonical: CanonicalFact): string | null {
  if (canonical.direct && !canonical.direct.test(field.label)) return null
  if (canonical.direct && /country|time ?zone|state where|zip|postal/i.test(field.label)) return null
  if (field.type === 'number') {
    const n = fact.value.replace(/,/g, '').match(/\d+(\.\d+)?/)
    return n ? n[0] : null
  }
  if (['text', 'textarea', 'url', 'email', 'tel', 'date'].includes(field.type)) return fact.value
  return null // choice fields are mapped by mapToOptions
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

const FreeSchema = z.object({
  answers: z.array(z.object({
    fieldId: z.string(),
    status: z.enum(['answered', 'unknown', 'leave_blank']),
    value: z.string().nullable().describe('select/radio: one option copied exactly. checkbox: "true" or "false". checkbox_group: options copied exactly, joined with " | ". Text: the answer.'),
    source: z.enum(['knowledge', 'resume', 'cover_letter', 'generated']),
    sourceDetail: z.string().nullable().describe('Knowledge base key such as "skill/PHP", or a short note on where the answer came from'),
    confidence: z.enum(['high', 'medium', 'low']),
    questionForDevin: z.string().nullable().describe('When status is unknown: one plain question Devin can answer in a tap or a sentence'),
  })),
})

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
- Never check a marketing, newsletter, or "contact me about future jobs" box. A required box confirming the application is accurate may be checked.
- Never answer voluntary self-identification questions (gender, race, veteran, disability); they are handled elsewhere.
- Plain American English. Never use an em dash or an en dash.`

// ── Derivation ───────────────────────────────────────────────

function questionContext(ctx: AnswerContext, field: FormField, ats: string) {
  return `${ctx.job.company} (${ctx.job.title}) asks "${truncate(field.label, 160)}" on its ${ats} application form. ${field.required ? 'The field is required, so the application waits on your answer.' : 'The field is optional.'}`
}

const OPTIONAL_ASKED = /^Optional: asked you as question #(\d+)/

/**
 * Asks Devin and returns the field's answer. needsQuestionId is set only when this application
 * must wait for the answer: a question row is shared across applications and can be blocking
 * because another form requires it, so an optional field here never points at it. Its
 * sourceDetail keeps the question id instead, and refresh fills the field once it is answered.
 */
function askFor(ctx: AnswerContext, field: FormField, ats: string, input: Omit<AskInput, 'applicationId' | 'jobId' | 'context'>, opts: { optional?: boolean } = {}): FormAnswer {
  // A fact question is one row shared by every application that needs it, so its context must
  // read true on all of them. A form_field question is specific to the label that asked it.
  const context = input.kind === 'form_field'
    ? questionContext(ctx, field, ats)
    : `Application forms ask for this (first seen on ${ctx.job.company}'s ${ats} form). Your answer is saved to the knowledge base and fills every form that asks.`
  const q = askQuestion({ ...input, applicationId: ctx.applicationId, jobId: ctx.job.id, context })
  if (q.status === 'answered' && q.answer) {
    const value = valueFromAnswerText(field, cleanStoredAnswer(q.answer))
    if (value !== null && value !== undefined) return answer(field, { value, source: 'question', sourceDetail: `question #${q.id}: ${truncate(q.answer, 80)}`, confidence: 'high' })
  }
  if (opts.optional) return answer(field, { value: null, source: 'skipped', sourceDetail: `Optional: asked you as question #${q.id}`, confidence: 'low' })
  return answer(field, { value: null, source: 'question', sourceDetail: `question #${q.id}: ${q.question}`, confidence: 'low', needsQuestionId: q.id })
}

function formFieldQuestion(field: FormField, prompt: string | null): Omit<AskInput, 'applicationId' | 'jobId' | 'context'> {
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

export async function deriveAnswers(snapshot: FormSnapshot, ctx: AnswerContext): Promise<FormAnswer[]> {
  const ats = ATS_LABELS[snapshot.atsType] ?? 'employer'
  const ref = { type: 'application', id: ctx.applicationId }
  const results = new Map<string, FormAnswer>()
  const factMaps: Array<{ field: FormField; fact: string; resolved: ResolvedFact }> = []
  const free: FormField[] = []

  for (const field of snapshot.fields) {
    const opt = optOut(field)
    if (opt) { results.set(field.id, opt); continue }
    const det = checkOptions(field, deterministic(field, ctx))
    if (det) { results.set(field.id, det); continue }

    if (field.isEeo) {
      // No decline option: never infer. Blank when optional, Devin's call when required.
      results.set(field.id, field.required
        ? askFor(ctx, field, ats, { ...formFieldQuestion(field, `${field.label} (voluntary self-identification; the form gives no decline option)`), blocking: true })
        : answer(field, { value: null, source: 'eeo_decline', sourceDetail: 'Voluntary self-identification left blank', confidence: 'high' }))
      continue
    }

    const fact = canonicalFactFor(field)
    if (fact) {
      const resolved = resolveFact(fact, ctx.entries)
      if (resolved) {
        const direct = factValueFor(field, resolved, fact)
        if (direct !== null) {
          results.set(field.id, answer(field, { value: direct, source: resolved.source, sourceDetail: resolved.detail, confidence: 'high' }))
        }
        else {
          // Pick the option, or derive the short answer (a city's country or time zone), from the fact.
          factMaps.push({ field, fact: fact.statement(resolved.value), resolved })
        }
        continue
      }
      if (field.required || fact.alwaysBlocking) {
        results.set(field.id, askFor(ctx, field, ats, {
          question: fact.question,
          kind: fact.kind,
          subject: fact.subject,
          answerType: fact.answerType,
          knowledgeKey: fact.knowledgeKey,
          blocking: true,
          category: fact.kind === 'preference' ? 'preference' : 'technical',
        }))
      }
      else {
        // Optional: ask once without blocking, so the knowledge base fills in for next time.
        const a = askFor(ctx, field, ats, { question: fact.question, kind: fact.kind, subject: fact.subject, answerType: fact.answerType, knowledgeKey: fact.knowledgeKey, blocking: false }, { optional: true })
        results.set(field.id, a)
      }
      continue
    }
    free.push(field)
  }

  // Facts that must be mapped onto a list of options.
  if (factMaps.length > 0) {
    const picks = await mapToOptions(factMaps.map(f => ({ field: f.field, fact: f.fact })), ref)
    for (const f of factMaps) {
      const pick = picks.get(f.field.id)
      results.set(f.field.id, pick
        ? answer(f.field, { value: pick, source: f.resolved.source, sourceDetail: f.resolved.detail, confidence: 'high' })
        : f.field.required
          ? askFor(ctx, f.field, ats, formFieldQuestion(f.field, null))
          : answer(f.field, { value: null, source: 'skipped', sourceDetail: `Could not map "${f.resolved.value}" to an option`, confidence: 'low' }))
    }
  }

  // Everything else: one Claude call.
  if (free.length > 0) {
    const knownFacts = CANONICAL_FACTS.map(f => ({ f, r: resolveFact(f, ctx.entries) })).filter(x => x.r).map(x => `- ${x.f.statement(x.r!.value)}`)
    const posting = (ctx.job.postingText || ctx.job.description || '').replace(/<[^>]+>/g, ' ').slice(0, 7000)
    const res = await aiStructured(FreeSchema, {
      purpose: 'form_answers',
      system: FREE_SYSTEM,
      maxTokens: 8000,
      effort: 'medium',
      ref,
      prompt: `KNOWLEDGE BASE
${knowledgeForPrompt(ctx.entries)}

KNOWN FACTS
${knownFacts.join('\n') || '(none)'}

TAILORED RESUME
${ctx.resume ? `${ctx.resume.summary}\n${ctx.resume.experience.map(e => `${e.title}, ${e.company} (${e.period}): ${e.bullets.join(' ')}`).join('\n')}` : '(none)'}

COVER LETTER
${ctx.coverLetter ?? '(none)'}

HOW FOUND: The pipeline found this posting on ${ctx.job.source === 'sandbox' ? 'a job board' : `the ${ctx.job.source} job board`}.

POSTING: ${ctx.job.title} at ${ctx.job.company}
${posting}

FIELDS
${free.map(f => `${f.id} | ${f.type}${f.required ? ' | required' : ' | optional'}${f.maxLength ? ` | max ${f.maxLength} characters` : ''} | ${f.label}${f.options?.length ? `\n  options: ${f.options.slice(0, 120).map(o => `"${o}"`).join(', ')}` : ''}`).join('\n')}`,
    })

    const sourceText = `${knowledgeText(ctx.entries)}\n${ctx.coverLetter ?? ''}\n${posting}\n${knownFacts.join('\n')}`
    const toVerify: Array<{ field: FormField; a: FormAnswer; sentences: string[] }> = []

    for (const field of free) {
      const r = res.answers.find(x => x.fieldId === field.id)
      const unknown = (why: string | null) => field.required
        ? askFor(ctx, field, ats, formFieldQuestion(field, r?.questionForDevin ?? null))
        : answer(field, { value: null, source: 'skipped', sourceDetail: why ?? 'Optional, and the knowledge base has no answer', confidence: 'low' })

      if (!r || r.status === 'unknown' || (r.status === 'answered' && (r.value === null || r.value.trim() === ''))) {
        results.set(field.id, unknown(null))
        continue
      }
      if (r.status === 'leave_blank') {
        results.set(field.id, field.required ? unknown(null) : answer(field, { value: null, source: 'skipped', sourceDetail: 'Optional, left blank', confidence: 'medium' }))
        continue
      }
      let value: FormAnswer['value'] = scrubDashes(r.value!.trim())
      if (['select', 'radio'].includes(field.type) && field.options?.length) {
        value = bestOption(value, field.options)
        if (!value) { results.set(field.id, unknown(`"${r.value}" is not one of the options`)); continue }
        const yesNo = field.options.every(o => /^(yes|no)\b/i.test(o.trim()))
        if (yesNo && !['knowledge', 'resume'].includes(r.source)) {
          results.set(field.id, unknown(`A yes/no answer about Devin needs a knowledge base source; the model gave "${r.source}"`))
          continue
        }
      }
      else if (field.type === 'checkbox_group') {
        const picks = String(value).split(/\s*\|\s*/).map(p => bestOption(p, field.options ?? [])).filter((p): p is string => !!p)
        if (!picks.length) { results.set(field.id, unknown('No listed option matched')); continue }
        value = picks
      }
      else if (field.type === 'checkbox') {
        value = /^true$/i.test(String(value))
      }
      else {
        const bad = unsupportedNumbers(String(value), sourceText)
        if (bad.length) { results.set(field.id, unknown(`Answer had numbers found in no source: ${bad.join(', ')}`)); continue }
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
        const kept = v.sentences.map((_, i) => outcomes.find(o => o.id === `${v.field.id}.S${i + 1}`)?.final).filter(Boolean)
        const dropped = v.sentences.length - kept.length
        if (kept.length === 0) {
          results.set(v.field.id, v.field.required ? askFor(ctx, v.field, ats, formFieldQuestion(v.field, null)) : answer(v.field, { value: null, source: 'skipped', sourceDetail: 'Every sentence failed the evidence check', confidence: 'low' }))
        }
        else {
          results.set(v.field.id, { ...v.a, value: kept.join(' '), sourceDetail: `${v.a.sourceDetail ?? ''}${dropped ? ` (evidence check removed ${dropped} sentence${dropped > 1 ? 's' : ''})` : ' (evidence check passed)'}`.trim() })
        }
      }
    }
  }

  return snapshot.fields.map(f => results.get(f.id) ?? answer(f, { value: null, source: 'skipped', sourceDetail: 'No answer', confidence: 'low' }))
}

// ── Blockers and refresh ─────────────────────────────────────

/** Question ids the answers wait on that are still pending and blocking. */
export function openBlockingQuestionIds(answers: FormAnswer[]): number[] {
  const ids = [...new Set(answers.map(a => a.needsQuestionId).filter((x): x is number => typeof x === 'number'))]
  if (ids.length === 0) return []
  return useDb().select().from(questions).where(inArray(questions.id, ids)).all()
    .filter(q => q.status === 'pending' && q.blocking)
    .map(q => q.id)
}

/**
 * Called after Devin answers a question. Re-derives the stored answers from the stored snapshot
 * (no browser): every answer waiting on an answered question takes Devin's answer, and the
 * application moves from needs_input to proposed once nothing blocks it.
 * Returns the number of answers that changed and the resulting status.
 */
export async function refreshStoredAnswers(applicationId: number): Promise<{ updated: number; status: string; blockingQuestionIds: number[] }> {
  const db = useDb()
  const app = db.select().from(applications).where(eq(applications.id, applicationId)).get()
  if (!app) throw new Error(`Application ${applicationId} not found`)
  const snapshot = parseJson<FormSnapshot | null>(app.formSnapshotJson, null)
  const answers = parseJson<FormAnswer[]>(app.answersJson, [])
  if (!snapshot || answers.length === 0) return { updated: 0, status: app.status, blockingQuestionIds: [] }

  // Answers waiting on a question, and optional fields whose question was asked without blocking.
  const questionIdOf = (a: FormAnswer): number | null => a.needsQuestionId ?? (a.source === 'skipped' && a.sourceDetail ? Number(a.sourceDetail.match(OPTIONAL_ASKED)?.[1]) || null : null)
  const ids = [...new Set(answers.map(questionIdOf).filter((x): x is number => typeof x === 'number'))]
  const qs = ids.length ? db.select().from(questions).where(inArray(questions.id, ids)).all() : []
  let updated = 0
  const needModel: Array<{ field: FormField; fact: string; q: (typeof qs)[number]; index: number }> = []

  const next = answers.map((a, index) => {
    const qid = questionIdOf(a)
    if (!qid) return a
    const q = qs.find(x => x.id === qid)
    const field = snapshot.fields.find(f => f.id === a.fieldId)
    if (!q || !field) return a
    if (!a.needsQuestionId && q.status !== 'answered') return a
    if (q.status === 'skipped' && !field.required) {
      updated++
      return { ...a, needsQuestionId: null, source: 'skipped' as const, sourceDetail: `You skipped question #${q.id}` }
    }
    if (q.status !== 'answered' || !q.answer) return a
    const fact = canonicalFactFor(field)
    const answerText = cleanStoredAnswer(q.answer)
    let value = valueFromAnswerText(field, answerText)
    // A fact that does not answer this field as written ("Springfield, MO" for "What country?")
    // goes through the same strict mapping as during preparation.
    if (fact?.direct && !(field.options ?? []).length && factValueFor(field, { value: answerText, source: 'question', detail: '' }, fact) === null) value = null
    if (value === null || value === undefined) {
      needModel.push({ field, fact: fact ? fact.statement(answerText) : `Asked "${q.question}", Devin answered: ${answerText}`, q, index })
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
        next[n.index] = { ...next[n.index]!, sourceDetail: `question #${n.q.id} answered "${truncate(n.q.answer ?? '', 60)}", which matches none of the options; pick one by hand` }
        continue
      }
      updated++
      next[n.index] = { ...next[n.index]!, value: pick, source: 'question', sourceDetail: `question #${n.q.id}: ${truncate(n.q.answer ?? '', 80)}`, confidence: 'high', needsQuestionId: null, filled: false, fillError: null }
    }
  }

  const blocking = openBlockingQuestionIds(next)
  const unresolvedRequired = next.filter((a) => {
    const f = snapshot.fields.find(x => x.id === a.fieldId)
    return f?.required && a.needsQuestionId && !blocking.includes(a.needsQuestionId) && qs.find(q => q.id === a.needsQuestionId)?.status === 'answered'
  })
  let status = app.status
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
