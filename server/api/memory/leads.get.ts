import type { MemoryLeadsResponse } from '#shared/types/memory'

// GET /api/memory/leads: the leads stored on pending questions, for the "From your Claude
// sessions" block on question cards. Dates, projects, and one quoted line each; the excerpts
// stay on the server and go only to Claude in the question chat.
export default defineEventHandler((): MemoryLeadsResponse => pendingLeads())
