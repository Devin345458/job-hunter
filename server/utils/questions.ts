import { and, eq, inArray } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { questions } from '../db/schema'

export type QuestionRow = InferSelectModel<typeof questions>

export interface AskInput {
  /** Plain question Devin can answer in a tap or a sentence, e.g. "Have you used Go in production?" */
  question: string
  /** Why the pipeline is asking. Shown under the question. */
  context?: string
  kind: 'has_done' | 'knows' | 'preference' | 'fact' | 'form_field' | 'other'
  /** What the question is about, e.g. "Go", "salary floor". Drives dedupe. */
  subject: string
  answerType?: 'yes_no' | 'text' | 'number' | 'choice'
  choices?: string[]
  /** Where the answer is stored in the knowledge base, "category:key". */
  knowledgeKey?: string
  applicationId?: number
  jobId?: number
  /** True when an application cannot be approved until this is answered. */
  blocking?: boolean
  category?: string
}

export function dedupeKeyOf(kind: string, subject: string) {
  return `${kind}:${subject.toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim()}`
}

/**
 * Ask Devin a question, at most once per (kind, subject).
 * - Already answered: returns the existing row (status 'answered'), so the caller can use the answer.
 * - Already pending: returns it, and marks it blocking if this caller needs it to block.
 * - Otherwise inserts a new pending question.
 */
export function askQuestion(input: AskInput): QuestionRow {
  const db = useDb()
  const dedupeKey = dedupeKeyOf(input.kind, input.subject)
  const existing = db.select().from(questions)
    .where(and(eq(questions.dedupeKey, dedupeKey), inArray(questions.status, ['pending', 'answered'])))
    .all()
  const answered = existing.find(q => q.status === 'answered')
  if (answered) return answered
  const pending = existing.find(q => q.status === 'pending')
  if (pending) {
    if (input.blocking && !pending.blocking) {
      db.update(questions).set({ blocking: true }).where(eq(questions.id, pending.id)).run()
      return { ...pending, blocking: true }
    }
    return pending
  }
  return db.insert(questions).values({
    question: input.question,
    context: input.context ?? null,
    category: input.category ?? (input.kind === 'preference' ? 'preference' : 'technical'),
    kind: input.kind,
    subject: input.subject,
    answerType: input.answerType ?? (input.kind === 'has_done' || input.kind === 'knows' ? 'yes_no' : 'text'),
    choicesJson: input.choices ? JSON.stringify(input.choices) : null,
    knowledgeKey: input.knowledgeKey ?? null,
    applicationId: input.applicationId ?? null,
    jobId: input.jobId ?? null,
    blocking: input.blocking ?? false,
    dedupeKey,
    status: 'pending',
  }).returning().get()
}

/** Answered value for a (kind, subject), or null if Devin has not answered it. */
export function answeredValue(kind: AskInput['kind'], subject: string): string | null {
  const row = useDb().select().from(questions)
    .where(and(eq(questions.dedupeKey, dedupeKeyOf(kind, subject)), eq(questions.status, 'answered')))
    .get()
  return row?.answer ?? null
}
