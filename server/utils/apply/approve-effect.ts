import type { FormSnapshot } from '#shared/types/pipeline'
import { isOwnSandbox } from '../sandbox'
import { ATS_LABELS, requiresAccount } from './ats'

export interface ApproveEffect {
  /** sandbox: sent to this app's test form; automatic: sent to the employer; manual: you submit it by hand. */
  submit: 'sandbox' | 'automatic' | 'manual'
  /** Why the submit will be by hand, in plain words. */
  manualReason: string | null
  /** Set when a built demo cannot be published, so approve would stop before anything is sent. */
  demoBlocked: string | null
}

interface AppLike { formSnapshotJson: string | null; isSandbox: boolean }
interface JobLike { applyUrl: string | null; atsType: string | null; isSandbox: boolean }

function parse<T>(raw: string | null): T | null {
  if (!raw) return null
  try { return JSON.parse(raw) as T }
  catch { return null }
}

/**
 * What approve will do, decided the same way submitApplication and runApproval decide it, from
 * stored data only (no browser). The dashboard says this next to the approve button so a tap
 * never promises a send that will turn into "submit by hand". A captcha that appears only at
 * submit time still turns an automatic submit into a manual one.
 */
export function approveEffect(app: AppLike, job: JobLike, demoStatus: string | null | undefined): ApproveEffect {
  const config = useRuntimeConfig()
  const demoBlocked = demoStatus === 'built' && !String(config.githubToken || '')
    ? 'The demo project cannot be published because the GitHub token is not set'
    : null
  const snapshot = parse<FormSnapshot>(app.formSnapshotJson)
  const target = snapshot?.finalUrl || job.applyUrl
  const sandbox = (job.isSandbox || job.atsType === 'sandbox') && isOwnSandbox(target)
  const manual = (reason: string): ApproveEffect => ({ submit: 'manual', manualReason: reason, demoBlocked })

  if (job.atsType && requiresAccount(job.atsType as any)) return manual(`${ATS_LABELS[job.atsType as keyof typeof ATS_LABELS] ?? job.atsType} needs an applicant account, which the pipeline never creates`)
  if (!job.applyUrl) return manual('the listing has no application link')
  if (!sandbox && config.realSubmitEnabled !== 'true') return manual('automated submits to real employers are switched off')
  if (!snapshot || snapshot.fields.length === 0) return manual('there is no filled form to submit from')
  const stopping = snapshot.blockers.find(b => /^(login wall|closed posting|account required|no form|file upload)/.test(b))
  if (stopping) return manual(stopping.replace(/^[a-z ]+:\s*/, ''))
  const captcha = snapshot.blockers.find(b => /^captcha/.test(b))
  if (captcha) return manual(captcha.replace(/^captcha:\s*/, '').replace(/,? so an automated submit would stop at it\.?$/, '') || 'the form has a captcha')
  return { submit: sandbox ? 'sandbox' : 'automatic', manualReason: null, demoBlocked }
}
