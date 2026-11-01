import type { Frame } from 'playwright'
import type { FormField, FormFieldType } from '#shared/types/pipeline'

// Field extraction. The function below runs inside the employer's page (Playwright serializes
// it), so it must not reference anything outside its own body. It only reads the DOM: no
// clicks, no typing. Combobox options, which most React forms render only when opened, are
// read afterwards by readComboboxOptions().

export interface RawField {
  selector: string
  label: string
  type: FormFieldType
  required: boolean
  options: string[]
  maxLength: number | null
  section: string | null
  isEeo: boolean
  control: 'native' | 'combobox' | 'buttons'
}

export function extractFieldsInPage(): RawField[] {
  const out: RawField[] = []
  const seen = new Set<string>()
  const GENERIC = /^(attach|attach resume\/?cv|upload|upload file|upload a file|choose file|browse|drop files? here|select|select\.\.\.|enter manually|or|paste)$/i
  const EEO = /\b(gender|sex|race|racial|ethnic|ethnicity|hispanic|latin[oax]|veteran|disabilit|disabled|sexual orientation|transgender|pronoun|self[-\s]?identif|lgbt|eeo)\w*/i

  const textOf = (el: Element | null): string => (el ? ((el as HTMLElement).innerText || el.textContent || '') : '')
  const clean = (s: string): string => (s || '').replace(/[\u2731*]+/g, ' ').replace(/\(\s*(required|optional)\s*\)/gi, ' ').replace(/\s+/g, ' ').trim()
  const starred = (s: string): boolean => /[*\u2731]/.test(s || '')
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return (r.width > 1 || r.height > 1) && st.visibility !== 'hidden' && st.display !== 'none'
  }
  const esc = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const uniq = (sel: string): boolean => {
    try { return document.querySelectorAll(sel).length === 1 }
    catch { return false }
  }
  const selectorOf = (el: Element): string => {
    const id = el.getAttribute('id')
    if (id && uniq(`[id="${esc(id)}"]`)) return `[id="${esc(id)}"]`
    const name = el.getAttribute('name')
    if (name) {
      const s = `${el.tagName.toLowerCase()}[name="${esc(name)}"]`
      if (uniq(s)) return s
    }
    const parts: string[] = []
    let cur: Element | null = el
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
      const cid = cur.getAttribute('id')
      if (cid && uniq(`[id="${esc(cid)}"]`)) { parts.unshift(`[id="${esc(cid)}"]`); break }
      let i = 1
      let sib = cur.previousElementSibling
      while (sib) { if (sib.tagName === cur.tagName) i++; sib = sib.previousElementSibling }
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${i})`)
      cur = cur.parentElement
    }
    return parts.join(' > ')
  }
  const labelElFor = (el: Element): Element | null => {
    const id = el.getAttribute('id')
    if (!id) return null
    try { return document.querySelector(`label[for="${esc(id)}"]`) }
    catch { return null }
  }
  // The question text of a field's container: the first label-like element before the control.
  const containerLabel = (el: Element, exclude: Element[]): string => {
    let cur: Element | null = el.parentElement
    for (let depth = 0; cur && depth < 7; depth++, cur = cur.parentElement) {
      for (const selector of ['legend, label, [class*="label" i], [class*="title" i], h3, h4, h5', '[class*="question" i] > p, p, span']) {
        const cands = Array.from(cur.querySelectorAll(selector))
        let nearest = ''
        for (const c of cands) {
          if (exclude.some(x => c === x || c.contains(x))) continue
          if (!(c.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue
          const t = clean(textOf(c).split('\n')[0] || '')
          if (t && !GENERIC.test(t) && t.length < 400) nearest = textOf(c)
        }
        if (nearest) return nearest
      }
    }
    return ''
  }
  const labelOf = (el: Element): string => {
    let t = textOf(labelElFor(el))
    if (!clean(t) || GENERIC.test(clean(t))) {
      const ids = el.getAttribute('aria-labelledby')
      if (ids) t = ids.split(/\s+/).map(i => textOf(document.getElementById(i))).join(' ')
    }
    if (!clean(t) || GENERIC.test(clean(t))) t = el.getAttribute('aria-label') || t
    if (!clean(t) || GENERIC.test(clean(t))) {
      const wrap = el.closest('label')
      if (wrap) {
        // Only the label's own visible text: not the control's options, button captions, or
        // hidden status messages ("Analyzing resume...") that some ATS keep inside the label.
        const parts: string[] = []
        const walker = document.createTreeWalker(wrap, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const parent = node.parentElement
          if (!parent || parent.closest('select, option, textarea, button, [class*="default-label" i], [class*="filename" i]')) continue
          if (!parent.getClientRects().length || getComputedStyle(parent).visibility === 'hidden') continue
          parts.push(node.textContent || '')
        }
        t = parts.join(' ').replace(/\s+/g, ' ')
      }
    }
    if (!clean(t) || GENERIC.test(clean(t))) t = containerLabel(el, [el]) || t
    if (!clean(t)) t = el.getAttribute('placeholder') || el.getAttribute('name') || ''
    return t
  }
  const optionLabel = (input: Element): string => {
    const l = labelElFor(input)
    if (l && clean(textOf(l))) return clean(textOf(l))
    const wrap = input.closest('label')
    if (wrap && clean(textOf(wrap))) return clean(textOf(wrap))
    const aria = input.getAttribute('aria-label')
    if (aria) return clean(aria)
    const next = input.nextSibling
    if (next && clean(next.textContent || '')) return clean(next.textContent || '')
    return clean((input as HTMLInputElement).value || '')
  }
  const heads = Array.from(document.querySelectorAll('h1, h2, h3, h4, legend, [class*="section-title" i], [class*="sectionTitle"]'))
  const sectionOf = (el: Element): string | null => {
    let found: string | null = null
    for (const h of heads) {
      if (h.contains(el)) continue
      if (h.tagName === 'LEGEND' && !(h.parentElement && h.parentElement.contains(el))) continue
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        const t = clean(textOf(h)).slice(0, 120)
        if (t) found = t
      }
    }
    return found
  }
  const requiredOf = (el: Element, label: string): boolean =>
    (el as HTMLInputElement).required === true
    || el.getAttribute('aria-required') === 'true'
    || starred(label)
  const push = (f: RawField) => {
    if (!f.selector || seen.has(f.selector)) return
    seen.add(f.selector)
    f.isEeo = EEO.test(`${f.label} ${f.section || ''}`) || /voluntary self|equal employment/i.test(f.section || '')
    out.push(f)
  }

  const controls = Array.from(document.querySelectorAll('input, select, textarea, [role="combobox"], [contenteditable="true"]'))
  const groupsDone = new Set<string>()
  for (const el of controls) {
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || (tag === 'input' ? 'text' : tag)).toLowerCase()
    const role = el.getAttribute('role')
    if (['hidden', 'submit', 'button', 'reset', 'image', 'password'].includes(type)) continue
    if ((el as HTMLInputElement).disabled) continue
    if (/recaptcha|hcaptcha|captcha/i.test(`${el.getAttribute('name') || ''} ${el.id}`)) continue

    // Radio and checkbox groups share a name: one field per group.
    if ((type === 'radio' || type === 'checkbox') && el.getAttribute('name')) {
      const name = el.getAttribute('name')!
      const members = Array.from(document.querySelectorAll(`input[type="${type}"][name="${esc(name)}"]`))
      if (members.length > 1 || type === 'radio') {
        if (groupsDone.has(`${type}:${name}`)) continue
        groupsDone.add(`${type}:${name}`)
        if (!members.some(m => visible(m) || visible(m.closest('label') || m) || visible(labelElFor(m) || m))) continue
        const opts = members.map(optionLabel).filter(Boolean)
        const group = el.closest('[role="radiogroup"], [role="group"], fieldset')
        let q = ''
        if (group) {
          const lb = group.getAttribute('aria-labelledby')
          if (lb) q = lb.split(/\s+/).map(i => textOf(document.getElementById(i))).join(' ')
          if (!clean(q)) { const lg = group.querySelector('legend'); if (lg) q = textOf(lg) }
        }
        if (!clean(q)) q = containerLabel(members[0]!, members.flatMap(m => [m, labelElFor(m), m.closest('label')].filter(Boolean) as Element[]))
        push({
          selector: `input[type="${type}"][name="${esc(name)}"]`,
          label: clean(q) || name,
          type: type === 'radio' ? 'radio' : 'checkbox_group',
          required: members.some(m => (m as HTMLInputElement).required || m.getAttribute('aria-required') === 'true') || starred(q),
          options: opts,
          maxLength: null,
          section: sectionOf(el),
          isEeo: false,
          control: 'native',
        })
        continue
      }
    }

    // Ashby-style yes/no: a hidden checkbox driven by visible buttons in the same field.
    if (type === 'checkbox' && !visible(el)) {
      let box: Element | null = el.parentElement
      let buttons: Element[] = []
      for (let d = 0; box && d < 4; d++, box = box.parentElement) {
        buttons = Array.from(box.querySelectorAll('button')).filter(b => visible(b) && clean(textOf(b)).length > 0 && clean(textOf(b)).length < 40)
        if (buttons.length >= 2) break
      }
      if (buttons.length >= 2 && box) {
        const label = containerLabel(buttons[0]!, buttons) || textOf(labelElFor(el))
        push({
          selector: selectorOf(el),
          label: clean(label),
          type: 'radio',
          required: starred(label) || el.getAttribute('aria-required') === 'true' || (el as HTMLInputElement).required,
          options: buttons.map(b => clean(textOf(b))),
          maxLength: null,
          section: sectionOf(el),
          isEeo: false,
          control: 'buttons',
        })
        continue
      }
      // A visually hidden checkbox whose label is visible is a styled checkbox.
      const lab = labelElFor(el) || el.closest('label')
      if (lab && visible(lab)) {
        const label = textOf(lab)
        push({ selector: selectorOf(el), label: clean(label), type: 'checkbox', required: requiredOf(el, label), options: [], maxLength: null, section: sectionOf(el), isEeo: false, control: 'native' })
      }
      continue
    }

    if (type === 'file') {
      const label = labelOf(el)
      const id = (el.getAttribute('id') || '') + (el.getAttribute('name') || '')
      // An unlabeled file input at the top of a form is the ATS's "autofill from resume" box.
      if (!id && !clean(textOf(labelElFor(el)))) continue
      const fileLabel = clean(label).replace(/\s+(attach|upload|choose|drop)\b.*$/i, '').trim() || clean(label)
      push({ selector: selectorOf(el), label: fileLabel, type: 'file', required: requiredOf(el, label), options: [], maxLength: null, section: sectionOf(el), isEeo: false, control: 'native' })
      continue
    }

    if (!visible(el)) continue
    if (el.getAttribute('aria-hidden') === 'true' || (el.getAttribute('tabindex') === '-1' && getComputedStyle(el).opacity === '0')) continue
    if (type === 'search' && role !== 'combobox') continue
    const label = labelOf(el)
    if (!clean(label)) continue

    if (role === 'combobox' && tag !== 'select') {
      push({ selector: selectorOf(el), label: clean(label), type: 'select', required: requiredOf(el, label), options: [], maxLength: null, section: sectionOf(el), isEeo: false, control: 'combobox' })
      continue
    }
    if (tag === 'select') {
      const opts = Array.from((el as HTMLSelectElement).options).map(o => clean(o.text)).filter(t => t && !/^(select|choose|please select|--)/i.test(t))
      push({ selector: selectorOf(el), label: clean(label), type: 'select', required: requiredOf(el, label), options: opts, maxLength: null, section: sectionOf(el), isEeo: false, control: 'native' })
      continue
    }
    const ft: FormFieldType = tag === 'textarea' || el.getAttribute('contenteditable') === 'true'
      ? 'textarea'
      : type === 'checkbox'
        ? 'checkbox'
        : (['email', 'tel', 'url', 'number', 'date'].includes(type) ? type : 'text') as FormFieldType
    const max = (el as HTMLInputElement).maxLength
    push({
      selector: selectorOf(el),
      label: clean(label),
      type: ft,
      required: requiredOf(el, label),
      options: [],
      maxLength: max && max > 0 && max < 100000 ? max : null,
      section: sectionOf(el),
      isEeo: false,
      control: 'native',
    })
  }
  return out
}

/** Opens each React combobox, reads its options, and closes it with Escape. Never picks one. */
export async function readComboboxOptions(frame: Frame, fields: RawField[]): Promise<void> {
  for (const f of fields.filter(x => x.control === 'combobox')) {
    try {
      const loc = frame.locator(f.selector).first()
      await loc.click({ timeout: 4000 })
      await frame.waitForTimeout(400)
      const controls = await loc.getAttribute('aria-controls').catch(() => null)
      const scope = controls ? frame.locator(`[id="${controls}"] [role="option"]`) : frame.locator('[role="option"]:visible')
      const texts = (await scope.allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean)
      f.options = [...new Set(texts)].slice(0, 300)
      await loc.press('Escape').catch(() => {})
      await frame.waitForTimeout(150)
    }
    catch {
      // Leave options empty; the answer step treats the field as free text and the fill step types it.
    }
  }
}

export function toFormFields(raw: RawField[]): FormField[] {
  return raw.map((r, i) => ({
    id: `f${i + 1}`,
    selector: r.selector,
    label: r.label.slice(0, 500),
    type: r.type,
    required: r.required,
    ...(r.options.length ? { options: r.options } : {}),
    maxLength: r.maxLength,
    section: r.section,
    isEeo: r.isEeo,
  }))
}
