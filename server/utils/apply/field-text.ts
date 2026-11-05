import type { FormAnswer, FormField, FormSnapshot } from '#shared/types/pipeline'

// The form's own text for a field (FormField.description, read by extract.ts): the instruction a
// Lever card puts above a confirmation box, a Greenhouse or Ashby question description. A
// form_field question shows it under the question and the chat gets it as context; it is read
// from the stored form snapshot when needed, never copied onto the question row.

/**
 * A label that points at text it does not contain ("the sender address above", "the following
 * statement", "these terms"). Snapshots read before descriptions were kept lost that text, so
 * their forms are read once more (field-text-reread.ts).
 */
export const REFERS_ELSEWHERE = /\b(above|below|the following|these terms|the terms|this address|the address|the statement|this statement|listed)\b/i

export function refersElsewhere(label: string | null | undefined): boolean {
  return REFERS_ELSEWHERE.test(label ?? '')
}

/** The question a stored answer points at: waiting on it, answered from it, or asked as an optional field. */
export function answerQuestionId(a: FormAnswer): number | null {
  if (typeof a.needsQuestionId === 'number') return a.needsQuestionId
  const m = /^(?:Optional: asked you as )?question #(\d+)\b/.exec(a.sourceDetail ?? '')
  return m ? Number(m[1]) : null
}

// Local, so review.ts and questions.ts can import this file without a cycle.
function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  }
  catch {
    return fallback
  }
}

interface AppForm {
  id: number
  answersJson: string | null
  formSnapshotJson: string | null
}

/**
 * The field a question was asked for, in the first of these applications whose answers point at
 * it (the asking application should come first). Parsed snapshots are kept in `cache` by id, so
 * one list of questions parses each application once.
 */
export function fieldForQuestion(
  questionId: number,
  apps: AppForm[],
  cache: Map<number, { answers: FormAnswer[]; fields: FormField[] }> = new Map(),
): { applicationId: number; field: FormField; answer: FormAnswer } | null {
  for (const a of apps) {
    let parsed = cache.get(a.id)
    if (!parsed) {
      parsed = {
        answers: parseJson<FormAnswer[]>(a.answersJson, []),
        fields: parseJson<FormSnapshot | null>(a.formSnapshotJson, null)?.fields ?? [],
      }
      cache.set(a.id, parsed)
    }
    const answer = parsed.answers.find(x => answerQuestionId(x) === questionId)
    if (!answer) continue
    const field = parsed.fields.find(f => f.id === answer.fieldId)
    if (field) return { applicationId: a.id, field, answer }
  }
  return null
}

/** The form's text for the field a form_field question came from, or null. */
export function formTextForQuestion(
  questionId: number,
  apps: AppForm[],
  cache?: Map<number, { answers: FormAnswer[]; fields: FormField[] }>,
): string | null {
  for (const a of apps) {
    const hit = fieldForQuestion(questionId, [a], cache)
    if (hit?.field.description) return hit.field.description
  }
  return null
}
