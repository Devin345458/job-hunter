import { chromium, type Browser, type BrowserContext } from 'playwright'

// One place that launches Chromium, so the form engine, the submit path and the self-check
// all run with the same flags. In the container Chromium runs as root without a sandbox.

let shared: Promise<Browser> | null = null

export function launchBrowser(): Promise<Browser> {
  if (!shared) {
    shared = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    }).then((browser) => {
      browser.on('disconnected', () => { shared = null })
      return browser
    }).catch((e) => {
      shared = null
      throw e
    })
  }
  return shared
}

/** A fresh, isolated context with a normal desktop browser profile. Close it when done. */
export async function newBrowserContext(): Promise<BrowserContext> {
  const browser = await launchBrowser()
  return browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  })
}
