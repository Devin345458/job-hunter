// Public only through the /sandbox/jobs/<token> page. Returns the posting text for that page.
export default defineEventHandler((event) => {
  assertSandboxToken(String(getQuery(event).token || ''))
  return SANDBOX_JOB
})
