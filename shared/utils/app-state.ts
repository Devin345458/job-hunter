// One name per application state, used by the Review queue and card, the Applications page, the
// Jobs list and the job page. A state never has a second name on another screen: to_decide is
// "To decide" everywhere (it was also "Apply or reject" and "New").

export const APP_STATE_LABEL: Record<string, string> = {
  to_decide: 'To decide',
  preparing: 'Preparing',
  proposed: 'Ready to send',
  needs_input: 'Needs your answer',
  approved: 'Approved',
  publishing: 'Publishing demo',
  submitting: 'Submitting',
  submitted: 'Submitted',
  submit_failed: 'Submit failed',
  needs_manual: 'Submit by hand',
  declined: 'Rejected',
  response_received: 'Heard back',
  interviewing: 'Interviewing',
  offer: 'Offer',
  rejected: 'Rejected by employer',
  no_response: 'No response',
  draft: 'Draft',
  ready: 'Ready',
}

/** A needs_manual application whose preparation threw before anything was written. */
export const PREPARE_FAILED_LABEL = 'Preparation failed'

export function appStateLabel(status: string | null | undefined, formError?: string | null): string {
  const s = status ?? ''
  if (s === 'needs_manual' && /^prepare_failed/.test(formError ?? '')) return PREPARE_FAILED_LABEL
  return APP_STATE_LABEL[s] ?? (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '')
}
