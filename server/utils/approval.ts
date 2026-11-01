import { desc, eq } from 'drizzle-orm'
import { applications, demoProjects } from '../db/schema'
import { submitApplication } from './apply/submit'
import { publishDemo } from './demo/publish'

const inFlight = new Set<number>()

/**
 * Everything that happens after Devin taps approve, in order:
 * 1. publish the demo project, if one was built for this application
 * 2. submit the employer form
 * Runs in the background; the dashboard follows the application's status and status_detail.
 * This is the only code path that calls submitApplication or publishDemo.
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
        result.method === 'manual' ? 'Ready for you to submit by hand' : `Submitted ${result.sandbox ? 'to the sandbox form' : ''}`.trim(),
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
