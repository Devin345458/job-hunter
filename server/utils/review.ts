import { demosEnabled } from './demo/enabled'
import { and, desc, eq, inArray, or } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { applications, decisions, demoProjects, jobs, questions } from '../db/schema'
import { demoNoLongerPlanned } from './demo/store'
import type {
  ApplicationStatus,
  CompensationBreakdown,
  DemoProjectView,
  FormAnswer,
  FormSnapshot,
  GapAnalysis,
  QuestionView,
  RejectSkillsRecord,
  Requirement,
  ReviewItem,
  ScoreBreakdown,
  SubmissionResult,
  TailoredResume,
} from '#shared/types/pipeline'
import { approveEffect } from './apply/approve-effect'
import { decideCardVisible } from './apply/decide'
import { cleanFieldLabel, plainError } from '#shared/utils/plain-text'
import { negativeSkillTerms, rejectSkillOptions } from './reject-skills'
import { repoSuggestionsFor } from './repos/suggest-store'

type JobRow = InferSelectModel<typeof jobs>
type AppRow = InferSelectModel<typeof applications>
type DemoRow = InferSelectModel<typeof demoProjects>
type QuestionRow = InferSelectModel<typeof questions>

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  }
  catch {
    return fallback
  }
}

export function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

/** Strip HTML tags and collapse whitespace. Listings arrive as HTML from most sources. */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null
  return html
    .replace(/<(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;|&ndash;/g, '-')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

export function toQuestionView(q: QuestionRow, repoSuggestion: QuestionView['repoSuggestion'] = null): QuestionView {
  return {
    id: q.id,
    question: q.question,
    context: q.context,
    kind: q.kind,
    subject: q.subject,
    answerType: (q.answerType as QuestionView['answerType']) ?? null,
    choices: parseJson<string[] | null>(q.choicesJson, null),
    blocking: q.blocking,
    status: q.status,
    answer: q.answer,
    repoSuggestion: q.status === 'pending' ? repoSuggestion : null,
  }
}

export function toDemoView(d: DemoRow): DemoProjectView {
  return {
    id: d.id,
    slug: d.slug,
    title: d.title,
    summary: d.summary,
    gapAddressed: d.gapAddressed,
    techStack: parseJson<string[]>(d.techStackJson, []),
    status: d.status as DemoProjectView['status'],
    repoName: d.repoName,
    repoUrl: d.repoUrl,
    liveUrl: d.liveUrl,
    files: parseJson(d.filesJson, []),
    readme: d.readme,
    testCommand: d.testCommand,
    testOutput: d.testOutput,
    testsPassed: d.testsPassed,
    error: d.error,
  }
}

export function toReviewItem(app: AppRow, job: JobRow, demo: DemoRow | null, openQuestions: QuestionRow[], negativeSkills: Set<string> = negativeSkillTerms()): ReviewItem {
  // Labels stored before extraction learned to drop widget status text are cleaned on the way out.
  const snapshot = parseJson<FormSnapshot | null>(app.formSnapshotJson, null)
  if (snapshot) snapshot.fields = snapshot.fields.map(f => ({ ...f, label: cleanFieldLabel(f.label) }))
  const answers = parseJson<FormAnswer[]>(app.answersJson, []).map(a => ({ ...a, label: cleanFieldLabel(a.label) }))
  const requirements = parseJson<Requirement[]>(job.requirementsJson, [])
  const suggestions = repoSuggestionsFor(openQuestions.filter(q => q.status === 'pending' && (q.kind === 'knows' || q.kind === 'has_done')).map(q => q.id))
  return {
    applicationId: app.id,
    status: app.status as ApplicationStatus,
    statusDetail: app.statusDetail,
    proposedAt: app.proposedAt,
    isSandbox: app.isSandbox,
    job: {
      id: job.id,
      title: job.title,
      company: job.company,
      location: job.location,
      remoteType: job.remoteType,
      source: job.source,
      url: job.url,
      applyUrl: job.applyUrl,
      atsType: (job.atsType as ReviewItem['job']['atsType']) ?? null,
      foundAt: job.foundAt,
      salaryMin: job.salaryMin,
      salaryMax: job.salaryMax,
      salaryCurrency: job.salaryCurrency,
      descriptionText: job.postingText || htmlToText(job.description),
    },
    score: parseJson<ScoreBreakdown | null>(job.scoreBreakdown, null),
    compensation: parseJson<CompensationBreakdown | null>(job.compJson, null),
    requirements,
    rejectSkillOptions: rejectSkillOptions(requirements, negativeSkills),
    resume: parseJson<TailoredResume | null>(app.tailoredResumeJson, null),
    resumePdfUrl: app.tailoredResumeJson ? `/api/resume/pdf/${app.id}` : null,
    coverLetter: app.coverLetter,
    form: {
      snapshot,
      answers,
      screenshotUrl: app.formScreenshotPath ? `/api/files/screenshot/${app.id}` : null,
      filledAt: app.formFilledAt,
      error: app.formError,
    },
    gap: parseJson<GapAnalysis | null>(app.gapAnalysisJson, null),
    // A failed demo the current gap analysis no longer plans is not part of this application anymore.
    // Switched off (NUXT_DEMOS_ENABLED=false), the card shows no demo: approve will not publish one.
    demo: demosEnabled() && demo && !demoNoLongerPlanned(demo, app.gapAnalysisJson) ? toDemoView(demo) : null,
    approveEffect: approveEffect(app, job, demosEnabled() && demo && !demoNoLongerPlanned(demo, app.gapAnalysisJson) ? demo.status : undefined),
    openQuestions: openQuestions.map(q => toQuestionView(q, suggestions.get(q.id) ?? null)),
    submission: parseJson<SubmissionResult | null>(app.submissionJson, null),
    submitError: app.submitError,
  }
}

/** Question ids an application's form answers wait on (FormAnswer.needsQuestionId). */
export function referencedQuestionIds(app: AppRow): number[] {
  return parseJson<FormAnswer[]>(app.answersJson, [])
    .map(a => a.needsQuestionId)
    .filter((id): id is number => typeof id === 'number')
}

/**
 * Question ids a Decide card's gap plan asks. A question can have been asked by another job first
 * (askQuestion dedupes by subject), so the card loads them by id, not only by application_id.
 */
function decideGapQuestionIds(app: AppRow): number[] {
  if (app.status !== 'to_decide') return []
  return (parseJson<GapAnalysis | null>(app.gapAnalysisJson, null)?.items ?? [])
    .filter(i => i.decision === 'ask')
    .map(i => i.questionId)
    .filter((id): id is number => typeof id === 'number')
}

function hasValue(v: FormAnswer['value']): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.trim().length > 0
  if (Array.isArray(v)) return v.length > 0
  return true
}

/**
 * Questions a required, still empty form field waits on, whatever their status. A required
 * field is never left with nothing to answer: an answer that did not fit the field, or a skipped
 * question, still shows under Answer first until the field is filled.
 */
export function requiredWaitQuestionIds(app: AppRow): number[] {
  const snapshot = parseJson<FormSnapshot | null>(app.formSnapshotJson, null)
  const required = new Set((snapshot?.fields ?? []).filter(f => f.required).map(f => f.id))
  return parseJson<FormAnswer[]>(app.answersJson, [])
    .filter(a => typeof a.needsQuestionId === 'number' && required.has(a.fieldId) && !hasValue(a.value))
    .map(a => a.needsQuestionId as number)
}

/** The questions to load for a set of applications: pending ones they asked or reference, plus any a required empty field waits on. */
function questionFilter(appIds: number[], refIds: number[], waitIds: number[]) {
  const pending = and(
    eq(questions.status, 'pending'),
    refIds.length ? or(inArray(questions.applicationId, appIds), inArray(questions.id, refIds)) : inArray(questions.applicationId, appIds),
  )
  return waitIds.length ? or(pending, inArray(questions.id, waitIds)) : pending
}

/**
 * Open questions for an application: the pending ones it asked (application_id) plus the pending
 * ones its answers reference, and any question a required empty field still waits on whatever its
 * status. askQuestion() dedupes by subject, so one question row can serve several applications
 * while its application_id names only the first.
 */
function openQuestionsFor(app: AppRow, job: JobRow, loaded: QuestionRow[]): QuestionRow[] {
  const refs = new Set([...referencedQuestionIds(app), ...decideGapQuestionIds(app)])
  const waits = new Set(requiredWaitQuestionIds(app))
  // Blocking is per application: a question blocks this one only when one of its own required
  // form fields waits on it. A question this application asked that no field references keeps
  // the row's flag. Another employer's required field never blocks this application.
  const snapshot = parseJson<FormSnapshot | null>(app.formSnapshotJson, null)
  const required = new Set((snapshot?.fields ?? []).filter(f => f.required).map(f => f.id))
  const answers = parseJson<FormAnswer[]>(app.answersJson, [])
  return loaded
    .filter(q => q.status === 'pending' ? q.applicationId === app.id || refs.has(q.id) : waits.has(q.id))
    .map((q) => {
      if (q.status !== 'pending') {
        // Answered or skipped, yet a required field is still empty: ask it again here.
        const own = answers.find(a => a.needsQuestionId === q.id && required.has(a.fieldId))
        const label = cleanFieldLabel(own?.label ?? q.subject ?? q.question)
        const why = q.status === 'answered' && q.answer
          ? `Your answer "${q.answer}" did not fill "${label}" on ${job.company}'s form. Answer again with one of its options.`
          : `${job.company} asks "${label}" on its application form. The field is required, so the application waits on your answer.`
        return { ...q, blocking: true, context: why }
      }
      const fields = answers.filter(a => a.needsQuestionId === q.id)
      const blocking = fields.length > 0
        ? fields.some(a => required.has(a.fieldId))
        : q.applicationId === app.id && q.blocking
      // A shared question's stored context describes the employer that asked it first. Shown on
      // another application, it says what this employer's own form asks.
      const own = fields.find(a => required.has(a.fieldId)) ?? fields[0]
      const context = q.applicationId !== app.id && own
        ? `${job.company} asks "${cleanFieldLabel(own.label)}" on its application form. The field is ${required.has(own.fieldId) ? 'required' : 'optional'}.`
        : q.context
      return { ...q, blocking, context }
    })
}

/**
 * Review items for applications in the given statuses, best score first. A Decide card (to_decide)
 * shows only while its job still scores at the threshold and is open: a rescore that drops it
 * under, or a closed posting, takes it out of the queue without touching the row.
 * ids limits it to those applications (the cards an answered question was on, read again).
 */
export function listReviewItems(statuses: ApplicationStatus[], ids?: number[]): ReviewItem[] {
  const db = useDb()
  if (ids && ids.length === 0) return []
  const rows = db.select({ app: applications, job: jobs })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .where(ids ? and(inArray(applications.status, statuses), inArray(applications.id, ids)) : inArray(applications.status, statuses))
    .all()
    .filter(r => r.app.status !== 'to_decide' || decideCardVisible(r.job))
  if (rows.length === 0) return []
  const appIds = rows.map(r => r.app.id)
  const demos = db.select().from(demoProjects).where(inArray(demoProjects.applicationId, appIds)).orderBy(desc(demoProjects.id)).all()
  const refIds = rows.flatMap(r => [...referencedQuestionIds(r.app), ...decideGapQuestionIds(r.app)])
  const waitIds = rows.flatMap(r => requiredWaitQuestionIds(r.app))
  const qs = db.select().from(questions).where(questionFilter(appIds, refIds, waitIds)).all()
  const negativeSkills = negativeSkillTerms()
  return rows
    .map(({ app, job }) => toReviewItem(
      app,
      job,
      demos.find(d => d.applicationId === app.id && d.status !== 'discarded') ?? null,
      openQuestionsFor(app, job, qs),
      negativeSkills,
    ))
    .sort((a, b) => (b.score?.final ?? 0) - (a.score?.final ?? 0) || (a.proposedAt ?? '').localeCompare(b.proposedAt ?? ''))
}

export function getReviewItem(applicationId: number): ReviewItem | null {
  const db = useDb()
  const row = db.select({ app: applications, job: jobs })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .where(eq(applications.id, applicationId))
    .get()
  if (!row) return null
  const demo = db.select().from(demoProjects)
    .where(eq(demoProjects.applicationId, applicationId))
    .orderBy(desc(demoProjects.id)).all()
    .find(d => d.status !== 'discarded') ?? null
  const qs = db.select().from(questions).where(questionFilter([applicationId], [...referencedQuestionIds(row.app), ...decideGapQuestionIds(row.app)], requiredWaitQuestionIds(row.app))).all()
  return toReviewItem(row.app, row.job, demo, openQuestionsFor(row.app, row.job, qs))
}

/** The job features a decision is stored with, so learning can find what rejections share. */
export function jobFeatures(job: JobRow) {
  const score = parseJson<ScoreBreakdown | null>(job.scoreBreakdown, null)
  const comp = parseJson<CompensationBreakdown | null>(job.compJson, null)
  return {
    title: job.title,
    company: job.company,
    location: job.location,
    remoteType: job.remoteType,
    source: job.source,
    atsType: job.atsType,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    totalCompEstimate: job.totalCompEstimate,
    compConfidence: comp?.confidence ?? null,
    tags: parseJson<string[]>(job.tags, []),
    matchScore: job.matchScore,
    skillsMatched: score?.skills.matched ?? [],
    skillsMissing: score?.skills.missing ?? [],
  }
}

/** extra is merged into features_json: a wrong_stack rejection stores the skills it named as rejectSkills. */
export function recordDecision(
  applicationId: number,
  /** apply: Devin chose the job at stage 1 (a positive signal); approve: he sent it at stage 2. */
  decision: 'apply' | 'approve' | 'reject',
  reasonCode: string | null,
  reasonText: string | null,
  extra: { rejectSkills?: RejectSkillsRecord } = {},
) {
  const db = useDb()
  const app = db.select().from(applications).where(eq(applications.id, applicationId)).get()
  if (!app) throw createError({ statusCode: 404, statusMessage: 'Application not found' })
  const job = db.select().from(jobs).where(eq(jobs.id, app.jobId)).get()!
  return db.insert(decisions).values({
    applicationId,
    jobId: job.id,
    decision,
    reasonCode,
    reasonText,
    featuresJson: JSON.stringify({ ...jobFeatures(job), ...extra }),
    isSandbox: app.isSandbox,
  }).returning().get()
}

/**
 * Status details are shown as written, so they are stored plain: no API error JSON, stack
 * traces, or internal prefixes. form_error and submit_error keep the raw text for debugging
 * (and prepare_failed's attempt count); the dashboard formats those when it shows them.
 */
export function setApplicationStatus(applicationId: number, status: ApplicationStatus, statusDetail: string | null, extra: Partial<AppRow> = {}) {
  useDb().update(applications)
    .set({ ...extra, status, statusDetail: statusDetail ? plainError(statusDetail) : statusDetail, updatedAt: nowSql() })
    .where(eq(applications.id, applicationId))
    .run()
}
