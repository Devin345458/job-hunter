import type { Frame, Page } from 'playwright'

// Things on an employer page that stop an automated submit. The dry run records them in the
// snapshot; the submit path checks for a captcha again on the live page before it clicks.

export interface BlockerScan {
  blockers: string[]
  captcha: string | null
  loginWall: boolean
  closed: string | null
}

const CAPTCHA_FRAMES: Array<[RegExp, string]> = [
  [/recaptcha/i, 'Google reCAPTCHA'],
  [/hcaptcha/i, 'hCaptcha'],
  [/challenges\.cloudflare\.com|turnstile/i, 'Cloudflare Turnstile'],
  [/arkoselabs|funcaptcha/i, 'Arkose captcha'],
]

const CLOSED_TEXT = /(no longer (accepting applications|available|open|active|exists)|position has been filled|job (is )?(not found|closed|expired|no longer)|this (job|posting|position|opening) (has )?(expired|closed|been filled)|couldn.?t find (anything|that job|the job)|job you are looking for is no longer|page (you requested )?(was )?not found)/i

export async function detectCaptcha(page: Page, frame: Frame): Promise<string | null> {
  for (const f of page.frames()) {
    const url = f.url()
    for (const [re, name] of CAPTCHA_FRAMES) if (re.test(url)) return name
  }
  const marker = await frame.evaluate(() => {
    if (document.querySelector('.h-captcha, [name="h-captcha-response"], [data-hcaptcha-widget-id]')) return 'hCaptcha'
    if (document.querySelector('.cf-turnstile, [name="cf-turnstile-response"]')) return 'Cloudflare Turnstile'
    if (document.querySelector('.g-recaptcha, [name="g-recaptcha-response"], .grecaptcha-badge')) return 'Google reCAPTCHA'
    if (document.querySelector('[data-sitekey]')) return 'captcha widget'
    return null
  }).catch(() => null)
  return marker
}

export async function scanBlockers(page: Page, frame: Frame, opts: { status: number | null; fieldCount: number }): Promise<BlockerScan> {
  const blockers: string[] = []
  const captcha = await detectCaptcha(page, frame)
  if (captcha) blockers.push(`captcha: ${captcha} is on the form, so an automated submit would stop at it`)

  const pageInfo = await frame.evaluate(() => ({
    password: Array.from(document.querySelectorAll('input[type="password"]')).some(e => (e as HTMLElement).offsetWidth > 0 || (e as HTMLElement).offsetHeight > 0),
    text: (document.body?.innerText || '').slice(0, 6000),
  })).catch(() => ({ password: false, text: '' }))

  const url = page.url()
  const loginWall = pageInfo.password
    || (/\/(login|signin|sign-in|sign_in|register|account\/create)(\/|\?|$)/i.test(url) && opts.fieldCount < 4)
    || (opts.fieldCount < 3 && /\b(sign in|log in|create (an )?account)\b/i.test(pageInfo.text))
  if (loginWall) blockers.push('login wall: the form asks for a sign-in or an account, and the pipeline never creates one')

  let closed: string | null = null
  if (opts.status && opts.status >= 400) closed = `the page returned HTTP ${opts.status}`
  else if (/[?&]error=true/.test(url)) closed = 'the ATS redirected to its job board with an error flag'
  else if (opts.fieldCount < 3) {
    const m = pageInfo.text.match(CLOSED_TEXT)
    if (m) closed = `the page says "${m[0]}"`
  }
  if (closed) blockers.push(`closed posting: ${closed}`)
  if (!closed && !loginWall && opts.fieldCount === 0) blockers.push('no form: no application fields were found at the apply URL')

  return { blockers, captcha, loginWall, closed }
}
