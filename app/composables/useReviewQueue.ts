import type { ApplicationStatus, RejectReasonCode, RejectSkillsMode, ReviewItem } from '#shared/types/pipeline'
import { IN_FLIGHT, PREPARING, statusMeta } from './review/format'
import { useAnsweredQuestions } from './review/answered'

const QUEUE_STATUSES: ApplicationStatus[] = ['to_decide', 'preparing', 'proposed', 'needs_input', 'approved', 'publishing', 'submitting', 'submit_failed', 'needs_manual', 'submitted']


function errorMessage(e: any, fallback: string): string {
  // No response at all: the network or the server is down. The raw fetch text is noise.
  if (!e?.response && !e?.statusCode && !e?.data) return 'The server did not answer. Check the connection, then try again.'
  return e?.data?.statusMessage || e?.data?.message || e?.statusMessage || fallback
}

// ── Queue state ──────────────────────────────────────────────

export interface QueueGroups {
  /** Stage 1: Apply or Reject. */
  decide: ReviewItem[]
  /** Apply was tapped: the resume, letter, and form are being written. */
  preparing: ReviewItem[]
  /** Stage 2: prepared, Approve or Reject. */
  send: ReviewItem[]
  attention: ReviewItem[]
  sending: ReviewItem[]
  sent: ReviewItem[]
}

/**
 * Everything the review page needs: the queue, grouped; approve and reject; inline question
 * answers; and polling for applications the server is still working through after approve.
 */
export function useReviewQueue() {
  const items = ref<ReviewItem[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref<string | null>(null)
  /** Application ids whose answers are being re-derived after a question was answered. */
  const refreshing = ref<Set<number>>(new Set())
  const answered = useAnsweredQuestions()

  /** The item as a read that started at readStartedAt may show it: no question whose save is in flight or came back after that read started. */
  function shown(item: ReviewItem, readStartedAt: number): ReviewItem {
    const openQuestions = answered.visible(item.openQuestions, readStartedAt)
    return openQuestions.length === item.openQuestions.length ? item : { ...item, openQuestions }
  }

  function replace(item: ReviewItem, readStartedAt = Date.now()) {
    const next = shown(item, readStartedAt)
    const i = items.value.findIndex(x => x.applicationId === item.applicationId)
    if (i >= 0) items.value.splice(i, 1, next)
    else items.value.push(next)
  }

  function remove(id: number) {
    items.value = items.value.filter(x => x.applicationId !== id)
  }

  async function load() {
    loading.value = true
    try {
      const startedAt = Date.now()
      const res = await $fetch<{ items: ReviewItem[] }>('/api/review/queue', { query: { status: QUEUE_STATUSES.join(',') } })
      items.value = res.items.map(i => shown(i, startedAt))
      error.value = null
      loaded.value = true
      schedulePoll()
    }
    catch (e: any) {
      error.value = errorMessage(e, 'Could not load the review queue')
    }
    finally {
      loading.value = false
    }
  }

  const groups = computed<QueueGroups>(() => {
    const g: QueueGroups = { decide: [], preparing: [], send: [], attention: [], sending: [], sent: [] }
    for (const item of items.value) {
      const group = statusMeta(item.status).group
      if (group !== 'closed') g[group].push(item)
    }
    // The server sorts by score, best first. Sent items read newest first.
    g.sent.sort((a, b) => (b.submission?.submittedAt ?? '').localeCompare(a.submission?.submittedAt ?? ''))
    g.sent = g.sent.slice(0, 15)
    return g
  })

  /** Every item in display order: what to decide, what is being prepared, what is ready to send, what needs attention, then in flight and sent. */
  const ordered = computed(() => [...groups.value.decide, ...groups.value.preparing, ...groups.value.send, ...groups.value.attention, ...groups.value.sending, ...groups.value.sent])

  function find(id: number | null | undefined) {
    return id == null ? null : items.value.find(x => x.applicationId === id) ?? null
  }

  async function fetchOne(id: number): Promise<ReviewItem | null> {
    try {
      const startedAt = Date.now()
      const item = await $fetch<ReviewItem>(`/api/review/${id}`)
      replace(item, startedAt)
      return find(id)
    }
    catch (e: any) {
      if (e?.statusCode === 404 || e?.response?.status === 404) remove(id)
      return null
    }
  }

  // ── Polling after approve ──
  const pollStarted = new Map<number, number>()
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  /** Being prepared after Apply, in flight after approve, or answered and waiting for the server to mark it ready. */
  function needsPolling(i: ReviewItem) {
    return PREPARING.includes(i.status) || IN_FLIGHT.includes(i.status) || (i.status === 'needs_input' && !i.openQuestions.some(q => q.blocking))
  }

  function schedulePoll() {
    if (import.meta.server) return
    if (pollTimer) clearTimeout(pollTimer)
    const inFlight = items.value.filter(needsPolling)
    if (inFlight.length === 0) {
      pollStarted.clear()
      pollTimer = null
      return
    }
    const now = Date.now()
    for (const i of inFlight) if (!pollStarted.has(i.applicationId)) pollStarted.set(i.applicationId, now)
    // Fast for the first minute after a decision, then slow down for anything stuck.
    const youngest = Math.max(...inFlight.map(i => pollStarted.get(i.applicationId) ?? now))
    const delay = now - youngest < 60_000 ? 1500 : 10_000
    pollTimer = setTimeout(async () => {
      await Promise.all(items.value.filter(needsPolling).map(i => fetchOne(i.applicationId)))
      for (const id of [...pollStarted.keys()]) {
        const item = find(id)
        if (!item || !needsPolling(item)) {
          pollStarted.delete(id)
          onSettled?.(item)
        }
      }
      schedulePoll()
    }, delay)
  }

  /** Called once when an in-flight application reaches a final state. */
  let onSettled: ((item: ReviewItem | null) => void) | null = null
  function whenSettled(cb: (item: ReviewItem | null) => void) {
    onSettled = cb
  }

  function stop() {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
  }

  // ── Decisions ──
  /** Stage 1: queue the preparation. The card moves to Preparing and is followed until it is ready to send. */
  async function apply(id: number): Promise<ReviewItem> {
    try {
      const startedAt = Date.now()
      const item = await $fetch<ReviewItem>(`/api/review/${id}/apply`, { method: 'POST' })
      replace(item, startedAt)
      pollStarted.set(id, Date.now())
      schedulePoll()
      return item
    }
    catch (e: any) {
      await fetchOne(id)
      throw new Error(errorMessage(e, 'Apply failed'))
    }
  }

  async function approve(id: number): Promise<ReviewItem> {
    try {
      const startedAt = Date.now()
      const item = await $fetch<ReviewItem>(`/api/review/${id}/approve`, { method: 'POST' })
      replace(item, startedAt)
      pollStarted.set(id, Date.now())
      schedulePoll()
      return item
    }
    catch (e: any) {
      // The item may have moved on the server (answered elsewhere, already approved). Re-read it.
      await fetchOne(id)
      throw new Error(errorMessage(e, 'Approve failed'))
    }
  }

  /** skills (Wrong tech stack only) names the skills at fault; skillsMode says whether Devin lacks them or avoids them. */
  async function reject(id: number, reasonCode: RejectReasonCode, reasonText: string | null, skills: string[] = [], skillsMode: RejectSkillsMode = 'lack'): Promise<void> {
    try {
      const body = skills.length ? { reasonCode, reasonText, skills, skillsMode } : { reasonCode, reasonText }
      await $fetch(`/api/review/${id}/reject`, { method: 'POST', body })
      remove(id)
    }
    catch (e: any) {
      throw new Error(errorMessage(e, 'Reject failed'))
    }
  }

  // ── Inline questions ──
  function setRefreshing(id: number, on: boolean) {
    const next = new Set(refreshing.value)
    if (on) next.add(id)
    else next.delete(id)
    refreshing.value = next
  }

  /**
   * Reads these cards again in one request. A card the queue no longer returns (its status left
   * the queue, or a rescore took a Decide card under the threshold) is read on its own, so the open
   * card stays and a removed one goes.
   */
  async function reread(ids: number[]) {
    const want = [...new Set(ids)]
    if (want.length === 0) return
    const startedAt = Date.now()
    const res = await $fetch<{ items: ReviewItem[] }>('/api/review/queue', { query: { status: QUEUE_STATUSES.join(','), ids: want.join(',') } })
    for (const item of res.items) replace(item, startedAt)
    const missing = want.filter(id => !res.items.some(i => i.applicationId === id))
    await Promise.all(missing.map(id => fetchOne(id)))
  }

  /**
   * Saves an answer (or a skip). The question leaves every card that shows it at once: askQuestion
   * dedupes by subject, so one question can sit on many cards. The save then re-derives every
   * application waiting on it before it returns (seconds when many share it), and the cards that
   * showed it are read again after that. It comes back only where the server still lists it after
   * the save, which means the field truly needs a different answer; that card says why. A failed
   * save puts it back where it was.
   */
  async function answerQuestion(applicationId: number, questionId: number, answer: string | null, skip = false): Promise<void> {
    const showedIt = items.value.flatMap((i) => {
      const at = i.openQuestions.findIndex(q => q.id === questionId)
      return at >= 0 ? [{ id: i.applicationId, at, question: i.openQuestions[at]! }] : []
    })
    answered.start(questionId)
    for (const s of showedIt) {
      const current = find(s.id)
      if (current) replace(current)
    }
    // A Send card keeps its Answer first block, with the progress line, while the server works.
    setRefreshing(applicationId, true)
    try {
      try {
        await $fetch(`/api/questions/${questionId}`, {
          method: 'PATCH',
          body: skip ? { status: 'skipped' } : { status: 'answered', answer },
        })
      }
      catch (e: any) {
        answered.fail(questionId)
        for (const s of showedIt) {
          const current = find(s.id)
          if (!current || current.openQuestions.some(q => q.id === questionId)) continue
          const openQuestions = [...current.openQuestions]
          openQuestions.splice(Math.min(s.at, openQuestions.length), 0, s.question)
          replace({ ...current, openQuestions })
        }
        throw new Error(errorMessage(e, 'Could not save the answer'))
      }
      answered.finish(questionId)
      try {
        await reread([applicationId, ...showedIt.map(s => s.id)])
      }
      catch {
        // The answer is saved; the cards catch up on the next read.
      }
    }
    finally {
      setRefreshing(applicationId, false)
      schedulePoll()
    }
  }

  /**
   * Something other than answerQuestion() changed this card (the skill panel saved an answer, or
   * a score changed): read it again, and when an answer settled a question, every other card that
   * shows that question too. The server finished with the question before it answered.
   */
  async function answeredElsewhere(applicationId: number, questionId?: number | null) {
    const showedIt = questionId ? items.value.filter(i => i.openQuestions.some(q => q.id === questionId)).map(i => i.applicationId) : []
    try {
      await reread([applicationId, ...showedIt])
    }
    catch {
      await fetchOne(applicationId)
    }
    schedulePoll()
  }

  /** Add or refresh one item from outside the queue fetch, and follow it if it is in flight. */
  function upsert(item: ReviewItem) {
    replace(item)
    loaded.value = true
    schedulePoll()
  }

  onBeforeUnmount(stop)

  return {
    items,
    loading,
    loaded,
    error,
    refreshing,
    groups,
    ordered,
    load,
    upsert,
    find,
    fetchOne,
    apply,
    approve,
    reject,
    answerQuestion,
    answeredElsewhere,
    whenSettled,
    stop,
  }
}
