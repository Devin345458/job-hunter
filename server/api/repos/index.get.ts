import { repoSettingsView } from '~~/server/utils/repos/settings'

// GET /api/repos?refresh=1
// Settings > GitHub evidence: the repos the read tokens can see, grouped by owner, with their
// switches; the author identities; and which owner each token covers. Never returns a token.
export default defineEventHandler(async (event) => {
  return repoSettingsView({ refresh: getQuery(event).refresh === '1' })
})
