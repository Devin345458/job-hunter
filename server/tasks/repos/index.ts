import { runRepoIndex } from '~~/server/utils/repos/indexer'

// First step of the daily chain. Clones or fetches every repo switched on in Settings > GitHub
// evidence and indexes Devin's own commits, the repo languages, and manifest dependencies.
// Payload: { repos?: string[] } limits the run to those full names (only switched-on ones).
export default defineTask({
  meta: {
    name: 'repos:index',
    description: 'Index your own commits in the GitHub repos switched on in Settings',
  },
  async run({ payload }) {
    if (scheduleSkipped(payload as Record<string, unknown> | undefined)) return { result: { skipped: 'the schedule is off on this server (NUXT_SCHEDULER_ENABLED=false)' } }
    const p = (payload ?? {}) as Record<string, unknown>
    const repos = Array.isArray(p.repos) ? p.repos.map(String) : undefined
    const outcome = await withRun('repos:index', triggerOf(payload), log => runRepoIndex({ repos }, log))
    return { result: outcome }
  },
})
