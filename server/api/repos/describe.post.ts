import { describeRepos } from '~~/server/utils/repos/describe'

// POST /api/repos/describe { force? }
// Writes a generic description for each switched-on repo that has none (force: every one Devin did
// not write himself). One cheap call per 20 repos. Answer text uses these instead of repo names.
export default defineEventHandler(async (event) => {
  const body = await readBody<{ force?: unknown } | null>(event).catch(() => null)
  return await describeRepos({ force: body?.force === true, log: m => console.info(m) })
})
