import { findMyRepos, findRunning } from '~~/server/utils/repos/commit-search'
import { refreshRepoList } from '~~/server/utils/repos/settings'

// POST /api/repos/find
// "Find repos with my commits": searches GitHub for every commit by his logins and emails and
// stores a count per repo. Takes minutes (search allows 30 requests a minute), so it starts in the
// background and returns 202; GET /api/repos shows progress and then the counts. A second call
// while one runs joins it. Recorded in pipeline_runs as repos:find.
export default defineEventHandler(async (event) => {
  setResponseStatus(event, 202)
  if (findRunning()) return { started: false, running: true }
  void withRun('repos:find', 'manual', async (log) => {
    // List first, so repos the search finds that no token lists are told apart from listed ones.
    const listed = await refreshRepoList()
    const f = await findMyRepos(log, listed.accounts)
    return {
      repos: Object.keys(f.byRepo).length,
      owners: new Set(Object.keys(f.byRepo).map(n => n.split('/')[0]!.toLowerCase())).size,
      commits: f.commits,
      requests: f.requests,
      seconds: f.seconds,
      ...(f.notes.length ? { notes: f.notes } : {}),
    }
  }).catch(e => console.error('[repos:find] failed', e))
  return { started: true, running: true }
})
