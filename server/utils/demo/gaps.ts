import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { questions } from '../../db/schema'
import type { GapAnalysis, GapItem, Requirement } from '#shared/types/pipeline'
import { availableToolchains, primaryLanguage } from './exec'
import { getAppWithJob, storeGapAnalysis } from './store'
import { demoLanguageName, noIdeaSentence, noToolchainSentence, oneDemoSentence, tooLargeSentence, wrongLanguageSentence } from './gap-text'
import { plainQuestionContext } from '#shared/utils/plain-text'
import { NOT_A_GAP } from '#shared/utils/requirement-kinds'

// Owned by the demo-projects unit. Application prep calls analyzeGaps once per application
// and stores the result in applications.gap_analysis_json; demos:build refreshes it when a
// question it asked has since been answered.
//
// Three steps:
// 1. Claude lists the posting's requirements the knowledge base does not clearly cover,
//    each with a short subject ("Go") and a status judged only against the knowledge base.
// 2. Code applies Devin's answered questions. Where the knowledge base is silent and he has
//    not answered, it asks him (never assumes he lacks the skill, never assumes he has it).
// 3. Claude decides demo, reframe, or skip for the confirmed gaps; code then enforces the
//    hard rules (toolchain exists, about four hours of work, one demo per application).

const MAX_DEMO_HOURS = 6

const CandidateSchema = z.object({
  candidates: z.array(z.object({
    requirement: z.string().describe('The requirement as the posting states it, shortened to one line'),
    mustHave: z.boolean().describe('False when the posting marks it nice to have, preferred, bonus, or plus'),
    subject: z.string().describe('The skill, language, tool, or experience in two to five words, e.g. "Go", "Kubernetes in production"'),
    status: z.enum(['partial', 'lack', 'unknown']),
    evidence: z.string().nullable().describe('Knowledge base entry behind a partial or lack status, quoted briefly. Null for unknown.'),
    askKind: z.enum(['has_done', 'knows']).describe('has_done for experience or practice, knows for a language or tool'),
    question: z.string().describe('Yes or no question for Devin, e.g. "Have you used Go in a real project?"'),
    codeShowable: z.boolean().describe('True only when a small code project could show this: a language, framework, tool, platform, or technical technique. False for experience a project cannot show: presenting or giving live demos, customer or stakeholder work, leading people, running something in production at scale, on-call, industry or domain experience. Also false when the requirement joins a technique to production scale or reliability ("at scale", "in production", "reliable and scalable"), because a small project cannot show the scale.'),
  })),
})

const DecisionSchema = z.object({
  decisions: z.array(z.object({
    index: z.number().int().describe('Index of the gap in the list you were given'),
    decision: z.enum(['demo', 'reframe', 'skip']),
    rationale: z.string().describe('One or two sentences on why. Address the job seeker as "you"; never he, she, or they.'),
    demoIdea: z.object({
      title: z.string().describe('Short project name, title case, no more than five words'),
      summary: z.string().describe('Two sentences: what the project does and what it shows'),
      stack: z.array(z.string()).describe('Language first, then libraries, e.g. ["Go", "net/http", "testing"]'),
      scopeHours: z.number().describe('Hours of focused human work'),
    }).nullable().describe('Required when decision is demo, otherwise null'),
  })),
})

const YES = /^(y|yes|yeah|yep|true|i have|i do)\b/i
const NO = /^(n|no|nope|false|never|i have not|i haven't|i do not|i don't|not really)\b/i

/**
 * A requirement as the end of a question's context sentence: without the "(kind: ...)" tag the
 * gap prompt shows the model (which it can copy back), and with one final period, so "the U.S."
 * never becomes "the U.S..".
 */
function asSentence(requirement: string): string {
  return `${plainQuestionContext(requirement).trim().replace(/[.\s]+$/, '')}.`
}

function answerOf(subject: string): { kind: 'has_done' | 'knows'; answer: string; id: number } | null {
  const rows = useDb().select().from(questions)
    .where(and(inArray(questions.dedupeKey, [dedupeKeyOf('has_done', subject), dedupeKeyOf('knows', subject)]), eq(questions.status, 'answered')))
    .all()
  const row = rows.find(r => r.kind === 'has_done') ?? rows[0]
  return row?.answer ? { kind: row.kind as 'has_done' | 'knows', answer: row.answer.trim(), id: row.id } : null
}

/** True when Devin himself skipped a question on this subject. A skip the app made (with its note) does not count. */
function wasSkipped(subject: string): boolean {
  return useDb().select().from(questions)
    .where(and(inArray(questions.dedupeKey, [dedupeKeyOf('has_done', subject), dedupeKeyOf('knows', subject)]), eq(questions.status, 'skipped')))
    .all().some(q => !appSkipNote(q))
}

function knownQuestions() {
  // Ordered by id, so the prompt lists them in the same order every time (prompt caching).
  return useDb().select().from(questions)
    .where(and(inArray(questions.kind, ['has_done', 'knows']), inArray(questions.status, ['pending', 'answered', 'skipped'])))
    .orderBy(questions.id)
    .all()
}

export async function analyzeGaps(applicationId: number): Promise<GapAnalysis> {
  const row = getAppWithJob(applicationId)
  if (!row) throw new Error(`Application ${applicationId} not found`)
  const { app, job } = row
  const analyzedAt = new Date().toISOString()

  const requirements = parseJson<Requirement[]>(job.requirementsJson, [])
  const posting = job.postingText || htmlToText(job.description) || ''
  if (requirements.length === 0 && posting.trim().length < 40) {
    return { items: [], demoRecommended: false, summary: 'The posting has no requirements to compare.', analyzedAt }
  }

  const kb = formatKnowledge(knowledgeMap(loadKnowledge()))
  const asked = knownQuestions()
  const askedText = asked.length
    ? asked.map(q => `- [${q.status}] ${q.kind} "${q.subject}": ${q.question}${q.answer ? ` Answer: ${q.answer}` : ''}`).join('\n')
    : '(none)'
  const reqText = requirements.length
    ? requirements.map((r, i) => `${i + 1}. ${r.text} (kind: ${r.kind}, ${r.mustHave ? 'must have' : 'nice to have'}, status: ${r.status}${r.evidence ? `, evidence: ${r.evidence}` : ''})`).join('\n')
    : null

  // ── Step 1: gap candidates ──
  const { candidates } = await aiStructured(CandidateSchema, {
    purpose: 'gap_candidates',
    effort: 'low',
    maxTokens: 8000,
    ref: { type: 'application', id: applicationId },
    system: 'You compare a job posting with a candidate\'s knowledge base and list what the knowledge base does not clearly cover. You judge only from the knowledge base and the candidate\'s answered questions. You never guess what the candidate has or has not done.',
    // The rules stay after the job's requirements, where they were tuned ("Leave out" below is
    // named from the requirements block); the cached prefix is the knowledge base and the questions.
    prompt: cachedPrompt([`Candidate: Devin Hollister-Graham.

<knowledge_base>
${kb}
</knowledge_base>`, `

<questions_already_asked>
${askedText}
</questions_already_asked>`], `

${reqText
  ? `<requirements>\n${reqText}\n</requirements>\n\nThese requirements were already judged against the knowledge base. List every one whose status is not "have", except the kinds under "Leave out" below.`
  : `<posting>\n${posting.slice(0, 20000)}\n</posting>\n\nRead the whole posting, including the duties, and list each concrete technical requirement (languages, frameworks, tools, platforms, kinds of experience) that the knowledge base does not clearly show.`}

Status rules:
- partial: the knowledge base shows only an adjacent skill, not the one asked for (for example Express when the posting asks for NestJS). Quote the entry in evidence.
- lack: the knowledge base or an answered question says he does not have it.
- unknown: the knowledge base does not mention it. Use unknown whenever you would otherwise be guessing.
Leave out:
- Anything the knowledge base names directly, even when the posting asks for more years, bigger data, or more depth than the entry states. Those are not gaps a project can close.
- Soft skills and attitudes (communication, language fluency, reliability, adaptability, ownership, openness to or curiosity about a tool), leadership, years of experience, education, work authorization, and location.
When a question was already asked about the same thing, reuse its exact subject text.
Write the question so Devin can answer yes or no in one tap. Plain American English, no dashes.`),
  })

  // ── Step 2: apply answers, ask when silent ──
  const items: GapItem[] = []
  const confirmed: Array<{ item: GapItem; subject: string; status: 'partial' | 'lack'; evidence: string | null }> = []
  const seen = new Set<string>()
  for (const c of candidates) {
    // Work authorization, location, and degrees are profile facts; the prompt says to leave them
    // out, and this holds when the model lists one anyway ("U.S. work authorization and residency").
    if (NOT_A_GAP.test(`${c.subject} ${c.requirement}`)) continue
    const subject = c.subject.trim()
    const key = subject.toLowerCase()
    if (!subject || seen.has(key)) continue
    seen.add(key)
    const base: GapItem = { requirement: c.requirement, mustHave: c.mustHave, decision: 'skip', rationale: '', demoIdea: null, questionId: null }
    const answered = answerOf(subject)
    if (answered) {
      base.questionId = answered.id
      if (YES.test(answered.answer)) {
        items.push({ ...base, decision: 'reframe', rationale: `You answered "${answered.answer}" when asked about ${subject}, so the resume and letter can say so. No demo needed.` })
        continue
      }
      const status = NO.test(answered.answer) ? 'lack' : 'partial'
      if (!c.codeShowable) {
        items.push({ ...base, decision: 'skip', rationale: `You answered "${answered.answer}" about ${subject}. A code project cannot show this kind of experience, so no demo is planned.` })
        continue
      }
      confirmed.push({ item: base, subject, status, evidence: `Devin answered "${answered.answer}" when asked about ${subject}.` })
      continue
    }
    if (c.status === 'unknown') {
      if (wasSkipped(subject)) {
        items.push({ ...base, decision: 'skip', rationale: `The knowledge base does not mention ${subject} and you skipped the question about it.` })
        continue
      }
      const q = askQuestion({
        question: c.question,
        context: `${job.title} at ${job.company} asks for: ${asSentence(c.requirement)} The knowledge base does not say whether you have this. ${c.codeShowable ? GAP_CONTEXT_CODE : GAP_CONTEXT_EXPERIENCE}`,
        kind: c.askKind,
        subject,
        answerType: 'yes_no',
        knowledgeKey: `skill:${subject}`,
        applicationId,
        jobId: job.id,
        blocking: false,
      })
      if (q.status === 'answered' && q.answer) {
        // Answered under a slightly different subject spelling between the lookup and the insert.
        const status = NO.test(q.answer) ? 'lack' : YES.test(q.answer) ? null : 'partial'
        if (!status) {
          items.push({ ...base, questionId: q.id, decision: 'reframe', rationale: `You answered "${q.answer}" about ${subject}. No demo needed.` })
        }
        else if (!c.codeShowable) {
          items.push({ ...base, questionId: q.id, decision: 'skip', rationale: `You answered "${q.answer}" about ${subject}. A code project cannot show this kind of experience, so no demo is planned.` })
        }
        else {
          confirmed.push({ item: { ...base, questionId: q.id }, subject, status, evidence: `Devin answered "${q.answer}" about ${subject}.` })
        }
        continue
      }
      items.push({ ...base, decision: 'ask', questionId: q.id, rationale: `The knowledge base does not say whether you have ${subject}. Asked: "${q.question}"` })
      continue
    }
    if (!c.codeShowable) {
      items.push({ ...base, decision: 'skip', rationale: `${subject} is experience a code project cannot show, so no demo is planned.` })
      continue
    }
    confirmed.push({ item: base, subject, status: c.status, evidence: c.evidence })
  }

  // ── Step 3: decide for confirmed gaps ──
  const lackOf = new Map<GapItem, boolean>()
  const subjectOf = new Map<GapItem, string>()
  if (confirmed.length > 0) {
    const toolchains = await availableToolchains()
    const languages = [...new Set(toolchains.flatMap(t => t.languages))]
    const gapText = confirmed.map((c, i) => `${i}. ${c.item.requirement} (subject: ${c.subject}, ${c.item.mustHave ? 'must have' : 'nice to have'}, status: ${c.status}${c.evidence ? `, evidence: ${c.evidence}` : ''})`).join('\n')
    const { decisions } = await aiStructured(DecisionSchema, {
      purpose: 'gap_decisions',
      effort: 'medium',
      maxTokens: 8000,
      ref: { type: 'application', id: applicationId },
      system: 'You advise a senior web developer on how to handle the gaps between his record and a job posting. You are careful about anything published under his name.',
      // Instructions and knowledge base first (the same for every application), then this job.
      prompt: cachedPrompt([`For each gap choose one decision:
- demo: build a small public project that shows the skill. Choose it only when all of these hold:
  * A small, credible, self-contained project of about four hours of focused work would show the skill directly (the project is written in that language or uses that tool as its core).
  * Devin could own it in an interview: it is published on his GitHub under his name, so it must be something a senior web developer could read end to end and explain.
  * It runs and tests offline with nothing but its own code and package dependencies: no cloud accounts, paid APIs, API keys, or database servers.
  * It can be written in one of these languages, the only toolchains on the build server: ${languages.join(', ') || 'none'}.
  * The gap is a must have, or the posting's duties name it directly.
- reframe: existing experience in the knowledge base covers the spirit of the requirement. Name the entry in the rationale.
- skip: a demo would not be credible or would not help. Years of experience, degrees, certifications, industry or domain experience, leadership, production scale, data volume, and on-call history cannot be shown by a demo.
Hard rules for demo:
- The project is written in, or built around, the gap's subject itself. If the subject is a programming language, the project is written in that language.
- Never choose demo when the evidence shows Devin already uses the skill; choose reframe.
- Never choose demo when the project would need a database server, message broker, or cloud service to run.
Recommend at most one demo. Keep demo ideas modest and concrete (for example a webhook receiver with signature checks and retries, not a platform).
Plain American English. No dashes. Quote the knowledge base as written; never add years, numbers, or facts about Devin that it does not state.`, `

<knowledge_base>
${kb}
</knowledge_base>`], `

Job: ${job.title} at ${job.company}.

<posting>
${posting.slice(0, 12000)}
</posting>

<gaps>
${gapText}
</gaps>`),
    })

    for (let i = 0; i < confirmed.length; i++) {
      const c = confirmed[i]!
      const d = decisions.find(x => x.index === i)
      const item: GapItem = { ...c.item }
      lackOf.set(item, c.status === 'lack')
      subjectOf.set(item, c.subject)
      if (!d) {
        items.push({ ...item, decision: 'skip', rationale: 'No decision was returned for this gap.' })
        continue
      }
      item.decision = d.decision
      item.rationale = d.rationale
      item.demoIdea = d.decision === 'demo' && d.demoIdea
        ? { title: d.demoIdea.title, summary: d.demoIdea.summary, stack: d.demoIdea.stack, scopeHours: d.demoIdea.scopeHours }
        : null
      // When a hard rule refuses the demo Claude recommended, the row says so in one sentence of
      // its own; Claude's rationale argues for the demo, so it is not kept.
      if (item.decision === 'demo') {
        const lang = primaryLanguage(item.demoIdea?.stack ?? [])
        const subjectLang = primaryLanguage([c.subject])
        if (!item.demoIdea) {
          item.decision = 'skip'
          item.rationale = noIdeaSentence(c.subject)
        }
        else if (!languages.includes(lang)) {
          item.decision = 'skip'
          item.rationale = noToolchainSentence(c.subject, demoLanguageName(lang, [c.subject, ...item.demoIdea.stack]))
          item.demoIdea = null
        }
        else if (subjectLang !== 'other' && subjectLang !== lang) {
          item.decision = 'skip'
          item.rationale = wrongLanguageSentence(c.subject, demoLanguageName(lang, item.demoIdea.stack))
          item.demoIdea = null
        }
        else if (item.demoIdea.scopeHours > MAX_DEMO_HOURS) {
          item.decision = 'skip'
          item.rationale = tooLargeSentence(c.subject, item.demoIdea.scopeHours)
          item.demoIdea = null
        }
      }
      items.push(item)
    }
  }

  // At most one demo per application. A gap Devin confirmed he lacks outranks a partial one,
  // then must-haves outrank nice-to-haves.
  const demos = items.filter(i => i.decision === 'demo')
  if (demos.length > 1) {
    const rank = (i: GapItem) => (lackOf.get(i) ? 0 : 2) + (i.mustHave ? 0 : 1)
    const keep = [...demos].sort((a, b) => rank(a) - rank(b))[0]!
    for (const i of demos) {
      if (i === keep) continue
      i.decision = 'skip'
      i.rationale = oneDemoSentence(subjectOf.get(i), keep.demoIdea?.title)
      i.demoIdea = null
    }
  }

  const count = (d: GapItem['decision']) => items.filter(i => i.decision === d).length
  const demo = items.find(i => i.decision === 'demo')
  const parts = [
    demo ? `Demo planned: ${demo.demoIdea?.title} (for ${demo.requirement}).` : 'No demo planned.',
    count('ask') ? `${count('ask')} ${count('ask') === 1 ? 'question' : 'questions'} waiting on you.` : null,
    count('reframe') ? `${count('reframe')} covered by existing experience.` : null,
    count('skip') ? `${count('skip')} skipped.` : null,
  ].filter(Boolean)

  return {
    items,
    demoRecommended: Boolean(demo),
    summary: items.length ? `${items.length} ${items.length === 1 ? 'gap' : 'gaps'}. ${parts.join(' ')}` : 'No gaps: the knowledge base covers every requirement.',
    analyzedAt,
  }
}

/** Run analyzeGaps and store the result on the application. */
export async function refreshGapAnalysis(applicationId: number): Promise<GapAnalysis> {
  const gap = await analyzeGaps(applicationId)
  storeGapAnalysis(applicationId, gap)
  return gap
}

/** True when a question this analysis asked has been answered or skipped since. */
export function gapAnalysisIsStale(gap: GapAnalysis): boolean {
  const ids = gap.items.filter(i => i.decision === 'ask' && i.questionId).map(i => i.questionId!)
  if (ids.length === 0) return false
  return useDb().select().from(questions).where(inArray(questions.id, ids)).all()
    .some(q => q.status === 'answered' || q.status === 'skipped')
}
