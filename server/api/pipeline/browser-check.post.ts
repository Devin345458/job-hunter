// Behind login. Proves Chromium launches inside the running container: opens the public
// sandbox posting (or a data URL when the sandbox is off) and returns the browser version.
export default defineEventHandler(async (event) => {
  const started = Date.now()
  const context = await newBrowserContext()
  try {
    const page = await context.newPage()
    const token = sandboxToken()
    const url = token ? `http://127.0.0.1:${process.env.PORT || 3000}/sandbox/jobs/${token}` : 'data:text/html,<title>ok</title>'
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    return {
      ok: true,
      version: context.browser()?.version() ?? null,
      title: await page.title(),
      url: page.url().replace(token || '\u0000', '<token>'),
      ms: Date.now() - started,
    }
  }
  finally {
    await context.close()
  }
})
