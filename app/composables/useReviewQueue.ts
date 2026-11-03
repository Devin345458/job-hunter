import type { ApplicationStatus, RejectReasonCode, RejectSkillsMode, ReviewItem } from '#shared/types/pipeline'
import { IN_FLIGHT, PREPARING, statusMeta } from './review/format'

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

  function replace(item: ReviewItem) {
    const i = items.value.findIndex(x => x.applicationId === item.applicationId)
    if (i >= 0) items.value.splice(i, 1, item)
    else items.value.push(item)
  }

  function remove(id: number) {
    items.value = items.value.filter(x => x.applicationId !== id)
  }

  async function load() {
    loading.value = true
    try {
      const res = await $fetch<{ items: ReviewItem[] }>('/api/review/queue', { query: { status: QUEUE_STATUSES.join(',') } })
      items.value = res.items
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
      const item = await $fetch<ReviewItem>(`/api/review/${id}`)
      replace(item)
      return item
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
      const item = await $fetch<ReviewItem>(`/api/review/${id}/apply`, { method: 'POST' })
      replace(item)
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
      const item = await $fetch<ReviewItem>(`/api/review/${id}/approve`, { method: 'POST' })
      replace(item)
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
  async function answerQuestion(applicationId: number, questionId: number, answer: string | null, skip = false): Promise<void> {
    try {
      await $fetch(`/api/questions/${questionId}`, {
        method: 'PATCH',
        body: skip ? { status: 'skipped' } : { status: 'answered', answer },
      })
    }
    catch (e: any) {
      throw new Error(errorMessage(e, 'Could not save the answer'))
    }
    // Drop the question locally at once, then re-read the application while the server
    // re-derives the form answers (and moves needs_input to proposed once nothing blocks).
    const current = find(applicationId)
    if (current) replace({ ...current, openQuestions: current.openQuestions.filter(q => q.id !== questionId) })
    const next = new Set(refreshing.value)
    next.add(applicationId)
    refreshing.value = next
    try {
      for (const wait of [400, 1200, 2500, 4000]) {
        await new Promise(r => setTimeout(r, wait))
        const item = await fetchOne(applicationId)
        if (!item) break
        const stillWaiting = item.status === 'needs_input' && !item.openQuestions.some(q => q.blocking)
        if (!stillWaiting) break
      }
    }
    finally {
      const after = new Set(refreshing.value)
      after.delete(applicationId)
      refreshing.value = after
      schedulePoll()
    }
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
    whenSettled,
    stop,
  }
}
