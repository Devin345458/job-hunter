/**
 * Questions answered or skipped on this page, so every card drops one the moment it is answered
 * and keeps it dropped until the server is done with it.
 *
 * PATCH /api/questions/:id refreshes every application waiting on the question before it returns
 * (answerQuestion in server/utils/questions.ts), which takes seconds when many applications share
 * the question. A read that started after the save returned is the server's word: a question it
 * still lists truly needs a different answer on that card, and the card says why. A read that
 * started earlier (a poll, another answer's re-read) can predate the save, so it never brings the
 * question back.
 */
export function useAnsweredQuestions() {
  /** Question id to when its save came back (null while it is in flight). */
  const saves = new Map<number, { done: number | null }>()

  function start(id: number) {
    saves.set(id, { done: null })
  }

  function finish(id: number) {
    const s = saves.get(id)
    if (s) s.done = Date.now()
  }

  /** The save failed: the question shows again wherever the server lists it. */
  function fail(id: number) {
    saves.delete(id)
  }

  /** The questions a read that started at readStartedAt may show. */
  function visible<Q extends { id: number }>(questions: Q[], readStartedAt: number): Q[] {
    return questions.filter((q) => {
      const s = saves.get(q.id)
      return !s || (s.done !== null && readStartedAt >= s.done)
    })
  }

  return { start, finish, fail, visible }
}
