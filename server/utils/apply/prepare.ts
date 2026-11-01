import { and, desc, eq, gte, inArray, isNotNull, isNull, like, ne, notInArray } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { applications, jobs, questions } from '../../db/schema'
import type { FormAnswer, FormSnapshot, TailoredResume } from '#shared/types/pipeline'
import { AiBudgetExceeded } from '../ai'
import { analyzeGaps } from '../demo/gaps'
import { candidateContact, loadKnowledge, type KnowledgeEntry } from '../knowledge'
import { dataPath } from '../paths'
import { saveCoverLetterPdf, saveResumePdf } from '../pdf'
import { nowSql, parseJson, setApplicationStatus } from '../review'
import { tailorResumeForJob } from '../tailor'
import { writeCoverLetter } from '../cover-letter'
import { ATS_LABELS, atsFromUrl, requiresAccount } from './ats'
import { deriveAnswers, openBlockingQuestionIds, refreshStoredAnswers } from './answers'
import { openForm, screenshot } from './engine'
import { fillAnswers } from './fill'

type JobRow = InferSelectModel<typeof jobs>
type AppRow = InferSelectModel<typeof applications>

export const DEFAULT_MATCH_THRESHOLD = 70
export const MAX_PER_RUN = 5
export const MAX_PREPARE_ATTEMPTS = 3
/** Marks form_error on an application whose preparation threw, with the attempt count. */
export const PREPARE_FAILED = 'prepare_failed'
/** A preparing row untouched this long was cut off (crash or restart); every step updates it. */
const STALE_PREPARING_MS = 30 * 60 * 1000

export function prepareAttempts(formError: string | null): number {
  const m = formError?.match(/^prepare_failed attempt=(\d+)/)
  return m ? Number(m[1]) : 0
}

const inFlight = new Set<number>()

export function coverLetterPdfPath(applicationId: number) {
  return dataPath('cover-letters', `app-${applicationId}-cover-letter.pdf`)
}

function update(applicationId: number, values: Partial<AppRow>) {
  useDb().update(applications).set({ ...values, updatedAt: nowSql() }).where(eq(applications.id, applicationId)).run()
}

function detail(applicationId: number, statusDetail: string) {
  update(applicationId, { statusDetail })
}

/** Creates the application row for a job, in preparing. Throws 409 when one already exists. */
export function createApplicationRow(job: JobRow): AppRow {
  const db = useDb()
  const existing = db.select().from(applications).where(eq(applications.jobId, job.id)).get()
  if (existing) throw createError({ statusCode: 409, statusMessage: `Application ${existing.id} already exists for this job` })
  return db.insert(applications).values({
    jobId: job.id,
    status: 'preparing',
    statusDetail: 'Tailoring the resume',
    isSandbox: job.isSandbox,
  }).returning().get()
}

export interface FormRunResult {
  snapshot: FormSnapshot | null
  answers: FormAnswer[]
  screenshotPath: string | null
  /** Set when the form cannot be used: login wall, closed posting, no form, or an engine error. */
  manualReason: string | null
}

/**
 * The dry run: open the employer form, read it, answer it, fill every answerable field,
 * screenshot it. Never attaches a file and never clicks submit.
 */
export async function runFormDryRun(app: AppRow, job: JobRow, entries: KnowledgeEntry[], resume: TailoredResume | null, coverLetter: string | null): Promise<FormRunResult> {
  const url = job.applyUrl!
  let opened: Awaited<ReturnType<typeof openForm>> | null = null
  try {
    detail(app.id, `Opening the ${ATS_LABELS[(job.atsType as keyof typeof ATS_LABELS) ?? 'unknown'] ?? ''} form`.replace(/\s+/g, ' '))
    opened = await openForm(url, (job.atsType as any) || atsFromUrl(url))
    const { snapshot, scan, page, frame } = opened

    const unusable = snapshot.requiresAccount || scan.closed || snapshot.fields.length === 0
    if (unusable) {
      const shot = await screenshot(page, `app-${app.id}-form.png`).catch(() => null)
      return { snapshot, answers: [], screenshotPath: shot, manualReason: snapshot.blockers.join('; ') || 'The form could not be read' }
    }

    detail(app.id, `Answering ${snapshot.fields.length} form fields`)
    const answers = await deriveAnswers(snapshot, { applicationId: app.id, job, entries, resume, coverLetter })

    for (const a of answers) {
      const f = snapshot.fields.find(x => x.id === a.fieldId)
      if (f?.type === 'file' && f.required && a.value === null) snapshot.blockers.push(`file upload: "${f.label}" needs a document the pipeline does not have`)
    }

    detail(app.id, 'Filling the form (no files, no submit)')
    const filled = await fillAnswers(frame, snapshot.fields, answers, { attachFiles: false })
    const shot = await screenshot(page, `app-${app.id}-form.png`)
    return { snapshot, answers: filled, screenshotPath: shot, manualReason: null }
  }
  finally {
    await opened?.context.close().catch(() => {})
  }
}

function summarize(snapshot: FormSnapshot, answers: FormAnswer[]) {
  const filled = answers.filter(a => a.filled).length
  const parts = [`Form filled: ${filled} of ${snapshot.fields.length} fields`]
  if (snapshot.blockers.length) parts.push(`blockers: ${snapshot.blockers.map(b => b.split(':')[0]).join(', ')}`)
  return parts.join('; ')
}

/**
 * After a new dry run, questions this application asked earlier may no longer apply (the form
 * changed, or the field is now answered another way). A pending question nothing references
 * stops blocking: a field-specific one is skipped, a reusable fact stays open without blocking.
 */
export function releaseStaleQuestions(applicationId: number, answers: FormAnswer[]) {
  const referenced = new Set(answers.map(a => a.needsQuestionId).filter((x): x is number => typeof x === 'number'))
  const db = useDb()
  const stale = db.select().from(questions)
    .where(and(eq(questions.applicationId, applicationId), eq(questions.status, 'pending')))
    .all()
    .filter(q => !referenced.has(q.id))
    // One question row can serve several applications; leave it alone while another one waits on it.
    .filter(q => !db.select({ id: applications.id }).from(applications)
      .where(and(ne(applications.id, applicationId), like(applications.answersJson, `%"needsQuestionId":${q.id}}%`)))
      .get()
      && !db.select({ id: applications.id }).from(applications)
        .where(and(ne(applications.id, applicationId), like(applications.answersJson, `%"needsQuestionId":${q.id},%`)))
        .get())
  for (const q of stale) {
    if (q.kind === 'form_field') db.update(questions).set({ status: 'skipped', blocking: false }).where(eq(questions.id, q.id)).run()
    else if (q.blocking) db.update(questions).set({ blocking: false }).where(eq(questions.id, q.id)).run()
  }
  return stale.length
}

/** Saves a dry run's results and sets the application's status from them. */
export function storeFormRun(applicationId: number, run: FormRunResult) {
  releaseStaleQuestions(applicationId, run.answers)
  const values: Partial<AppRow> = {
    formSnapshotJson: run.snapshot ? JSON.stringify(run.snapshot) : null,
    answersJson: JSON.stringify(run.answers),
    formScreenshotPath: run.screenshotPath,
    formFilledAt: nowSql(),
    formError: run.manualReason,
  }
  if (run.manualReason) {
    setApplicationStatus(applicationId, 'needs_manual', `Apply by hand: ${run.manualReason}`, values)
    return 'needs_manual' as const
  }
  const blocking = openBlockingQuestionIds(run.answers, run.snapshot)
  if (blocking.length > 0) {
    setApplicationStatus(applicationId, 'needs_input', `Waiting on ${blocking.length} answer${blocking.length === 1 ? '' : 's'} from you. ${summarize(run.snapshot!, run.answers)}`, values)
    return 'needs_input' as const
  }
  setApplicationStatus(applicationId, 'proposed', `Ready for review. ${summarize(run.snapshot!, run.answers)}`, { ...values, proposedAt: nowSql() })
  return 'proposed' as const
}

export interface PrepareOutcome {
  applicationId: number
  status: string
  error?: string
}

/**
 * Prepares one application end to end: tailored resume (checked), PDF, cover letter (checked),
 * gap analysis, then the form dry run. Account-required ATS stop after the packet.
 * Pass an existing application to prepare it again in place.
 */
export async function prepareApplication(jobId: number, existing?: AppRow, log: (m: string) => void = () => {}): Promise<PrepareOutcome> {
  const db = useDb()
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get()
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Job not found' })
  const app = existing ?? createApplicationRow(job)
  if (inFlight.has(app.id)) return { applicationId: app.id, status: app.status }
  inFlight.add(app.id)
  const ref = { type: 'application', id: app.id }
  try {
    if (existing) setApplicationStatus(app.id, 'preparing', 'Tailoring the resume', { formError: null, submitError: null })
    const entries = loadKnowledge()
    const { name, contact } = candidateContact(entries)

    log(`app ${app.id}: tailoring for job ${job.id} (${job.company})`)
    const tailored = await tailorResumeForJob(job, entries, ref)
    const pdfPath = dataPath('resumes', `resume-${app.id}.pdf`)
    await saveResumePdf(tailored.resume, name, contact, pdfPath)
    update(app.id, { tailoredResumeJson: JSON.stringify(tailored.resume), tailoredResumePdfPath: pdfPath, tailoringNotes: tailored.notes, statusDetail: 'Writing the cover letter' })

    log(`app ${app.id}: cover letter`)
    const letter = await writeCoverLetter(job, entries, tailored.resume, ref)
    await saveCoverLetterPdf(letter.text, name, contact, coverLetterPdfPath(app.id))
    const notes = `${tailored.notes}\n\n${letter.notes}`
    update(app.id, { coverLetter: letter.text, tailoringNotes: notes, statusDetail: 'Analyzing gaps' })

    try {
      const gap = await analyzeGaps(app.id)
      update(app.id, { gapAnalysisJson: JSON.stringify(gap) })
    }
    catch (e: any) {
      log(`app ${app.id}: gap analysis failed: ${e?.message || e}`)
      update(app.id, { tailoringNotes: `${notes}\n\nGap analysis failed: ${e?.message || e}` })
    }

    if (requiresAccount(job.atsType)) {
      const label = ATS_LABELS[job.atsType as keyof typeof ATS_LABELS] ?? job.atsType
      setApplicationStatus(app.id, 'needs_manual', `${label} requires an applicant account, which the pipeline never creates. The resume and cover letter are ready for you to apply by hand.`, { formError: null })
      return { applicationId: app.id, status: 'needs_manual' }
    }
    if (!job.applyUrl) {
      setApplicationStatus(app.id, 'needs_manual', 'The listing has no application link. The resume and cover letter are ready for you to apply by hand.')
      return { applicationId: app.id, status: 'needs_manual' }
    }

    log(`app ${app.id}: form dry run at ${job.applyUrl}`)
    let run: FormRunResult
    try {
      run = await runFormDryRun(app, job, entries, tailored.resume, letter.text)
    }
    catch (e: any) {
      if (e instanceof AiBudgetExceeded) throw e
      run = { snapshot: null, answers: [], screenshotPath: null, manualReason: `the form engine failed: ${String(e?.message || e).split('\n')[0]}` }
    }
    if (run.snapshot && !job.atsType) db.update(jobs).set({ atsType: run.snapshot.atsType }).where(eq(jobs.id, job.id)).run()
    const status = storeFormRun(app.id, run)
    log(`app ${app.id}: ${status}`)
    return { applicationId: app.id, status }
  }
  catch (e: any) {
    // A failed preparation ends in needs_manual with the reason, so the dashboard can act on it.
    // The daily run retries it up to MAX_PREPARE_ATTEMPTS times; the prepare endpoint retries on demand.
    const message = String(e?.statusMessage || e?.message || e).split('\n')[0]!
    const attempt = prepareAttempts(existing?.formError ?? null) + 1
    const retry = attempt < MAX_PREPARE_ATTEMPTS ? 'The next daily run retries it, or retry it now from the application page.' : 'Retry it from the application page.'
    setApplicationStatus(app.id, 'needs_manual', `Preparation failed: ${message}. ${retry}`, {
      formError: `${PREPARE_FAILED} attempt=${attempt}: ${message}\n${String(e?.stack || '').slice(0, 3500)}`,
    })
    log(`app ${app.id}: failed (attempt ${attempt}): ${message}`)
    if (e instanceof AiBudgetExceeded) throw e
    return { applicationId: app.id, status: 'needs_manual', error: message }
  }
  finally {
    inFlight.delete(app.id)
  }
}

/** Re-runs only the form dry run, with the stored resume and cover letter. */
export async function refillApplicationForm(applicationId: number): Promise<PrepareOutcome> {
  const db = useDb()
  const app = db.select().from(applications).where(eq(applications.id, applicationId)).get()
  if (!app) throw createError({ statusCode: 404, statusMessage: 'Application not found' })
  const job = db.select().from(jobs).where(eq(jobs.id, app.jobId)).get()!
  if (!job.applyUrl) throw createError({ statusCode: 400, statusMessage: 'The job has no application link' })
  if (requiresAccount(job.atsType)) throw createError({ statusCode: 400, statusMessage: 'This ATS requires an account; there is no form to fill' })
  if (inFlight.has(app.id)) return { applicationId: app.id, status: app.status }
  inFlight.add(app.id)
  try {
    setApplicationStatus(app.id, 'preparing', 'Filling the form again')
    let run: FormRunResult
    try {
      run = await runFormDryRun(app, job, loadKnowledge(), parseJson<TailoredResume | null>(app.tailoredResumeJson, null), app.coverLetter)
    }
    catch (e: any) {
      run = { snapshot: null, answers: [], screenshotPath: null, manualReason: `the form engine failed: ${String(e?.message || e).split('\n')[0]}` }
    }
    return { applicationId: app.id, status: storeFormRun(app.id, run) }
  }
  finally {
    inFlight.delete(app.id)
  }
}

/** Jobs the daily run prepares: strong matches with an apply link and no application yet. */
export function pickJobsToPrepare(threshold = DEFAULT_MATCH_THRESHOLD, limit = MAX_PER_RUN): JobRow[] {
  return useDb().select({ job: jobs })
    .from(jobs)
    .leftJoin(applications, eq(applications.jobId, jobs.id))
    .where(and(
      isNull(applications.id),
      isNotNull(jobs.applyUrl),
      gte(jobs.matchScore, threshold),
      notInArray(jobs.status, ['rejected', 'expired']),
    ))
    .orderBy(desc(jobs.matchScore))
    .limit(limit)
    .all()
    .map(r => r.job)
}

/**
 * Applications to prepare again before new ones: failed preparations under the attempt limit,
 * and rows left in preparing by a crash or restart.
 */
export function pickRetries(limit = MAX_PER_RUN): AppRow[] {
  const now = Date.now()
  return useDb().select().from(applications)
    .where(inArray(applications.status, ['needs_manual', 'preparing']))
    .all()
    .filter((a) => {
      if (inFlight.has(a.id)) return false
      if (a.status === 'needs_manual') {
        const n = prepareAttempts(a.formError)
        return n > 0 && n < MAX_PREPARE_ATTEMPTS
      }
      const updated = Date.parse(`${a.updatedAt.replace(' ', 'T')}Z`)
      return Number.isFinite(updated) && now - updated > STALE_PREPARING_MS
    })
    .slice(0, limit)
}

/** Every needs_input application gets a refresh, so a shared question unblocks all of them. */
export async function refreshAllNeedsInput(log: (m: string) => void = () => {}) {
  const rows = useDb().select().from(applications).where(eq(applications.status, 'needs_input')).all()
  let flipped = 0
  for (const r of rows) {
    try {
      const res = await refreshStoredAnswers(r.id)
      if (res.status === 'proposed') flipped++
    }
    catch (e: any) {
      log(`refresh of app ${r.id} failed: ${e?.message || e}`)
    }
  }
  return { refreshed: rows.length, flipped }
}
