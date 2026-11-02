// Contract for the chat panel on /questions (POST /api/questions/chat).
// The client sends only the question id and the conversation; the server builds every bit of
// context (question, job, posting, knowledge base) itself.

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
export type QuestionChatStop = 'budget' | 'credit' | 'key' | 'refused' | 'too_long' | 'unavailable'

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
    }
  | {
      ok: false
      stop: QuestionChatStop
      message: string
    }
