import type { QuestionListItem } from '#shared/types/learning'
import type { QuestionChatResponse, QuestionChatTurn, RecordsDraft, RecordsDraftPending, RecordsDraftResponse, RecordsDraftStatus } from '#shared/types/question-chat'
import type { ChatMemoryUse } from '#shared/types/memory'
import type { GithubChatSearch } from '#shared/types/repos'

// Conversations for the chat panel on /questions, one per question plus one for free questions.
// They live in this browser tab only (sessionStorage), so switching questions keeps each thread;
// nothing is stored on the server.

/**
 * What the chat panel needs to know about a question. A /questions list item fits as is; the
 * review card builds one from its QuestionView.
 */
export interface ChatQuestion {
  id: number
  question: string
  status: string
  answer: string | null
  answerType: QuestionListItem['answerType']
  choices: string[] | null
  /** knows and has_done yes or no questions take an example with Yes or Some experience; the chat drafts that example. */
  kind?: string | null
  /** From the original tailoring flow: no kind and no answer type, answered in the long editor. */
  legacy: boolean
  job?: { title: string; company: string } | null
  waitingApplications?: Array<{ company: string; title: string }>
}

export interface ChatMessage {
  id: string
  /** 'notice' is a stop or error line from the app, never sent back to Claude. */
  role: 'user' | 'assistant' | 'notice'
  content: string
  suggestedAnswer?: string | null
  draft?: string | null
  /** How the reply used Devin's past Claude sessions. */
  memory?: ChatMemoryUse
  /** memory_unreachable: the once-per-conversation line saying his laptop's memory is not reachable. */
  kind?: 'memory_unreachable'
  /** What the reply's GitHub search found, listed under it as "Found in your GitHub". */
  github?: GithubChatSearch | null
  /** A draft from Devin's records ("Draft from my records"): every sentence with the records it rests on. */
  records?: RecordsDraft | null
  /** Devin pressed "Use this draft" on it. */
  used?: boolean
}

/** What "Use this draft" hands the card along with the text and level: the records behind a draft from his records. */
export interface DraftMeta {
  records?: RecordsDraft | null
  /** Why memory was left out, when it was ("Your laptop's memory is not reachable right now, so..."). */
  memoryNote?: string | null
}

/** The label on a box filled from his records. */
export const RECORDS_DRAFT_LABEL = 'Draft from your records; edit before saving'
/** A draft whose records showed nothing about the subject: only the nearest work, no answer picked. */
export const NEAREST_WORK_LABEL = 'Nothing about this was found in your records. Nearest work only; pick your own answer'

/** The label over a records draft in a box or the chat. */
export function recordsDraftLabel(d: RecordsDraft | null | undefined): string {
  return d?.adjacentOnly ? NEAREST_WORK_LABEL : RECORDS_DRAFT_LABEL
}

/**
 * A question the records draft can write for: a skill or experience question's example, or a
 * written answer (recordsDraftBox() in server/utils/draft-from-records.ts decides the same).
 */
export function draftsFromRecords(q: ChatQuestion | null | undefined): boolean {
  if (!q || q.status === 'skipped') return false
  if (takesExample(q)) return !(q.status === 'answered' && (q.answer ?? '').trim().toLowerCase() === 'no')
  if (q.legacy) return true
  return q.answerType === 'text' && (q.kind === 'knows' || q.kind === 'has_done' || q.kind === 'other')
}

/** Typed asks that mean "draft it from my records" rather than a question about the draft. */
const RECORDS_ASK = /\b(from|use|using|with|in) my (records|history|memory|past sessions|sessions|github|commits)\b|\byou should be able to (answer|write|draft)\b|\b(draft|write) (it|this|one|the example|an answer|my answer)( for me)?\b|\bhelp me (answer|write)\b/i
/** Asks to change a draft already given, which the regular chat handles. */
const REVISION_ASK = /\b(shorter|longer|shorten|change|remove|drop|rephrase|reword|instead|tweak|fix|less|more formal|casual|add)\b/i

export function asksForRecordsDraft(text: string): boolean {
  return RECORDS_ASK.test(text) && !REVISION_ASK.test(text)
}

/** Said once per conversation when the memory server cannot be reached; the chat carries on without it. */
export const MEMORY_UNREACHABLE = 'Your laptop\'s memory is not reachable right now.'
/** Said instead when it timed out: the shared daemon is busy or the laptop is asleep, which is not an error. */
export const MEMORY_BUSY = 'Your laptop\'s memory server is busy or asleep, so this reply has no new leads from it.'

const THREADS_KEY = 'job-hunter:question-chat:threads:v1'
const SELECTED_KEY = 'job-hunter:question-chat:selected:v1'
const FREE_THREAD = 'free'

export function chatThreadKey(questionId: number | null | undefined): string {
  return questionId ? `q${questionId}` : FREE_THREAD
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** One line per finding, so a later turn knows what an earlier search showed ("the second one"). */
function githubNote(g: GithubChatSearch): string {
  if (!g.findings.length) return 'GitHub search: nothing found.'
  return `GitHub search found:\n${g.findings.slice(0, 12).map((f, i) => `${i + 1}. ${f.kind} in ${f.repo}: ${f.title}${f.date ? ` (${f.date})` : ''}`).join('\n')}`
}

/**
 * What Claude sees of an earlier reply: its text, plus the draft it gave (so "make it shorter"
 * works) and what its GitHub search found (so "the herp-shipper one" does).
 */
function toTurn(m: ChatMessage): QuestionChatTurn {
  if (m.role !== 'assistant') return { role: m.role as QuestionChatTurn['role'], content: m.content }
  const parts = [m.content]
  if (m.github) parts.push(githubNote(m.github))
  if (m.records) parts.push(`Draft from your records I gave you:\n${m.records.text}`)
  else if (m.draft) parts.push(`Draft I gave you:\n${m.draft}`)
  return { role: 'assistant', content: parts.join('\n\n') }
}

/** The step a thread's records draft is on and its seconds so far, ticking each second; null when none runs. */
function useDraftClock(key: Ref<string>) {
  const chat = useQuestionChat()
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | null = null
  const active = computed(() => !!chat.drafting.value[key.value])
  watch(active, (on) => {
    now.value = Date.now()
    if (on && !timer && import.meta.client) timer = setInterval(() => (now.value = Date.now()), 1000)
    if (!on && timer) {
      clearInterval(timer)
      timer = null
    }
  }, { immediate: true })
  onBeforeUnmount(() => {
    if (timer) clearInterval(timer)
  })
  return computed(() => {
    if (!active.value) return null
    const st = chat.draftStep.value[key.value]
    const secs = st?.startedAt ? Math.max(0, Math.round((now.value - Date.parse(st.startedAt)) / 1000)) : 0
    return { label: st?.label ?? null, secs, seconds: `${secs} ${secs === 1 ? 'second' : 'seconds'}` }
  })
}

/**
 * The step line under a records draft's spinner, "Searching your GitHub (12 seconds)", ticking each
 * second while the thread's draft runs; null when none runs.
 */
export function useDraftStepLine(key: Ref<string>) {
  const clock = useDraftClock(key)
  return computed(() => clock.value && `${clock.value.label ?? 'Starting the draft'} (${clock.value.seconds})`)
}

/** The line inside an example box while its draft runs: "Drafting from your records: Searching your GitHub, 12 seconds". */
export function useDraftingLine(key: Ref<string>) {
  const clock = useDraftClock(key)
  return computed(() => clock.value && `Drafting from your records: ${clock.value.label ?? 'Starting'}, ${clock.value.seconds}`)
}

/**
 * A draft from his records that started by itself when Devin picked Yes or Some experience on an
 * empty example box. It lives app-wide (and in sessionStorage), so a card that mounts later, after
 * a page change or a reload, shows the same answer picked and fills its box when the draft is done.
 */
export interface AutoDraftRun {
  /** The answer he picked when it started. */
  level: string
  /**
   * The card that started it (useAutoDraftHost). While that card is on screen only it takes the
   * draft: the same question can show twice at once (a review card's Skills to confirm under the
   * skill panel opened from it).
   */
  host?: string | null
  /** When it started (ms since the epoch). */
  startedAt: number
  /** The finished response, once it came back. */
  result: RecordsDraftResponse | null
  /** A card used it, offered it, showed its message, or dropped it (No, a save, Dismiss): it never fills a box again. */
  settled: boolean
}

/** What a finished automatic draft does on its card. */
export type AutoDraftOutcome =
  | { kind: 'fill'; draft: RecordsDraft; note: string | null }
  /** He typed in the box while it ran: "A draft from your records is ready", Use it or Dismiss. */
  | { kind: 'offer'; draft: RecordsDraft; note: string | null }
  /** No draft (nothing found, or why it could not draft): the line under the box, the box stays as it is. */
  | { kind: 'message'; text: string }

/**
 * The outcome of an automatic draft on a box holding `boxText`. Nothing about the subject found
 * (no draft, or only the nearest work) leaves the box empty and shows the nothing-found line; the
 * "Draft from my records" button still fills the nearest work as before.
 */
export function autoDraftOutcome(res: RecordsDraftResponse, boxText: string): AutoDraftOutcome {
  if (!res.ok) return { kind: 'message', text: res.message }
  if (!res.draft || res.draft.adjacentOnly) return { kind: 'message', text: [res.memoryNote, res.reply].filter(Boolean).join(' ') }
  const typed = boxText.trim()
  if (typed && typed !== res.draft.text.trim()) return { kind: 'offer', draft: res.draft, note: res.memoryNote }
  return { kind: 'fill', draft: res.draft, note: res.memoryNote }
}

const AUTO_KEY = 'job-hunter:question-chat:auto-drafts:v1'
/** A finished automatic draft waits this long for its card to show it. */
const AUTO_KEEP_MS = 2 * 60 * 60 * 1000
/** Past this, a draft that had not come back before a reload is gone from the server (it keeps a result 5 minutes). */
const AUTO_REJOIN_MS = 10 * 60 * 1000

/** The status GET for a question's records draft; null when the server could not be read. */
function readRecordsStatus(questionId: number) {
  return $fetch<RecordsDraftStatus>(`/api/questions/${questionId}/draft`).catch(() => null)
}

/**
 * Waits for a records draft the server is still running (the POST handed it off, the request was
 * cut off, or the page reloaded), reading its status every two seconds. Null once the server has
 * no run for it three reads in a row.
 */
async function pollRecordsDraft(questionId: number, onStatus: (st: RecordsDraftStatus) => void): Promise<RecordsDraftResponse | null> {
  for (let misses = 0; misses < 3;) {
    await new Promise(r => setTimeout(r, 2000))
    const st = await readRecordsStatus(questionId)
    if (st?.result) return st.result
    if (st?.running) {
      onStatus(st)
      continue
    }
    misses++
  }
  return null
}

export function useQuestionChat() {
  const threads = useState<Record<string, ChatMessage[]>>('question-chat-threads', () => ({}))
  const sending = useState<Record<string, boolean>>('question-chat-sending', () => ({}))
  /** Threads waiting on a draft from records (a longer wait than a reply: it searches first). */
  const drafting = useState<Record<string, boolean>>('question-chat-drafting', () => ({}))
  /** The step a draft from records is on ("Searching your GitHub"), and when it started, per thread. */
  const draftStep = useState<Record<string, { label: string | null; startedAt: string | null }>>('question-chat-draft-step', () => ({}))
  const restored = useState('question-chat-restored', () => false)
  /** Automatic drafts by question id (AutoDraftRun). */
  const autoDrafts = useState<Record<number, AutoDraftRun>>('question-chat-auto-drafts', () => ({}))
  const autoRestored = useState('question-chat-auto-restored', () => false)
  /** Cards on screen now that can take an automatic draft (useAutoDraftHost), by host id. */
  const liveHosts = useState<Record<string, boolean>>('question-chat-auto-hosts', () => ({}))

  function persist() {
    try {
      sessionStorage.setItem(THREADS_KEY, JSON.stringify(threads.value))
    }
    catch {
      // Private mode or full storage: the conversation still works for this page view.
    }
  }

  /** Reads saved conversations once, on the client. */
  function restore() {
    if (restored.value || !import.meta.client) return
    restored.value = true
    try {
      const saved = JSON.parse(sessionStorage.getItem(THREADS_KEY) || 'null')
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) threads.value = { ...saved, ...threads.value }
    }
    catch {
      // Unreadable storage starts the chat empty.
    }
  }

  function push(key: string, message: ChatMessage) {
    // A draft can start before the chat panel ever mounts (a card's own draft): read the saved
    // conversations first, so this write never drops them.
    restore()
    threads.value = { ...threads.value, [key]: [...(threads.value[key] ?? []), message] }
    persist()
  }

  async function send(questionId: number | null, text: string) {
    const key = chatThreadKey(questionId)
    const content = text.trim()
    if (!content || sending.value[key]) return
    push(key, { id: newId(), role: 'user', content })
    sending.value = { ...sending.value, [key]: true }
    try {
      const messages = (threads.value[key] ?? []).filter(m => m.role !== 'notice').map(toTurn)
      const res = await $fetch<QuestionChatResponse>('/api/questions/chat', {
        method: 'POST',
        body: { questionId, messages },
      })
      if (res.ok) {
        if ((res.memory === 'unreachable' || res.memory === 'busy') && !(threads.value[key] ?? []).some(m => m.kind === 'memory_unreachable')) {
          push(key, { id: newId(), role: 'notice', kind: 'memory_unreachable', content: res.memory === 'busy' ? MEMORY_BUSY : MEMORY_UNREACHABLE })
        }
        push(key, { id: newId(), role: 'assistant', content: res.reply, suggestedAnswer: res.suggestedAnswer, draft: res.draft, memory: res.memory ?? null, github: res.github ?? null })
      }
      else push(key, { id: newId(), role: 'notice', content: res.message })
    }
    catch (e: any) {
      push(key, {
        id: newId(),
        role: 'notice',
        content: e?.data?.statusMessage || 'Could not reach the chat. Check your connection and try again.',
      })
    }
    finally {
      sending.value = { ...sending.value, [key]: false }
    }
  }

  /**
   * "Draft from my records": the server drafts from his knowledge base, his GitHub, his past Claude
   * sessions, and what he typed here. The thread shows the ask and the draft with its sources; the
   * response comes back so a card can fill its box directly. `typed` is a message he typed that
   * asked for it, shown as his turn and counted as something he said.
   */
  async function draftFromRecords(questionId: number, typed?: string): Promise<RecordsDraftResponse | null> {
    const key = chatThreadKey(questionId)
    if (sending.value[key]) return null
    const ask = typed?.trim() || 'Draft from my records'
    push(key, { id: newId(), role: 'user', content: ask })
    sending.value = { ...sending.value, [key]: true }
    drafting.value = { ...drafting.value, [key]: true }
    draftStep.value = { ...draftStep.value, [key]: { label: null, startedAt: new Date().toISOString() } }
    // The step line: the server says which step the draft is on (GET .../draft) every two seconds.
    let polling = true
    const showStatus = (st: RecordsDraftStatus | null) => {
      if (polling && st?.running) draftStep.value = { ...draftStep.value, [key]: { label: st.label, startedAt: st.startedAt } }
    }
    const timer = setInterval(() => readRecordsStatus(questionId).then(showStatus), 2000)
    /** A draft the request handed off (still running at its wait, or the request was cut off): wait for it here. */
    const collect = (): Promise<RecordsDraftResponse | null> => {
      // This loop reads the status itself from here on.
      clearInterval(timer)
      return pollRecordsDraft(questionId, showStatus)
    }
    try {
      // Only what he typed counts as "you said", never the button's own words.
      const said = (threads.value[key] ?? []).filter(m => m.role === 'user' && m.content !== 'Draft from my records').map(m => m.content)
      let res: RecordsDraftResponse | null
      try {
        const first = await $fetch<RecordsDraftResponse | RecordsDraftPending>(`/api/questions/${questionId}/draft`, { method: 'POST', body: { said } })
        res = 'pending' in first ? await collect() : first
      }
      catch (e: any) {
        // A request cut off at the proxy (a 502, 504, or 524) while the draft runs on: collect it.
        if (e?.statusCode && e.statusCode < 500) throw e
        res = await collect()
        if (!res) throw e
      }
      if (!res) throw new Error('The draft stopped before it finished.')
      pushRecordsResult(key, res)
      return res
    }
    catch (e: any) {
      const message = e?.data?.statusMessage || 'Could not reach the server to draft from your records. Check your connection and try again.'
      push(key, { id: newId(), role: 'notice', content: message })
      return { ok: false, stop: 'unavailable', message }
    }
    finally {
      polling = false
      clearInterval(timer)
      endDrafting(key)
    }
  }

  /** The finished draft in the thread: the memory line, then the draft with its sources, or why there is none. */
  function pushRecordsResult(key: string, res: RecordsDraftResponse) {
    if (res.ok) {
      if (res.memoryNote) push(key, { id: newId(), role: 'notice', content: res.memoryNote })
      push(key, {
        id: newId(),
        role: 'assistant',
        content: res.reply,
        draft: res.draft?.text ?? null,
        suggestedAnswer: res.draft?.level ?? null,
        records: res.draft,
        memory: null,
      })
    }
    else push(key, { id: newId(), role: 'notice', content: res.message })
  }

  function endDrafting(key: string) {
    sending.value = { ...sending.value, [key]: false }
    drafting.value = { ...drafting.value, [key]: false }
    const next = { ...draftStep.value }
    delete next[key]
    draftStep.value = next
  }

  /**
   * After a reload: waits for the records draft the server is still running for this question (or
   * takes the one it finished in the last few minutes), with the same step line as a fresh one.
   * Null when the server has none (it restarted, or the result is older than its five minutes).
   */
  async function joinRecordsDraft(questionId: number): Promise<RecordsDraftResponse | null> {
    const key = chatThreadKey(questionId)
    if (sending.value[key]) return null
    const first = await readRecordsStatus(questionId)
    if (!first || (!first.running && !first.result) || sending.value[key]) return null
    sending.value = { ...sending.value, [key]: true }
    drafting.value = { ...drafting.value, [key]: true }
    draftStep.value = { ...draftStep.value, [key]: { label: first.label, startedAt: first.startedAt } }
    try {
      const res = first.result ?? await pollRecordsDraft(questionId, (st) => {
        draftStep.value = { ...draftStep.value, [key]: { label: st.label, startedAt: st.startedAt } }
      })
      if (res) pushRecordsResult(key, res)
      return res
    }
    finally {
      endDrafting(key)
    }
  }

  // ── Automatic drafts (Yes or Some experience on an empty example box) ──
  function persistAuto() {
    try {
      sessionStorage.setItem(AUTO_KEY, JSON.stringify(autoDrafts.value))
    }
    catch {
      // Private mode or full storage: the draft still fills the box on this page view.
    }
  }

  function setAuto(questionId: number, run: AutoDraftRun | null) {
    const next = { ...autoDrafts.value }
    if (run) next[questionId] = run
    else delete next[questionId]
    autoDrafts.value = next
    persistAuto()
  }

  /**
   * Picking Yes or Some experience on an empty example box drafts from his records with no further
   * click. Once per question in this tab: after that the "Draft from my records" button gives a
   * fresh draft. False when nothing started (one already ran here, or one or a chat reply for this
   * question is under way).
   */
  function startAutoDraft(questionId: number, level: string, host: string | null = null): boolean {
    const key = chatThreadKey(questionId)
    if (!import.meta.client || sending.value[key] || drafting.value[key] || autoDrafts.value[questionId]) return false
    setAuto(questionId, { level, host, startedAt: Date.now(), result: null, settled: false })
    draftFromRecords(questionId).then((res) => {
      const run = autoDrafts.value[questionId]
      if (!run) return
      setAuto(questionId, res ? { ...run, result: res } : null)
    })
    return true
  }

  /**
   * The card is done with this question's automatic draft: it filled the box, offered it, showed
   * its message, or the draft no longer applies (No, a save, Dismiss). A failed one is forgotten,
   * so picking Yes again tries again.
   */
  function settleAutoDraft(questionId: number) {
    const run = autoDrafts.value[questionId]
    if (!run || run.settled) return
    setAuto(questionId, run.result && !run.result.ok ? null : { ...run, settled: true })
  }

  /** Reads the automatic drafts saved in this tab once, and rejoins any the page reloaded in the middle of. */
  function restoreAutoDrafts() {
    if (autoRestored.value || !import.meta.client) return
    autoRestored.value = true
    let saved: Record<string, AutoDraftRun> = {}
    try {
      const parsed = JSON.parse(sessionStorage.getItem(AUTO_KEY) || 'null')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed
    }
    catch {
      // Unreadable storage: nothing to rejoin.
    }
    const now = Date.now()
    const next = { ...autoDrafts.value }
    for (const [k, run] of Object.entries(saved)) {
      const id = Number(k)
      if (!Number.isInteger(id) || id <= 0 || next[id] || !run || typeof run.startedAt !== 'number' || typeof run.level !== 'string') continue
      if (now - run.startedAt > AUTO_KEEP_MS) continue
      if (!run.result && !run.settled && now - run.startedAt > AUTO_REJOIN_MS) continue
      next[id] = run
    }
    autoDrafts.value = next
    persistAuto()
    for (const [k, run] of Object.entries(next)) {
      const id = Number(k)
      if (run.result || run.settled || drafting.value[chatThreadKey(id)]) continue
      joinRecordsDraft(id).then((res) => {
        const cur = autoDrafts.value[id]
        if (!cur) return
        // Gone from the server: nothing to wait for.
        setAuto(id, res ? { ...cur, result: res } : null)
      })
    }
  }

  /** "Use this draft" was pressed on this message: the chat offers a new draft from his records again. */
  function markDraftUsed(questionId: number | null, messageId: string) {
    const key = chatThreadKey(questionId)
    const thread = threads.value[key] ?? []
    if (!thread.some(m => m.id === messageId && !m.used)) return
    threads.value = { ...threads.value, [key]: thread.map(m => m.id === messageId ? { ...m, used: true } : m) }
    persist()
  }

  function clear(questionId: number | null) {
    const next = { ...threads.value }
    delete next[chatThreadKey(questionId)]
    threads.value = next
    persist()
  }

  return { threads, sending, drafting, draftStep, autoDrafts, liveHosts, restore, send, draftFromRecords, joinRecordsDraft, startAutoDraft, settleAutoDraft, restoreAutoDrafts, markDraftUsed, clear }
}

/** How a card answers the automatic draft watcher for one question. */
export interface AutoDraftBox {
  /** The example box is open on a picked Yes or Some experience and nothing is saving: a finished draft can land. */
  applies: () => boolean
  /** What the box holds now. */
  text: () => string
  /** Nothing picked, the box closed, the question still waiting: the card can show the answer picked again. */
  canRestore: () => boolean
  /** Picks the level and opens the box, on a card that mounted after its draft started. */
  restore: (level: string) => void
  /** Puts the finished draft in the box, offers it, or shows the line under the box. */
  land: (outcome: AutoDraftOutcome) => void
}

/**
 * One pass of the automatic draft watcher for a card's question. A draft started on another card
 * that is still on screen is that card's; this one leaves it alone.
 */
export function checkAutoDraft(chat: ReturnType<typeof useQuestionChat>, questionId: number, box: AutoDraftBox, host: string) {
  const run = chat.autoDrafts.value[questionId]
  if (!run || run.settled) return
  if (run.host && run.host !== host && chat.liveHosts.value[run.host]) return
  if (!run.result && !chat.drafting.value[chatThreadKey(questionId)]) return
  if (box.canRestore()) box.restore(run.level)
  if (!run.result || !box.applies()) return
  box.land(autoDraftOutcome(run.result, box.text()))
  chat.settleAutoDraft(questionId)
}

let hostSeq = 0

/**
 * This card's id for automatic drafts, counted as on screen while it is mounted and `active` holds
 * (a dialog only while it is open). It also reads the drafts saved in this tab once.
 */
export function useAutoDraftHost(active: () => boolean = () => true): string {
  const chat = useQuestionChat()
  const host = `h${++hostSeq}${Math.random().toString(36).slice(2, 6)}`
  const set = (on: boolean) => {
    const next = { ...chat.liveHosts.value }
    if (on) next[host] = true
    else delete next[host]
    chat.liveHosts.value = next
  }
  onMounted(() => {
    chat.restoreAutoDrafts()
    watch(active, on => set(on), { immediate: true })
  })
  onBeforeUnmount(() => set(false))
  return host
}

/**
 * A card with one question: fills its example box when the automatic draft for it finishes, and
 * shows the answer picked again when it mounts while that draft runs or after it finished.
 */
export function useAutoDraft(questionId: () => number | null | undefined, box: AutoDraftBox, active?: () => boolean) {
  const chat = useQuestionChat()
  const host = useAutoDraftHost(active)
  watch(() => {
    const id = questionId()
    const run = id ? chat.autoDrafts.value[id] : null
    return id ? [id, run, !!chat.drafting.value[chatThreadKey(id)], !!(run?.host && chat.liveHosts.value[run.host]), box.applies(), box.canRestore()] : null
  }, () => {
    const id = questionId()
    if (id) checkAutoDraft(chat, id, box, host)
  }, { immediate: true })
  return { chat, host }
}

/** A yes or no question about a skill or past work: Yes and Some experience open the example box. */
export function takesExample(q: { answerType: string | null, kind?: string | null } | null | undefined): boolean {
  return !!q && q.answerType === 'yes_no' && (q.kind === 'knows' || q.kind === 'has_done')
}

/** The answers that open the example box ("Where did you do it?") on a question that takes one. */
export const EXAMPLE_LEVELS = ['Yes', 'Some experience'] as const


/** The question the chat was last about, so a reload in the same tab reopens it. */
export function savedChatQuestionId(): number | null {
  try {
    const id = Number(sessionStorage.getItem(SELECTED_KEY))
    return Number.isInteger(id) && id > 0 ? id : null
  }
  catch {
    return null
  }
}

export function saveChatQuestionId(id: number | null) {
  try {
    if (id) sessionStorage.setItem(SELECTED_KEY, String(id))
    else sessionStorage.removeItem(SELECTED_KEY)
  }
  catch {
    // Not saved; the selection still works until the page reloads.
  }
}
