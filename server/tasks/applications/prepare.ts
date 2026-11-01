import { inArray } from 'drizzle-orm'
import { jobs } from '~~/server/db/schema'
import { AiBudgetExceeded } from '~~/server/utils/ai'
import { DEFAULT_MATCH_THRESHOLD, MAX_PER_RUN, pickJobsToPrepare, prepareApplication, refreshAllNeedsInput } from '~~/server/utils/apply/prepare'

// Prepares applications for the strongest matches: tailored resume, cover letter, gap analysis,
// and a dry run of the employer form. At most five per run. Payload (manual runs only):
// { threshold?: number, jobIds?: number[], limit?: number }
export default defineTask({
  meta: {
    name: 'applications:prepare',
    description: 'Tailor, write cover letters, and fill employer forms for top matches',
  },
  async run({ payload }) {
    const outcome = await withRun('applications:prepare', triggerOf(payload), async (log) => {
      const threshold = Number(payload?.threshold) || DEFAULT_MATCH_THRESHOLD
      const limit = Math.min(Number(payload?.limit) || MAX_PER_RUN, MAX_PER_RUN)
      const jobIds = Array.isArray(payload?.jobIds) ? (payload!.jobIds as unknown[]).map(Number).filter(Number.isInteger) : null

      // Answers may have arrived since the last run; unblock every application they free.
      const refresh = await refreshAllNeedsInput(log)

      const picked = jobIds?.length
        ? useDb().select().from(jobs).where(inArray(jobs.id, jobIds)).all().slice(0, limit)
        : pickJobsToPrepare(threshold, limit)
      log(`picked ${picked.length} job(s) at threshold ${threshold}`)

      const results: Array<{ jobId: number; applicationId: number | null; status: string; error?: string }> = []
      let budgetStop = false
      for (const job of picked) {
        try {
          const r = await prepareApplication(job.id, undefined, log)
          results.push({ jobId: job.id, applicationId: r.applicationId, status: r.status, ...(r.error ? { error: r.error } : {}) })
        }
        catch (e: any) {
          results.push({ jobId: job.id, applicationId: null, status: 'error', error: e?.statusMessage || e?.message || String(e) })
          if (e instanceof AiBudgetExceeded) { budgetStop = true; break }
        }
      }
      const count = (s: string) => results.filter(r => r.status === s).length
      return {
        threshold,
        picked: picked.length,
        proposed: count('proposed'),
        needsInput: count('needs_input'),
        needsManual: count('needs_manual'),
        failed: results.filter(r => r.error).length,
        refreshed: refresh.refreshed,
        unblocked: refresh.flipped,
        budgetStop,
        results,
      }
    })
    return { result: outcome }
  },
})
