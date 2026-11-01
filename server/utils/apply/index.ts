import { refreshStoredAnswers } from './answers'

// Entry point other units call. The learning unit calls this after Devin answers a question:
// it re-derives the stored answers from the stored snapshot (no browser), clears answered
// blockers, and flips needs_input to proposed when nothing blocks. Call it for every
// needs_input application whose answers reference the answered question id.
// The rest of the engine is imported from its own module:
//   prepare.ts  prepareApplication, refillApplicationForm, pickJobsToPrepare, refreshAllNeedsInput
//   submit.ts   submitApplication (only runApproval calls it)
//   answers.ts  deriveAnswers, CANONICAL_FACTS
//   ats.ts      atsFromUrl, requiresAccount, ATS_LABELS
export function refreshApplicationAnswers(applicationId: number) {
  return refreshStoredAnswers(applicationId)
}
