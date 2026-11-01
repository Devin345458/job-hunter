import type { Frame, Locator } from 'playwright'
import type { FormAnswer, FormField } from '#shared/types/pipeline'

// Puts stored answers into a live form. Shared by the dry run and the approved submit.
// It never presses Enter (Enter in a form input can submit it), never clicks a submit button,
// and attaches files only when the caller passes attachFiles, which only submit.ts does.

const ACTION_TIMEOUT = 6000

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim()

/** The option that a value names: exact, then prefix, then containment. Null when none is clear. */
export function bestOption(value: string, options: string[]): string | null {
  const v = norm(value)
  if (!v) return null
  const exact = options.find(o => norm(o) === v)
  if (exact) return exact
  const prefix = options.filter(o => norm(o).startsWith(`${v} `) || v.startsWith(`${norm(o)} `))
  if (prefix.length === 1) return prefix[0]!
  if (v.length >= 3) {
    const contains = options.filter(o => norm(o).includes(v) || (norm(o).length >= 3 && v.includes(norm(o))))
    if (contains.length === 1) return contains[0]!
  }
  return null
}

export interface FillOptions {
  attachFiles: boolean
  files?: { resume?: string | null; coverLetter?: string | null }
}

function truthy(v: FormAnswer['value']): boolean {
  if (typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.length > 0
  return /^(true|yes|y|1|checked|on)$/i.test(String(v ?? '').trim())
}

async function check(frame: Frame, input: Locator) {
  try {
    // Short first try: styled radios and checkboxes are often visually hidden behind their label.
    await input.check({ timeout: 2000 })
    return
  }
  catch {}
  const id = await input.getAttribute('id').catch(() => null)
  if (id) {
    const label = frame.locator(`label[for="${id.replace(/"/g, '\\"')}"]`).first()
    if (await label.count()) {
      await label.click({ timeout: ACTION_TIMEOUT })
      if (await input.isChecked().catch(() => false)) return
    }
  }
  await input.check({ timeout: ACTION_TIMEOUT, force: true })
}

async function optionLabels(group: Locator): Promise<string[]> {
  return group.evaluateAll(els => els.map((input) => {
    const clean = (s: string) => (s || '').replace(/[\u2731*]+/g, ' ').replace(/\s+/g, ' ').trim()
    const id = input.getAttribute('id')
    const l = id ? document.querySelector(`label[for="${id.replace(/"/g, '\\"')}"]`) : null
    if (l && clean((l as HTMLElement).innerText)) return clean((l as HTMLElement).innerText)
    const wrap = input.closest('label')
    if (wrap && clean(wrap.innerText)) return clean(wrap.innerText)
    if (input.getAttribute('aria-label')) return clean(input.getAttribute('aria-label') || '')
    if (input.nextSibling?.textContent && clean(input.nextSibling.textContent)) return clean(input.nextSibling.textContent)
    return clean((input as HTMLInputElement).value)
  }))
}

async function fillCombobox(frame: Frame, loc: Locator, value: string): Promise<string | null> {
  const optionsLocator = async () => {
    const controls = await loc.getAttribute('aria-controls').catch(() => null)
    return controls ? frame.locator(`[id="${controls}"] [role="option"]`) : frame.locator('[role="option"]:visible')
  }
  await loc.click({ timeout: ACTION_TIMEOUT })
  await loc.fill('', { timeout: ACTION_TIMEOUT }).catch(() => {})
  await loc.pressSequentially(value.slice(0, 40), { delay: 15, timeout: ACTION_TIMEOUT * 2 })
  await frame.waitForTimeout(600)
  let opts = await optionsLocator()
  let texts = (await opts.allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim())
  let pick = bestOption(value, texts)
  if (!pick) {
    // The typed filter may hide the right option; clear it and look at the full list.
    await loc.fill('', { timeout: ACTION_TIMEOUT }).catch(() => {})
    await frame.waitForTimeout(400)
    opts = await optionsLocator()
    texts = (await opts.allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim())
    pick = bestOption(value, texts)
  }
  if (!pick) {
    await loc.fill('', { timeout: ACTION_TIMEOUT }).catch(() => {})
    await loc.press('Escape').catch(() => {})
    return null
  }
  const index = texts.indexOf(pick)
  await opts.nth(index).click({ timeout: ACTION_TIMEOUT })
  await frame.waitForTimeout(200)
  return pick
}

async function fillOne(frame: Frame, field: FormField, answer: FormAnswer, opts: FillOptions): Promise<{ filled: boolean; error: string | null }> {
  const value = answer.value
  if (field.type === 'file') {
    if (!opts.attachFiles) return { filled: false, error: 'Not attached in the dry run. Files are attached only after you approve.' }
    const path = answer.source === 'cover_letter' ? opts.files?.coverLetter : answer.source === 'resume' ? opts.files?.resume : null
    if (!path) return { filled: false, error: 'No file to attach for this field' }
    await frame.locator(field.selector).first().setInputFiles(path, { timeout: ACTION_TIMEOUT })
    return { filled: true, error: null }
  }
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    return { filled: false, error: null }
  }

  const loc = frame.locator(field.selector)
  const first = loc.first()
  if (!(await loc.count())) return { filled: false, error: 'The field is no longer on the page' }
  const info = await first.evaluate(el => ({
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute('type') || '').toLowerCase(),
    role: el.getAttribute('role'),
    editable: el.getAttribute('contenteditable') === 'true',
  }))

  // Ashby-style yes/no buttons over a hidden checkbox.
  if (field.type === 'radio' && info.type === 'checkbox') {
    const container = first.locator('xpath=ancestor::*[count(.//button) >= 2][1]')
    const labels = (await container.locator('button').allInnerTexts()).map(t => t.trim())
    const pick = bestOption(String(value), labels)
    if (!pick) return { filled: false, error: `No button matches "${value}"` }
    await container.locator('button').nth(labels.indexOf(pick)).click({ timeout: ACTION_TIMEOUT })
    return { filled: true, error: null }
  }

  if (field.type === 'radio') {
    const labels = await optionLabels(loc)
    const pick = bestOption(String(value), labels)
    if (!pick) return { filled: false, error: `No option matches "${value}"` }
    await check(frame, loc.nth(labels.indexOf(pick)))
    return { filled: true, error: null }
  }

  if (field.type === 'checkbox_group') {
    const labels = await optionLabels(loc)
    const wanted = (Array.isArray(value) ? value : String(value).split(/\s*\|\s*/)).map(String)
    let count = 0
    for (const w of wanted) {
      const pick = bestOption(w, labels)
      if (!pick) continue
      await check(frame, loc.nth(labels.indexOf(pick)))
      count++
    }
    return count > 0 ? { filled: true, error: null } : { filled: false, error: 'No option matched' }
  }

  if (field.type === 'checkbox') {
    if (truthy(value)) await check(frame, first)
    else if (await first.isChecked().catch(() => false)) await first.uncheck({ timeout: ACTION_TIMEOUT, force: true })
    return { filled: true, error: null }
  }

  if (info.role === 'combobox' && info.tag !== 'select') {
    const pick = await fillCombobox(frame, first, String(value))
    return pick ? { filled: true, error: null } : { filled: false, error: `No option in the list matches "${value}"` }
  }

  if (info.tag === 'select') {
    const options = await first.evaluate(el => Array.from((el as HTMLSelectElement).options).map(o => ({ label: o.text.trim(), value: o.value })))
    const pick = bestOption(String(value), options.map(o => o.label))
    if (!pick) return { filled: false, error: `No option matches "${value}"` }
    await first.selectOption({ label: pick }, { timeout: ACTION_TIMEOUT })
    return { filled: true, error: null }
  }

  let text = Array.isArray(value) ? value.join(', ') : String(value)
  if (field.maxLength && text.length > field.maxLength) text = text.slice(0, field.maxLength)
  if (info.type === 'number') text = text.replace(/[^\d.]/g, '')
  await first.fill(text, { timeout: ACTION_TIMEOUT })
  return { filled: true, error: null }
}

/** Fills every answer that has a value. Returns the answers with filled and fillError set. */
export async function fillAnswers(frame: Frame, fields: FormField[], answers: FormAnswer[], opts: FillOptions): Promise<FormAnswer[]> {
  const out: FormAnswer[] = []
  for (const answer of answers) {
    const field = fields.find(f => f.id === answer.fieldId)
    if (!field) {
      out.push({ ...answer, filled: false, fillError: 'Field not in the snapshot' })
      continue
    }
    try {
      const r = await fillOne(frame, field, answer, opts)
      out.push({ ...answer, filled: r.filled, fillError: r.error })
    }
    catch (e: any) {
      out.push({ ...answer, filled: false, fillError: String(e?.message || e).split('\n')[0]!.slice(0, 300) })
    }
  }
  return out
}
