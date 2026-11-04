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

/**
 * The step line under a records draft's spinner, "Searching your GitHub (12 seconds)", ticking each
 * second while the thread's draft runs; null when none runs.
 */
export function useDraftStepLine(key: Ref<string>) {
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
    return `${st?.label ?? 'Starting the draft'} (${secs} ${secs === 1 ? 'second' : 'seconds'})`
  })
}

export function useQuestionChat() {
  const threads = useState<Record<string, ChatMessage[]>>('question-chat-threads', () => ({}))
  const sending = useState<Record<string, boolean>>('question-chat-sending', () => ({}))
  /** Threads waiting on a draft from records (a longer wait than a reply: it searches first). */
  const drafting = useState<Record<string, boolean>>('question-chat-drafting', () => ({}))
  /** The step a draft from records is on ("Searching your GitHub"), and when it started, per thread. */
  const draftStep = useState<Record<string, { label: string | null; startedAt: string | null }>>('question-chat-draft-step', () => ({}))
  const restored = useState('question-chat-restored', () => false)

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
    const readStatus = () => $fetch<RecordsDraftStatus>(`/api/questions/${questionId}/draft`).catch(() => null)
    const showStatus = (st: RecordsDraftStatus | null) => {
      if (polling && st?.running) draftStep.value = { ...draftStep.value, [key]: { label: st.label, startedAt: st.startedAt } }
    }
    const timer = setInterval(() => readStatus().then(showStatus), 2000)
    /** A draft the request handed off (still running at its wait, or the request was cut off): wait for it here. */
    const collect = async (): Promise<RecordsDraftResponse | null> => {
      // This loop reads the status itself from here on.
      clearInterval(timer)
      for (let misses = 0; misses < 3;) {
        await new Promise(r => setTimeout(r, 2000))
        const st = await readStatus()
        if (st?.result) return st.result
        if (st?.running) {
          showStatus(st)
          continue
        }
        misses++
      }
      return null
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
      sending.value = { ...sending.value, [key]: false }
      drafting.value = { ...drafting.value, [key]: false }
      const next = { ...draftStep.value }
      delete next[key]
      draftStep.value = next
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

  return { threads, sending, drafting, draftStep, restore, send, draftFromRecords, markDraftUsed, clear }
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
