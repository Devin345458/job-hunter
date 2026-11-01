import { existsSync } from 'node:fs'
import { and, desc, eq } from 'drizzle-orm'
import type { Frame, Page } from 'playwright'
import { applications, decisions, jobs } from '../../db/schema'
import type { FormAnswer, FormSnapshot, SubmissionResult } from '#shared/types/pipeline'
import { candidateContact, loadKnowledge } from '../knowledge'
import { saveCoverLetterPdf } from '../pdf'
import { parseJson } from '../review'
import { publicBaseUrl, sandboxToken } from '../sandbox'
import { resolveStoredPath } from '../paths'
import { ATS_LABELS, requiresAccount } from './ats'
import { openBlockingQuestionIds } from './answers'
import { detectCaptcha } from './blockers'
import { openForm, screenshot } from './engine'
import { fillAnswers } from './fill'
import { coverLetterPdfPath } from './prepare'

// The approved submit. Only runApproval() in server/utils/approval.ts calls this, and only after
// Devin's approve click. It refuses unless:
// - the application has an approve decision and status submitting;
// - the target is this app's own sandbox form, or real submits are switched on
//   (runtimeConfig.realSubmitEnabled === 'true').
// Account-required ATS, captchas, login walls and closed postings return method 'manual'.

/** True when the URL is this app's own sandbox form with the configured token. */
export function isOwnSandbox(url: string | null | undefined): boolean {
  const token = sandboxToken()
  if (!url || !token) return false
  try {
    const u = new URL(url)
    if (u.pathname !== `/sandbox/apply/${token}`) return false
    const own = new Set(['localhost', '127.0.0.1', '::1'])
    try { own.add(new URL(publicBaseUrl()).hostname) }
    catch {}
    return own.has(u.hostname)
  }
  catch {
    return false
  }
}

function manual(reason: string, sandbox: boolean, finalUrl: string | null = null, screenshotPath: string | null = null): SubmissionResult {
  return { method: 'manual', submittedAt: new Date().toISOString(), finalUrl, confirmationText: null, screenshotPath, sandbox, manualReason: reason }
}

const SUCCESS_TEXT = /thank you for (applying|your application|your interest)|application (was |has been )?(received|submitted|sent)|we.?ve received your application|thanks for applying|successfully submitted|reference number/i

async function waitForConfirmation(page: Page, frame: Frame, startUrl: string): Promise<{ ok: boolean; text: string | null }> {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    await page.waitForTimeout(700)
    const url = page.url()
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 5000) ?? '').catch(() => '')
    const marker = await frame.locator('[data-testid="confirmation"], #application_confirmation, .application-confirmation, [class*="success" i]:visible').first().innerText({ timeout: 300 }).catch(() => null)
    const m = text.match(SUCCESS_TEXT)
    if (marker && SUCCESS_TEXT.test(marker)) return { ok: true, text: marker.replace(/\s+/g, ' ').trim().slice(0, 500) }
    if (m) return { ok: true, text: text.slice(Math.max(0, m.index! - 80), m.index! + 200).replace(/\s+/g, ' ').trim() }
    if (url !== startUrl && /thanks|confirmation|submitted|success/i.test(url)) return { ok: true, text: `Confirmation page: ${url}` }
  }
  return { ok: false, text: null }
}

async function clickSubmit(frame: Frame) {
  const candidates = [
    '#submit_app',
    '#btn-submit',
    'form button[type="submit"]',
    'form input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("Submit application")',
    'button:has-text("Submit Application")',
    'button:has-text("Submit")',
  ]
  for (const sel of candidates) {
    const loc = frame.locator(sel).first()
    if (await loc.count() && await loc.isVisible().catch(() => false)) {
      await loc.click({ timeout: 10000 })
      return sel
    }
  }
  throw new Error('No submit button found on the form')
}

export async function submitApplication(applicationId: number): Promise<SubmissionResult> {
  const db = useDb()
  const app = db.select().from(applications).where(eq(applications.id, applicationId)).get()
  if (!app) throw new Error(`Application ${applicationId} not found`)
  const approve = db.select().from(decisions)
    .where(and(eq(decisions.applicationId, applicationId), eq(decisions.decision, 'approve')))
    .orderBy(desc(decisions.id)).get()
  if (!approve) throw new Error(`Refusing to submit application ${applicationId}: there is no approve decision for it`)
  if (app.status !== 'submitting') throw new Error(`Refusing to submit application ${applicationId}: status is ${app.status}, not submitting`)

  const job = db.select().from(jobs).where(eq(jobs.id, app.jobId)).get()!
  const sandbox = job.atsType === 'sandbox' && isOwnSandbox(job.applyUrl)

  if (requiresAccount(job.atsType)) {
    return manual(`${ATS_LABELS[job.atsType as keyof typeof ATS_LABELS] ?? job.atsType} requires an applicant account, which the pipeline never creates`, false)
  }
  if (!job.applyUrl) return manual('The listing has no application link', sandbox)
  if (!sandbox && useRuntimeConfig().realSubmitEnabled !== 'true') {
    return manual('Automated submits to real employers are switched off (NUXT_REAL_SUBMIT_ENABLED is not "true")', false)
  }

  const snapshot = parseJson<FormSnapshot | null>(app.formSnapshotJson, null)
  const answers = parseJson<FormAnswer[]>(app.answersJson, [])
  if (!snapshot || snapshot.fields.length === 0) return manual('There is no filled form snapshot to submit from', sandbox)
  const stopping = snapshot.blockers.find(b => /^(login wall|closed posting|account required|no form|file upload)/.test(b))
  if (stopping) return manual(stopping, sandbox)
  // Optional fields waiting on a non-blocking question are left empty; anything blocking refuses.
  const blocking = openBlockingQuestionIds(answers, snapshot)
  const missingRequired = answers.filter(a => a.value === null && snapshot.fields.find(f => f.id === a.fieldId)?.required && snapshot.fields.find(f => f.id === a.fieldId)?.type !== 'file')
  if (blocking.length > 0 || missingRequired.length > 0) {
    throw new Error(`Refusing to submit: ${blocking.length} blocking question(s) open, ${missingRequired.length} required field(s) without an answer${missingRequired.length ? ` (${missingRequired.map(a => a.label).join('; ')})` : ''}`)
  }

  const resumePath = app.tailoredResumePdfPath ? resolveStoredPath(app.tailoredResumePdfPath) : null
  if (!resumePath || !existsSync(resumePath)) throw new Error('The tailored resume PDF is missing')
  let coverPath: string | null = null
  if (answers.some(a => a.source === 'cover_letter' && snapshot.fields.find(f => f.id === a.fieldId)?.type === 'file')) {
    coverPath = coverLetterPdfPath(app.id)
    if (!existsSync(coverPath) && app.coverLetter) {
      const { name, contact } = candidateContact(loadKnowledge())
      await saveCoverLetterPdf(app.coverLetter, name, contact, coverPath)
    }
  }

  const opened = await openForm(snapshot.finalUrl || job.applyUrl, snapshot.atsType)
  try {
    const { page, frame } = opened
    const captchaBefore = await detectCaptcha(page, frame)
    if (captchaBefore) {
      const shot = await screenshot(page, `app-${app.id}-submitted.png`).catch(() => null)
      return manual(`${captchaBefore} is on the form; submit it by hand`, sandbox, page.url(), shot)
    }

    // Files are attached here and nowhere else: on an approved application, on the sandbox or
    // with real submits switched on.
    const filled = await fillAnswers(frame, snapshot.fields, answers, { attachFiles: true, files: { resume: resumePath, coverLetter: coverPath } })
    const failedRequired = filled.filter(a => !a.filled && snapshot.fields.find(f => f.id === a.fieldId)?.required && a.value !== null)
    if (failedRequired.length > 0) {
      throw new Error(`Could not fill required field(s): ${failedRequired.map(a => `${a.label} (${a.fillError})`).join('; ')}`)
    }
    await screenshot(page, `app-${app.id}-presubmit.png`).catch(() => null)

    const captchaAfter = await detectCaptcha(page, frame)
    if (captchaAfter) {
      const shot = await screenshot(page, `app-${app.id}-submitted.png`).catch(() => null)
      return manual(`${captchaAfter} appeared after filling; submit it by hand`, sandbox, page.url(), shot)
    }

    const startUrl = page.url()
    await clickSubmit(frame)
    const confirmation = await waitForConfirmation(page, frame, startUrl)
    const shot = await screenshot(page, `app-${app.id}-submitted.png`)
    if (!confirmation.ok) {
      const errors = await frame.locator('[role="alert"], .error, [class*="error" i]:visible').allInnerTexts().catch(() => [])
      throw new Error(`No confirmation after clicking submit${errors.length ? `: ${errors.join(' ').replace(/\s+/g, ' ').slice(0, 300)}` : ''} (screenshot ${shot})`)
    }
    db.update(jobs).set({ status: 'applied' }).where(eq(jobs.id, job.id)).run()
    return {
      method: 'automated',
      submittedAt: new Date().toISOString(),
      finalUrl: page.url(),
      confirmationText: confirmation.text,
      screenshotPath: shot,
      sandbox,
      manualReason: null,
    }
  }
  finally {
    await opened.context.close().catch(() => {})
  }
}
