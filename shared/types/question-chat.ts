// Contract for the chat panel on /questions (POST /api/questions/chat).
// The client sends only the question id and the conversation; the server builds every bit of
// context (question, job, posting, knowledge base) itself.

import type { ChatMemoryUse } from './memory'
import type { GithubChatSearch } from './repos'

export type QuestionChatRole = 'user' | 'assistant'

export interface QuestionChatTurn {
  role: QuestionChatRole
  content: string
}

export interface QuestionChatRequest {
  /** The question the chat is about. Absent for a free question with no card selected. */
  questionId?: number | null
  /** The conversation so far, oldest first. The last turn is Devin's new message. */
  messages: QuestionChatTurn[]
}

/** Why the chat could not answer. Each comes with one plain sentence for the panel. */
export type QuestionChatStop = 'budget' | 'credit' | 'key' | 'subscription' | 'token' | 'refused' | 'too_long' | 'unavailable'

export type QuestionChatResponse =
  | {
      ok: true
      reply: string
      /**
       * One of the answer buttons on the question card ("Yes", "Some experience", "No"), set only
       * when Devin's own messages make the answer clear. The panel shows it as a button; nothing is
       * saved until he taps it.
       */
      suggestedAnswer: string | null
      /**
       * A draft for a free-text question, built only from the knowledge base and what Devin said in
       * the chat. "Use this draft" puts it in the card's answer box; it is never saved on its own.
       */
      draft: string | null
      /**
       * How the reply used Devin's past Claude sessions (shared/types/memory.ts). 'unreachable'
       * makes the panel say once per conversation that his laptop's memory is not reachable.
       */
      memory?: ChatMemoryUse
      /**
       * Set when this reply searched Devin's GitHub (he asked, or Claude called the search on a
       * skill or experience question). The panel lists the findings under the reply with links,
       * or says where it looked when nothing was found.
       */
      github?: GithubChatSearch | null
    }
  | {
      ok: false
      stop: QuestionChatStop
      message: string
    }

// ── Draft from my records (POST /api/questions/:id/draft) ───
// The server gathers Devin's records live (knowledge base, his own GitHub commits, his past Claude
// sessions through the memory server) and writes a first-person draft in which every sentence
// cites the record it rests on. A sentence with no record behind it is never written. The draft
// only fills the card's box; nothing is saved until Devin presses Save.

export interface RecordsDraftRequest {
  /** Devin's own messages in the chat about this question, oldest first. They count as a source ("you said"). */
  said?: string[]
}

export type RecordSourceKind = 'knowledge' | 'commit' | 'memory' | 'said'

/** One record a sentence rests on, as the panel and the card list it under the draft. */
export interface RecordSource {
  kind: RecordSourceKind
  /** "Knowledge base: skill/Sentry", "dev-applied/appcando commit", "Claude session", "You said". */
  label: string
  /** The commit title, the session project, or the start of what he said. */
  detail: string | null
  /** YYYY-MM-DD for a commit or a session. */
  date: string | null
  /** The commit on GitHub. Null for the other kinds. */
  url: string | null
}

export interface RecordsDraftSentence {
  text: string
  sources: RecordSource[]
}

/** How the draft used Devin's past Claude sessions. */
export type RecordsMemoryUse = 'used' | 'none' | 'unreachable' | 'busy' | 'off'

export interface RecordsDraft {
  /** The sentences joined, ready for the answer box or the example box. */
  text: string
  /** Yes when the records show the work, Some experience when they show only part of it. Null on a written answer. */
  level: 'Yes' | 'Some experience' | null
  sentences: RecordsDraftSentence[]
  /** Where the draft goes on the card. */
  box: 'example' | 'answer'
}

export type RecordsDraftResponse =
  | {
      ok: true
      /** Null when the records hold nothing that answers the question; `reply` says so. */
      draft: RecordsDraft | null
      /** One or two plain sentences for the panel: what the draft draws on, or why there is none. */
      reply: string
      memory: RecordsMemoryUse
      /** One line when memory could not be searched ("Your laptop's memory is not reachable right now, so..."). */
      memoryNote: string | null
      /** What was searched, in counts, for the panel's small print. */
      searched: { knowledge: number; commits: number; sessions: number }
    }
  | {
      ok: false
      stop: QuestionChatStop
      message: string
    }
