import { and, desc, eq, gte, inArray, isNull, notInArray } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { applications, jobs } from '../../db/schema'
import type { FormAnswer, FormSnapshot, GapAnalysis } from '#shared/types/pipeline'
import { AiBudgetExceeded } from '../ai'
import { analyzeGaps } from '../demo/gaps'
import { askGapQuestions, scoredGap } from '../skills-judge'
import { loadKnowledge, type KnowledgeEntry } from '../knowledge'
import { nowSql, parseJson } from '../review'
import { ATS_LABELS, atsFromUrl, requiresAccount } from './ats'
import { deriveAnswers } from './answers'
import { openForm } from './engine'
import { DEFAULT_MATCH_THRESHOLD, MAX_PREPARE_ATTEMPTS, prepareAttempts, roleKey } from './prepare'

// Stage 1 of decide-first: everything Devin needs to decide on a strong match, and nothing that
// is only worth writing once he has chosen it. For every job scoring at or above the threshold:
// an application row in to_decide, its gap plan, and a read of the employer form (Chromium, no
// AI) with the personal facts filled in, options mapped (form_option_map), and a question for each
// fact the form needs that the knowledge base does not hold. The resume, cover letter, and
// form answers that need Claude's judgment are written only after Apply (server/api/review/[id]/apply.post.ts).

type JobRow = InferSelectModel<typeof jobs>
type AppRow = InferSelectModel<typeof applications>

/** Jobs scoring this or more get a Decide card. The same threshold the old prepare step used. */
export const DECIDE_THRESHOLD = DEFAULT_MATCH_THRESHOLD
/** Employer forms read per run. Each takes about half a minute in Chromium; the rest wait for the next run. */
export const MAX_FORM_READS_PER_RUN = 12

const CLOSED_JOB = ['rejected', 'expired']

/**
 * Jobs that need a Decide card: at or above the threshold, open, and no application yet. One per
 * role: a second posting of the same title at the same company is skipped, and so is a role that
 * already has an application in any state. Jobs without an apply link get a card too (Apply then
 * writes the resume and letter for Devin to apply by hand).
 */
export function pickJobsToDecide(threshold = DECIDE_THRESHOLD, limit = MAX_FORM_READS_PER_RUN): JobRow[] {
  const db = useDb()
  const candidates = db.select({ job: jobs })
    .from(jobs)
    .leftJoin(applications, eq(applications.jobId, jobs.id))
    .where(and(isNull(applications.id), gte(jobs.matchScore, threshold), notInArray(jobs.status, CLOSED_JOB)))
    .orderBy(desc(jobs.matchScore))
    .limit(limit * 10)
    .all()
    .map(r => r.job)
  const taken = new Set(db.select({ company: jobs.company, title: jobs.title })
    .from(applications).innerJoin(jobs, eq(applications.jobId, jobs.id)).all()
    .map(r => roleKey(r.company, r.title)))
  const picked: JobRow[] = []
  for (const job of candidates) {
    const key = roleKey(job.company, job.title)
    if (taken.has(key)) continue
    taken.add(key)
    picked.push(job)
    if (picked.length >= limit) break
  }
  return picked
}

/** A Decide row is done once its gap plan is stored and its form was read (or found unusable). */
export function decideRowDone(app: Pick<AppRow, 'gapAnalysisJson' | 'formSnapshotJson' | 'formError'>): boolean {
  return !!app.gapAnalysisJson && (!!app.formSnapshotJson || !!app.formError)
}

/**
 * to_decide rows a run or a budget stop cut off before their gap plan or form read was stored.
 * A row whose job closed or dropped under the threshold since waits: its card is not shown.
 */
export function unfinishedDecideRows(limit = MAX_FORM_READS_PER_RUN): AppRow[] {
  return useDb().select({ app: applications, job: jobs }).from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .where(eq(applications.status, 'to_decide')).all()
    .filter(r => !decideRowDone(r.app) && decideCardVisible(r.job))
    .map(r => r.app)
    .slice(0, limit)
}

function update(applicationId: number, values: Partial<AppRow>) {
  useDb().update(applications).set({ ...values, updatedAt: nowSql() }).where(eq(applications.id, applicationId)).run()
}

/** Creates the stage-1 row for a job. Returns the existing row when the job already has one. */
export function createDecideRow(job: JobRow): AppRow {
  const db = useDb()
  return db.$client.transaction(() => {
    const existing = db.select().from(applications).where(eq(applications.jobId, job.id)).get()
    if (existing) return existing
    return db.insert(applications).values({
      jobId: job.id,
      status: 'to_decide',
      statusDetail: 'Reading the employer form',
      isSandbox: job.isSandbox,
    }).returning().get()
  }).immediate()
}

/** "Form read: 14 fields, 6 filled from your profile, 2 questions for you, 6 written when you apply." */
export function formReadSummary(snapshot: FormSnapshot | null, answers: FormAnswer[], manualReason: string | null): string {
  if (manualReason) return `Apply by hand: ${manualReason}`
  if (!snapshot) return 'The form has not been read yet'
  // The resume and cover letter uploads are written at Apply, so they count there, not as filled.
  const doc = (a: FormAnswer) => a.source === 'resume' || a.source === 'cover_letter'
  const filled = answers.filter(a => a.value !== null && a.value !== '' && !(Array.isArray(a.value) && !a.value.length) && !doc(a)).length
  const asks = new Set(answers.map(a => a.needsQuestionId).filter((x): x is number => typeof x === 'number')).size
  const later = answers.filter(a => a.atApply || doc(a)).length
  const parts = [`Form read: ${snapshot.fields.length} ${snapshot.fields.length === 1 ? 'field' : 'fields'}`, `${filled} filled from your profile`]
  if (asks) parts.push(`${asks} ${asks === 1 ? 'question' : 'questions'} for you`)
  if (later) parts.push(`${later} written when you apply`)
  return `${parts.join(', ')}.`
}

export interface DecideOutcome {
  applicationId: number
  jobId: number
  /** read: the form was read; manual: no usable form (account, no link, closed); gap: only the gap plan was missing. */
  outcome: 'read' | 'manual' | 'failed'
  questions: number
  error?: string
}

/**
 * Stage 1 for one application: the gap plan, then the form read. A budget or credit stop is
 * thrown, so the run stops and the next one continues this row. Never writes a resume, a letter,
 * or a form answer that needs Claude, never fills or submits the form.
 */
export async function readForDecision(app: AppRow, log: (m: string) => void = () => {}, entries: KnowledgeEntry[] = loadKnowledge()): Promise<DecideOutcome> {
  const db = useDb()
  const job = db.select().from(jobs).where(eq(jobs.id, app.jobId)).get()
  if (!job) throw new Error(`Job ${app.jobId} not found`)
  const base = { applicationId: app.id, jobId: job.id }

  if (!app.gapAnalysisJson) {
    // A job scored since decide-first carries its gap plan from the scoring call: copied here, with
    // its open questions asked now that the job has a Decide card. Older scores get one here.
    const scored = scoredGap(job)
    if (scored) update(app.id, { gapAnalysisJson: JSON.stringify(askGapQuestions(scored, { applicationId: app.id, job })) })
  }
  if (!db.select({ g: applications.gapAnalysisJson }).from(applications).where(eq(applications.id, app.id)).get()?.g) {
    update(app.id, { statusDetail: 'Checking the gaps against your knowledge base' })
    try {
      const gap = await analyzeGaps(app.id)
      update(app.id, { gapAnalysisJson: JSON.stringify(gap) })
    }
    catch (e: any) {
      if (e instanceof AiBudgetExceeded) throw e
      const message = String(e?.message || e).split('\n')[0]!
      log(`app ${app.id}: gap plan failed: ${message}`)
      const failed: GapAnalysis = { items: [], demoRecommended: false, summary: `The gap plan could not be made: ${message}`, analyzedAt: new Date().toISOString() }
      update(app.id, { gapAnalysisJson: JSON.stringify(failed) })
    }
  }

  const fresh = db.select().from(applications).where(eq(applications.id, app.id)).get()!
  if (fresh.formSnapshotJson || fresh.formError) return { ...base, outcome: fresh.formError ? 'manual' : 'read', questions: 0 }

  const manual = (reason: string, snapshot: FormSnapshot | null = null): DecideOutcome => {
    update(app.id, { formSnapshotJson: snapshot ? JSON.stringify(snapshot) : null, answersJson: JSON.stringify([]), formError: reason, statusDetail: formReadSummary(snapshot, [], reason) })
    return { ...base, outcome: 'manual', questions: 0 }
  }

  if (requiresAccount(job.atsType)) {
    const label = ATS_LABELS[job.atsType as keyof typeof ATS_LABELS] ?? job.atsType
    return manual(`${label} requires an applicant account, which the pipeline never creates. If you apply, the resume and cover letter are written for you to apply by hand`)
  }
  if (!job.applyUrl) return manual('The listing has no application link. If you apply, the resume and cover letter are written for you to apply by hand')

  log(`app ${app.id}: reading the form at ${job.applyUrl}`)
  update(app.id, { statusDetail: `Reading the ${ATS_LABELS[(job.atsType as keyof typeof ATS_LABELS) ?? 'unknown'] ?? ''} form`.replace(/\s+/g, ' ') })
  let opened: Awaited<ReturnType<typeof openForm>> | null = null
  try {
    opened = await openForm(job.applyUrl, (job.atsType as any) || atsFromUrl(job.applyUrl))
    const { snapshot, scan } = opened
    if (!job.atsType) db.update(jobs).set({ atsType: snapshot.atsType }).where(eq(jobs.id, job.id)).run()
    if (snapshot.requiresAccount || scan.closed || snapshot.fields.length === 0) {
      return manual(snapshot.blockers.join('; ') || 'The form could not be read', snapshot)
    }
    update(app.id, { statusDetail: `Checking ${snapshot.fields.length} form fields against your profile` })
    const answers = await deriveAnswers(snapshot, { applicationId: app.id, job, entries, resume: null, coverLetter: null }, { mode: 'decide' })
    for (const a of answers) {
      const f = snapshot.fields.find(x => x.id === a.fieldId)
      if (f?.type === 'file' && f.required && a.value === null) snapshot.blockers.push(`file upload: "${f.label}" needs a document the pipeline does not have`)
    }
    update(app.id, {
      formSnapshotJson: JSON.stringify(snapshot),
      answersJson: JSON.stringify(answers),
      formError: null,
      statusDetail: formReadSummary(snapshot, answers, null),
    })
    const questions = new Set(answers.map(a => a.needsQuestionId).filter((x): x is number => typeof x === 'number')).size
    log(`app ${app.id}: ${snapshot.fields.length} fields, ${questions} questions`)
    return { ...base, outcome: 'read', questions }
  }
  catch (e: any) {
    if (e instanceof AiBudgetExceeded) throw e
    const message = String(e?.message || e).split('\n')[0]!
    log(`app ${app.id}: form read failed: ${message}`)
    // Kept unfinished (no snapshot, no form error) so the next run reads it again, up to the attempt limit.
    const attempt = (Number(/form read attempt=(\d+)/.exec(fresh.tailoringNotes ?? '')?.[1]) || 0) + 1
    if (attempt >= MAX_PREPARE_ATTEMPTS) return { ...manual(`the form could not be read (${message})`), outcome: 'failed', error: message }
    update(app.id, { tailoringNotes: `form read attempt=${attempt}: ${message}`, statusDetail: `The form could not be read yet (${message}). The next run tries again.` })
    return { ...base, outcome: 'failed', questions: 0, error: message }
  }
  finally {
    await opened?.context.close().catch(() => {})
  }
}

/** Decide cards whose job dropped under the threshold or closed stay as rows but leave the queue. */
export function decideCardVisible(job: Pick<JobRow, 'matchScore' | 'status'>, threshold = DECIDE_THRESHOLD): boolean {
  return (job.matchScore ?? 0) >= threshold && !CLOSED_JOB.includes(job.status)
}

/**
 * Preparations to continue: an application whose preparation stopped (out of budget or credit,
 * cut off, or failed under the attempt limit) and that no queue item holds. Each is queued as its
 * own item again. Only Apply, Prepare again, and preparations started before decide-first put an
 * application in preparing, so nothing Devin did not choose is started here.
 */
export function stoppedPreparations(limit = 10): AppRow[] {
  const held = activeIds([PREPARE_ONE_TASK, REFILL_TASK, APPROVE_TASK], 'applicationId')
  return useDb().select().from(applications).where(inArray(applications.status, ['preparing', 'needs_manual'])).all()
    .filter((a) => {
      if (held.has(a.id)) return false
      if (a.status === 'needs_manual') {
        const n = prepareAttempts(a.formError)
        return n > 0 && n < MAX_PREPARE_ATTEMPTS
      }
      return true
    })
    .slice(0, limit)
}

/** The stage-1 answers of an application, for reuse when it is prepared. */
export function stageOneAnswers(app: Pick<AppRow, 'answersJson'>): FormAnswer[] {
  return parseJson<FormAnswer[]>(app.answersJson, [])
}
