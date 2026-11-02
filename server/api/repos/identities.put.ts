import { saveIdentities } from '~~/server/utils/repos/settings'

// PUT /api/repos/identities { emails: string[], logins: string[] }  saves the commit authors that count as Devin
// PUT /api/repos/identities { reset: true }                         goes back to the defaults
// The next repos:index re-checks every indexed commit against the new list.
export default defineEventHandler(async (event) => {
  const body = await readBody<{ emails?: unknown; logins?: unknown; reset?: unknown }>(event)
  if (body?.reset === true) saveIdentities(null)
  else saveIdentities({ emails: body?.emails, logins: body?.logins })
  return { ok: true }
})
