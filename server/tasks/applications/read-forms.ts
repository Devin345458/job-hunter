import { AiBudgetExceeded } from '~~/server/utils/ai'
import { refreshAllNeedsInput } from '~~/server/utils/apply/prepare'
import { createDecideRow, DECIDE_THRESHOLD, MAX_FORM_READS_PER_RUN, pickJobsToDecide, readForDecision, stoppedPreparations, unfinishedDecideRows, type DecideOutcome } from '~~/server/utils/apply/decide'
import { loadKnowledge } from '~~/server/utils/knowledge'
import { rereadFieldTextOnce } from '~~/server/utils/apply/field-text-reread'

// Stage 1 of decide-first, in the scheduled run where applications:prepare used to be. For every
// job scoring at or above the threshold: a Decide card with its gap plan and its employer form read
// (Chromium, no AI except option mapping), so the questions the form needs are known before Devin
// decides. It writes no resume, letter, or form answer; those wait for Apply. It also continues
// preparations Devin already chose that stopped (budget, credit, restart, or a failed attempt),
// each queued as its own applications:prepare-one item, and refreshes waiting answers.
// Once after the 2026-11-05 deploy it first reads again the open forms whose labels point at text
// the stored form lacks, to keep each field's own text (server/utils/apply/field-text-reread.ts;
// Chromium only, no Claude call).
// Payload (manual runs only): { threshold?: number, limit?: number, fieldTextOnly?: boolean }
// fieldTextOnly stops after that re-read, so it can run without any Claude call.
export default defineTask({
  meta: {
    name: 'applications:read-forms',
    description: 'Read the employer forms of strong matches so you can decide on them',
  },
  async run({ payload }) {
    const outcome = await withRun('applications:read-forms', triggerOf(payload), async (log) => {
      const threshold = Number(payload?.threshold) || DECIDE_THRESHOLD
      const limit = Math.min(Number(payload?.limit) || MAX_FORM_READS_PER_RUN, 40)

      // Once: forms read before the reader kept each field's own text (no Claude call). A failure
      // here is logged and never stops the step: the forms below are read as before.
      const fieldText = await rereadFieldTextOnce(log).catch((e: any) => {
        log(`form field text: the one-time re-read stopped (${String(e?.message || e).split('\n')[0]}); it continues next run`)
        return { ran: false, candidates: 0, reread: 0, fieldsGained: 0, failed: [] as Array<{ applicationId: number; error: string }> }
      })
      if (payload?.fieldTextOnly) {
        return { fieldTextReread: fieldText.reread, fieldTextCandidates: fieldText.candidates, fieldsGainedText: fieldText.fieldsGained, fieldTextFailed: fieldText.failed.length }
      }

      // Answers may have arrived since the last run; unblock every application they free.
      const refresh = await refreshAllNeedsInput(log)

      // Preparations Devin chose that stopped go back in the queue, one item each.
      const continued: number[] = []
      for (const app of stoppedPreparations()) {
        queuePrepare(app.id, 'Waiting in the queue to continue preparing')
        continued.push(app.id)
      }
      if (continued.length) log(`queued ${continued.length} stopped ${continued.length === 1 ? 'preparation' : 'preparations'} again: ${continued.join(', ')}`)

      // Cards a run or a budget stop cut off go first and count toward the limit.
      const unfinished = unfinishedDecideRows(limit)
      const fresh = pickJobsToDecide(threshold, Math.max(0, limit - unfinished.length))
      log(`continuing ${unfinished.length}, ${fresh.length} new ${fresh.length === 1 ? 'job' : 'jobs'} at ${threshold} or more`)

      const entries = loadKnowledge()
      const results: Array<DecideOutcome | { jobId: number; applicationId: number | null; outcome: 'stopped' | 'failed'; error: string }> = []
      let budgetStop = false
      const rows = [...unfinished, ...fresh.map(job => createDecideRow(job))]
      for (const app of rows) {
        try {
          results.push(await readForDecision(app, log, entries))
        }
        catch (e: any) {
          const stopped = e instanceof AiBudgetExceeded
          results.push({ jobId: app.jobId, applicationId: app.id, outcome: stopped ? 'stopped' : 'failed', error: String(e?.message || e).split('\n')[0]! })
          if (stopped) { budgetStop = true; break }
        }
      }
      const count = (o: string) => results.filter(r => r.outcome === o).length
      return {
        threshold,
        cards: rows.length,
        formsRead: count('read'),
        byHand: count('manual'),
        failed: count('failed'),
        formQuestions: results.reduce((n, r) => n + ('questions' in r ? r.questions : 0), 0),
        preparationsContinued: continued.length,
        refreshed: refresh.refreshed,
        unblocked: refresh.flipped,
        budgetStop,
        ...(fieldText.ran ? { fieldTextReread: fieldText.reread, fieldsGainedText: fieldText.fieldsGained } : {}),
        errors: results.filter(r => 'error' in r && r.error).map(r => `#${r.applicationId}: ${(r as any).error}`).slice(0, 10),
      }
    })
    return { result: outcome }
  },
})
