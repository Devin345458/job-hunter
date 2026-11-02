import type { QuestionListItem } from '#shared/types/learning'
import type { QuestionChatResponse, QuestionChatTurn } from '#shared/types/question-chat'

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
}

const THREADS_KEY = 'job-hunter:question-chat:threads:v1'
const SELECTED_KEY = 'job-hunter:question-chat:selected:v1'
const FREE_THREAD = 'free'

export function chatThreadKey(questionId: number | null | undefined): string {
  return questionId ? `q${questionId}` : FREE_THREAD
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** What Claude sees of an earlier reply: its text, plus the draft it gave, so "make it shorter" works. */
function toTurn(m: ChatMessage): QuestionChatTurn {
  if (m.role === 'assistant' && m.draft) return { role: 'assistant', content: `${m.content}\n\nDraft I gave you:\n${m.draft}` }
  return { role: m.role as QuestionChatTurn['role'], content: m.content }
}

export function useQuestionChat() {
  const threads = useState<Record<string, ChatMessage[]>>('question-chat-threads', () => ({}))
  const sending = useState<Record<string, boolean>>('question-chat-sending', () => ({}))
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
      if (res.ok) push(key, { id: newId(), role: 'assistant', content: res.reply, suggestedAnswer: res.suggestedAnswer, draft: res.draft })
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

  function clear(questionId: number | null) {
    const next = { ...threads.value }
    delete next[chatThreadKey(questionId)]
    threads.value = next
    persist()
  }

  return { threads, sending, restore, send, clear }
}

/** A yes or no question about a skill or past work: Yes and Some experience open the example box. */
export function takesExample(q: { answerType: string | null, kind?: string | null } | null | undefined): boolean {
  return !!q && q.answerType === 'yes_no' && (q.kind === 'knows' || q.kind === 'has_done')
}

/** The answers that open the example box ("Where did you do it?") on a question that takes one. */
export const EXAMPLE_LEVELS = ['Yes', 'Some experience'] as const

/** Longest example the server accepts (EXAMPLE_MAX_CHARS in server/utils/questions.ts). */
export const EXAMPLE_MAX_CHARS = 1000

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
