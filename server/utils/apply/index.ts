import { refreshStoredAnswers } from './answers'

// Entry point other units call. The learning unit calls this after Devin answers a question:
// it re-derives the stored answers from the stored snapshot (no browser), clears answered
// blockers, and flips needs_input to proposed when nothing blocks. Call it for every
// needs_input application whose answers reference the answered question id.
// The rest of the engine is imported from its own module:
//   prepare.ts  prepareApplication, refillApplicationForm, refreshAllNeedsInput
//   decide.ts   stage 1: pickJobsToDecide, readForDecision (gap plan and form read before Apply)
//   submit.ts   submitApplication (only runApproval calls it)
//   answers.ts  deriveAnswers (personal facts come from server/utils/facts.ts)
//   ats.ts      atsFromUrl, requiresAccount, ATS_LABELS
export function refreshApplicationAnswers(applicationId: number) {
  return refreshStoredAnswers(applicationId)
}
