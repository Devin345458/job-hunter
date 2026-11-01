import type { SubmissionResult } from '#shared/types/pipeline'

// Owned by capability B (form engine). Opens the employer form, fills it from the stored
// answers, attaches the resume, submits, and captures the confirmation. Only the approval
// orchestrator calls it, and only after Devin's approve click.
export async function submitApplication(applicationId: number): Promise<SubmissionResult> {
  throw new Error(`Automated submit is not built yet (application ${applicationId})`)
}
