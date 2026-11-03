// Devin's claude-self-reflect memory (his past Claude Code sessions, searchable over MCP) as a
// source of leads for questions. A lead is never evidence: it shows what was discussed,
// researched, planned, or recorded in a meeting, often in Claude's words. Nothing from memory
// becomes an answer, a knowledge entry, or application text unless Devin types it himself.

/** One lead as the question card shows it. */
export interface MemoryLead {
  /** Day of the session (YYYY-MM-DD), or null when the memory server gave none. */
  date: string | null
  /** Short project name from the session's folder, for example "visilaunch". */
  project: string
  /** One plain line quoted from the excerpt, with no dashes. */
  line: string
}

/** A lead as stored on the question row: the card line plus the excerpt the chat sends to Claude. */
export interface StoredMemoryLead extends MemoryLead {
  /** Up to about 1,200 characters of the session. Sent only to Claude in the question chat. */
  excerpt: string
  score: number
}

/** questions.memory_leads_json, written by the memory:leads task. */
export interface QuestionMemoryLeads {
  /** When the task last searched memory for this question (ISO time). */
  checkedAt: string
  /** Up to 3, best first. Empty when the search found nothing worth showing. */
  leads: StoredMemoryLead[]
}

/** GET /api/memory/leads: the leads of every pending question that has some, without excerpts. */
export interface MemoryLeadsResponse {
  byQuestion: Record<number, { checkedAt: string; leads: MemoryLead[] }>
}

/**
 * off: NUXT_MEMORY_MCP_URL is empty. reachable or unreachable: what the last check found.
 * busy: the last check timed out, so the laptop's memory server is busy or asleep (not an error).
 */
export type MemoryState = 'off' | 'reachable' | 'busy' | 'unreachable' | 'unknown'

/** GET /api/memory/status (and POST to check now). */
export interface MemoryStatus {
  state: MemoryState
  /** When the state was last checked (ISO time), from this server process or the last memory:leads run. */
  checkedAt: string | null
  /** Why it is not reachable, in a few plain words. */
  reason: string | null
  /** The last memory:leads run, when there is one. */
  lastLeadsRun: { at: string; note: string | null; questionsWithLeads: number | null } | null
}

/** How the chat used memory on one reply (QuestionChatResponse.memory). */
export type ChatMemoryUse =
  /** Excerpts were in the prompt: live results, the leads saved on the question, or both. */
  | 'used'
  /** The memory server could not be reached; the saved leads, if any, were still used. */
  | 'unreachable'
  /** The memory server did not answer in time (busy or asleep); the saved leads, if any, were still used. */
  | 'busy'
  /** Memory was searched and nothing useful came back. */
  | 'none'
  /** Memory was not asked: the feature is off, or the message did not ask for help writing. */
  | null
