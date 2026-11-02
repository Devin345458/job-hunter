import type { ReviewItem } from '#shared/types/pipeline'

/**
 * One sentence on what Approve on the review card does for an application, from the approve
 * effect the server worked out (server/utils/apply/approve-effect.ts). A real employer's
 * application is marked for a submit by hand while automated submits are switched off, so
 * "Approve sends it" would be wrong there.
 */
export function approveSentence(effect: ReviewItem['approveEffect'] | null | undefined, company: string | null | undefined): string {
  const who = company?.trim() || 'the employer'
  if (!effect) return 'Approve on the review card is the only step that sends an application.'
  if (effect.submit === 'sandbox') return 'Approve on the review card submits it to the sandbox test form.'
  if (effect.submit === 'automatic') return `Approve on the review card submits it to ${who} automatically.`
  const why = effect.manualReason ? ` (${effect.manualReason.replace(/\.$/, '')})` : ''
  return `Approve on the review card marks it for you to submit by hand on ${who}'s site${why}. The pipeline does not send it.`
}
