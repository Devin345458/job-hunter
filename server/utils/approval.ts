import { and, desc, eq } from 'drizzle-orm'
import { applications, demoProjects } from '../db/schema'
import { submitApplication } from './apply/submit'
import { publishDemo } from './demo/publish'

const inFlight = new Set<number>()

/** The status detail an approval stopped by a restart during the submit leaves. Devin asked for these words. */
export const SUBMIT_INTERRUPTED = 'Interrupted while submitting; check the employer\'s site before you submit again'

/**
 * Everything that happens after Devin taps approve, in order:
 * 1. publish the demo project, if one was built for this application
 * 2. submit the employer form
 * Runs as a queue item (applications:approve, server/utils/queue-run.ts); the dashboard follows
 * the application's status and status_detail. This is the only code path that calls
 * submitApplication or publishDemo. A restart in the middle never runs it again (the form may
 * have gone through); markApprovalInterrupted says what to check instead.
 */
export async function runApproval(applicationId: number): Promise<void> {
  if (inFlight.has(applicationId)) return
  inFlight.add(applicationId)
  const db = useDb()
  try {
    const demo = db.select().from(demoProjects)
      .where(eq(demoProjects.applicationId, applicationId))
      .orderBy(desc(demoProjects.id)).all()
      .find(d => d.status === 'built')
    if (demo) {
      setApplicationStatus(applicationId, 'publishing', `Publishing demo project "${demo.title}"`)
      try {
        const published = await publishDemo(demo.id)
        db.update(demoProjects).set({ status: 'published', repoUrl: published.repoUrl, liveUrl: published.liveUrl, publishedAt: nowSql() })
          .where(eq(demoProjects.id, demo.id)).run()
      }
      catch (e: any) {
        db.update(demoProjects).set({ error: e?.message || String(e) }).where(eq(demoProjects.id, demo.id)).run()
        setApplicationStatus(applicationId, 'submit_failed', `Demo publish failed, nothing was submitted: ${e?.message || e}`, { submitError: e?.message || String(e) })
        return
      }
    }

    const app = db.select().from(applications).where(eq(applications.id, applicationId)).get()!
    setApplicationStatus(applicationId, 'submitting', 'Submitting the employer form', { submitAttempts: app.submitAttempts + 1 })
    try {
      const result = await submitApplication(applicationId)
      setApplicationStatus(applicationId, result.method === 'manual' ? 'needs_manual' : 'submitted',
        result.method === 'manual'
          ? `Ready for you to submit by hand${result.manualReason ? `: ${result.manualReason}` : ''}`
          : `Submitted ${result.sandbox ? 'to the sandbox form' : ''}`.trim(),
        { submissionJson: JSON.stringify(result), submittedAt: result.submittedAt, submitError: null })
    }
    catch (e: any) {
      setApplicationStatus(applicationId, 'submit_failed', `Submit failed: ${e?.message || e}`, { submitError: e?.stack || e?.message || String(e) })
    }
  }
  finally {
    inFlight.delete(applicationId)
  }
}

/**
 * An approval item was cut off by a restart (server/utils/queue.ts, recoverExpired). It is never
 * run again. The application goes to submit_failed, so approve can retry it once Devin has looked,
 * with a status detail that says how far it got. A demo left in publishing goes back to built, so
 * a retry publishes it again; publishing reuses the repo that has this history and skips a resume
 * card that is already there. Returns the message for the queue item.
 */
export function markApprovalInterrupted(applicationId: number): string {
  const db = useDb()
  const app = db.select().from(applications).where(eq(applications.id, applicationId)).get()
  if (!app) return 'Interrupted by a restart.'
  db.update(demoProjects).set({ status: 'built' })
    .where(and(eq(demoProjects.applicationId, applicationId), eq(demoProjects.status, 'publishing'))).run()
  const message = app.status === 'submitting'
    ? SUBMIT_INTERRUPTED
    : app.status === 'publishing'
      ? 'Interrupted while publishing the demo; nothing was submitted. Approve again to retry.'
      : 'Interrupted before submitting; nothing was sent. Approve again to retry.'
  if (['approved', 'publishing', 'submitting'].includes(app.status)) {
    setApplicationStatus(applicationId, 'submit_failed', message, { submitError: message })
  }
  return message
}
