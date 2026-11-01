import type { BrowserContext, Frame, Page, Response } from 'playwright'
import type { AtsType, FormSnapshot } from '#shared/types/pipeline'
import { newBrowserContext } from '../browser'
import { dataPath } from '../paths'
import { atsFromUrl, embeddedFormUrl, formUrlFor, requiresAccount } from './ats'
import { scanBlockers, type BlockerScan } from './blockers'
import { extractFieldsInPage, readComboboxOptions, toFormFields, type RawField } from './extract'

// Opens an employer application form and reads it. Nothing here types, uploads, or submits.

export interface OpenedForm {
  context: BrowserContext
  page: Page
  frame: Frame
  snapshot: FormSnapshot
  scan: BlockerScan
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {})
  await page.waitForSelector('input:not([type="hidden"]), select, textarea', { timeout: 12000 }).catch(() => {})
  await page.waitForTimeout(800)
}

async function extractFrom(frame: Frame): Promise<RawField[]> {
  return frame.evaluate(extractFieldsInPage).catch(() => [] as RawField[])
}

/** The frame holding the form: the main frame, or the child frame with the most fields. */
async function pickFrame(page: Page): Promise<{ frame: Frame; raw: RawField[] }> {
  let best = { frame: page.mainFrame(), raw: await extractFrom(page.mainFrame()) }
  if (best.raw.length >= 3) return best
  for (const f of page.frames()) {
    if (f === page.mainFrame() || /recaptcha|hcaptcha|turnstile|youtube|vimeo|google|facebook|doubleclick/i.test(f.url())) continue
    const raw = await extractFrom(f)
    if (raw.length > best.raw.length) best = { frame: f, raw }
  }
  return best
}

export async function openForm(applyUrl: string, atsHint?: AtsType | null): Promise<OpenedForm> {
  let ats: AtsType = atsHint && !['unknown', 'other'].includes(atsHint) ? atsHint : atsFromUrl(applyUrl)
  if (requiresAccount(ats)) throw new Error(`${ats} requires an applicant account; the pipeline never creates one`)
  const url = formUrlFor(applyUrl, ats)
  const context = await newBrowserContext()
  try {
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const response: Response | null = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    let status = response?.status() ?? null
    await settle(page)

    let { frame, raw } = await pickFrame(page)

    // A company careers page with the ATS form in an iframe: open the form itself.
    if (raw.length < 3) {
      const embedded = embeddedFormUrl(page.frames().map(f => f.url()))
      if (embedded) {
        const r = await page.goto(embedded, { waitUntil: 'domcontentloaded', timeout: 45000 })
        status = r?.status() ?? status
        await settle(page)
        ;({ frame, raw } = await pickFrame(page))
      }
    }

    const finalUrl = page.url()
    const detected = atsFromUrl(finalUrl)
    if (detected !== 'other' && detected !== 'unknown') ats = detected
    if (requiresAccount(ats)) {
      // Redirected to an account-based ATS: stop before reading anything.
      return {
        context,
        page,
        frame,
        scan: { blockers: [`account required: the apply link leads to ${ats}`], captcha: null, loginWall: true, closed: null },
        snapshot: { url: applyUrl, finalUrl, atsType: ats, title: await page.title().catch(() => null), fields: [], capturedAt: new Date().toISOString(), requiresAccount: true, blockers: [`account required: the apply link leads to ${ats}`] },
      }
    }

    await readComboboxOptions(frame, raw)
    const fields = toFormFields(raw)
    const scan = await scanBlockers(page, frame, { status, fieldCount: fields.length })
    const snapshot: FormSnapshot = {
      url: applyUrl,
      finalUrl,
      atsType: ats,
      title: await page.title().catch(() => null),
      fields,
      capturedAt: new Date().toISOString(),
      requiresAccount: scan.loginWall,
      blockers: scan.blockers,
    }
    return { context, page, frame, snapshot, scan }
  }
  catch (e) {
    await context.close().catch(() => {})
    throw e
  }
}

/** Full-page screenshot under the data directory. Returns the absolute path. */
export async function screenshot(page: Page, name: string): Promise<string> {
  const path = dataPath('screenshots', name)
  await page.screenshot({ path, fullPage: true, timeout: 30000 })
  return path
}
