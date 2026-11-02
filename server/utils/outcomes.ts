import { and, desc, eq, inArray } from 'drizzle-orm'
import { applications, decisions, jobs } from '../db/schema'
import type { OutcomeEntry, OutcomeStatus, SubmissionResult } from '#shared/types/pipeline'
import type { OutcomeRateRow, OutcomeRates } from '#shared/types/learning'
import { HEARD_BACK_STATUSES, SENT_STATUSES, isValidDay, statusChangeRefusal } from '#shared/utils/outcomes'
import { PIPELINE_TIME_ZONE } from '#shared/utils/schedule'
import { properName } from '#shared/utils/names'
import { jobFeatures, parseJson, setApplicationStatus } from './review'

// What happened after an application went out. Each change is a decisions row with decision
// 'outcome' (reasonCode: the new status, reasonText: the note, features_json.outcome: the day and
// the status before). Learning's rule building reads approve and reject rows only, so these never
// change a score; the Learning page shows them as rates.

export const OUTCOME_DECISION = 'outcome'

interface StoredOutcome {
  status: OutcomeStatus | 'submitted'
  date: string
  previousStatus: string | null
}

/** Today in the app's time zone (Central), YYYY-MM-DD. */
function centralToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: PIPELINE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** A timestamp for the timestamp columns: now for today, else noon UTC, which is that same day across the US. */
function dayTimestamp(day: string): string {
  if (day === centralToday()) return new Date().toISOString()
  return `${day}T12:00:00.000Z`
}

export class OutcomeRefused extends Error {}

/**
 * Records an employer outcome, or "I submitted it", on one application: moves its status, sets the
 * dates, and adds a line to its history. Throws OutcomeRefused with a plain reason when the move is
 * not allowed (see statusChangeRefusal) or the day is not a real date.
 */
export function recordOutcome(applicationId: number, to: OutcomeStatus | 'submitted', day: string | null | undefined, note: string | null | undefined): OutcomeEntry {
  const db = useDb()
  const app = db.select().from(applications).where(eq(applications.id, applicationId)).get()
  if (!app) throw createError({ statusCode: 404, statusMessage: 'Application not found' })
  const refusal = statusChangeRefusal(app.status, to)
  if (refusal) throw new OutcomeRefused(refusal)

  const today = centralToday()
  const date = day == null || day === '' ? today : day
  if (!isValidDay(date)) throw new OutcomeRefused('The date must be a real day, written YYYY-MM-DD')
  if (date > addDays(today, 1)) throw new OutcomeRefused('The date cannot be in the future')
  const text = typeof note === 'string' && note.trim() ? note.trim().slice(0, 2000) : null
  const at = dayTimestamp(date)

  if (to === 'submitted') {
    const prior = parseJson<SubmissionResult | null>(app.submissionJson, null)
    const submission: SubmissionResult = {
      finalUrl: null,
      confirmationText: null,
      screenshotPath: null,
      sandbox: app.isSandbox,
      manualReason: null,
      ...prior,
      method: 'manual',
      submittedAt: at,
      byHand: true,
    }
    setApplicationStatus(applicationId, 'submitted', `You submitted it by hand on the employer's site`, {
      submittedAt: at,
      submissionJson: JSON.stringify(submission),
      submitError: null,
    })
  }
  else {
    const firstReply = HEARD_BACK_STATUSES.includes(to as OutcomeStatus) && !app.responseAt
    setApplicationStatus(applicationId, to, null, firstReply ? { responseAt: at } : {})
  }

  const job = db.select().from(jobs).where(eq(jobs.id, app.jobId)).get()!
  const outcome: StoredOutcome = { status: to, date, previousStatus: app.status }
  const row = db.insert(decisions).values({
    applicationId,
    jobId: job.id,
    decision: OUTCOME_DECISION,
    reasonCode: to,
    reasonText: text,
    featuresJson: JSON.stringify({ ...jobFeatures(job), outcome }),
    isSandbox: app.isSandbox,
  }).returning().get()
  return toEntry(row)
}

function toEntry(row: typeof decisions.$inferSelect): OutcomeEntry {
  const stored = parseJson<{ outcome?: StoredOutcome }>(row.featuresJson, {}).outcome
  return {
    id: row.id,
    status: (stored?.status ?? row.reasonCode) as OutcomeEntry['status'],
    date: stored?.date ?? row.createdAt.slice(0, 10),
    note: row.reasonText,
    previousStatus: stored?.previousStatus ?? null,
    recordedAt: row.createdAt,
    isSandbox: row.isSandbox,
  }
}

/** One application's outcome history, newest first. */
export function outcomeHistory(applicationId: number): OutcomeEntry[] {
  return useDb().select().from(decisions)
    .where(and(eq(decisions.applicationId, applicationId), eq(decisions.decision, OUTCOME_DECISION)))
    .orderBy(desc(decisions.id)).all()
    .map(toEntry)
}

// ── Learning: rates by job source and by score band ──

const BANDS: Array<{ key: string; label: string; test: (s: number | null) => boolean }> = [
  { key: '90', label: '90 and up', test: s => s != null && s >= 90 },
  { key: '80', label: '80 to 89', test: s => s != null && s >= 80 && s < 90 },
  { key: '70', label: '70 to 79', test: s => s != null && s >= 70 && s < 80 },
  { key: 'under70', label: 'Under 70', test: s => s != null && s < 70 },
  { key: 'none', label: 'Not scored', test: s => s == null },
]

function emptyRow(key: string, label: string): OutcomeRateRow {
  return { key, label, sent: 0, heardBack: 0, interviews: 0, offers: 0, rejected: 0, noResponse: 0 }
}

/**
 * Real applications that went out and what employers did with them. Heard back, interviews, and
 * offers count what an application ever reached (from its history and its status), so one that went
 * heard back, interviewing, offer counts in all three. Rejected and no response count the current
 * status. The score band uses the match score at approve when there was one, else the job's score now.
 */
export function outcomeRates(): OutcomeRates {
  const db = useDb()
  const sent = db.select({ id: applications.id, status: applications.status, isSandbox: applications.isSandbox, source: jobs.source, matchScore: jobs.matchScore })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .where(inArray(applications.status, [...SENT_STATUSES]))
    .all()
  const real = sent.filter(a => !a.isSandbox)
  const ids = real.map(a => a.id)
  const rows = ids.length
    ? db.select({ applicationId: decisions.applicationId, decision: decisions.decision, reasonCode: decisions.reasonCode, featuresJson: decisions.featuresJson })
      .from(decisions)
      .where(and(inArray(decisions.applicationId, ids), inArray(decisions.decision, [OUTCOME_DECISION, 'approve'])))
      .orderBy(decisions.id).all()
    : []
  const reached = new Map<number, Set<string>>()
  const approveScore = new Map<number, number | null>()
  for (const r of rows) {
    if (r.decision === 'approve') {
      approveScore.set(r.applicationId, parseJson<{ matchScore?: number | null }>(r.featuresJson, {}).matchScore ?? null)
      continue
    }
    if (!reached.has(r.applicationId)) reached.set(r.applicationId, new Set())
    if (r.reasonCode) reached.get(r.applicationId)!.add(r.reasonCode)
  }

  const total = emptyRow('all', 'All sources')
  const bySource = new Map<string, OutcomeRateRow>()
  const byBand = new Map(BANDS.map(b => [b.key, emptyRow(b.key, b.label)]))
  for (const a of real) {
    const seen = new Set([...(reached.get(a.id) ?? []), a.status])
    const score = approveScore.get(a.id) ?? a.matchScore ?? null
    const band = BANDS.find(b => b.test(score))!
    const source = a.source || 'unknown'
    if (!bySource.has(source)) bySource.set(source, emptyRow(source, properName(source)))
    for (const row of [total, bySource.get(source)!, byBand.get(band.key)!]) {
      row.sent++
      if (HEARD_BACK_STATUSES.some(s => seen.has(s))) row.heardBack++
      if (seen.has('interviewing') || seen.has('offer')) row.interviews++
      if (seen.has('offer')) row.offers++
      if (a.status === 'rejected') row.rejected++
      if (a.status === 'no_response') row.noResponse++
    }
  }
  return {
    total,
    bySource: [...bySource.values()].sort((a, b) => b.sent - a.sent || a.label.localeCompare(b.label)),
    byBand: [...byBand.values()].filter(r => r.sent > 0),
    sandboxExcluded: sent.length - real.length,
  }
}
