import type { Frame } from 'playwright'
import type { FormField, FormFieldType } from '#shared/types/pipeline'
import { cleanFieldLabel } from '#shared/utils/plain-text'

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
  /** The field's instruction or description text beyond its label (FormField.description). */
  description: string | null
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
  // Status and helper nodes some ATS keep inside a label ("Analyzing resume...", "No location
  // found", spinners, error and success messages). They are not part of the question.
  const NOT_LABEL = '[role="status"], [role="alert"], [role="listbox"], [aria-live], [class*="status" i], [class*="helper" i], [class*="hint" i], [class*="loading" i], [class*="spinner" i], [class*="success" i], [class*="error" i], [class*="no-results" i], [class*="noresults" i], [class*="empty" i]'
  // A label element's own visible text, without those nodes. Falls back to all of its text when
  // that leaves nothing (a label hidden for screen readers only, for example).
  const labelText = (el: Element | null): string => {
    if (!el) return ''
    const parts: string[] = []
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement
      if (!parent) continue
      const skip = parent.closest(NOT_LABEL)
      if (skip && skip !== el && el.contains(skip)) continue
      if (!parent.getClientRects().length || getComputedStyle(parent).visibility === 'hidden') continue
      parts.push(node.textContent || '')
    }
    const own = parts.join(' ').replace(/\s+/g, ' ').trim()
    return own || textOf(el)
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
          if (t && !GENERIC.test(t) && t.length < 400) nearest = labelText(c)
        }
        if (nearest) return nearest
      }
    }
    return ''
  }
  const labelOf = (el: Element): string => {
    let t = labelText(labelElFor(el))
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

  // ── The field's own text beyond its label ──
  // A Lever card puts the instruction above a checkbox whose label is only the statement ("I have
  // marked the sender address above as safe"); Greenhouse and Ashby keep a question description
  // beside the label; others use aria-describedby or a paragraph right above the field. Read here
  // so the question Devin sees says what the label points at. Kept apart from the label, so label
  // matching (facts, dedupe keys, EEO) never reads it.
  const CONTROLS = 'input:not([type="hidden"]), select, textarea, [role="combobox"], [contenteditable="true"]'
  // Nodes whose text is never a description: controls and their options, buttons, headings (the
  // section line), status, error, and loading messages, upload drop zones, placeholders, and text
  // kept only for screen readers.
  const NOT_DESC = 'select, option, textarea, button, input, h1, h2, h3, h4, legend, [class*="section-title" i], [class*="sectionTitle"], [role="listbox"], [role="option"], [role="status"], [role="alert"], [role="log"], [aria-live], [class*="error" i], [class*="loading" i], [class*="spinner" i], [class*="success" i], [class*="dropzone" i], [class*="no-results" i], [class*="noresults" i], [class*="placeholder" i], [class*="a11y" i], [class*="visually-hidden" i], [class*="sr-only" i], [class*="counter" i]'
  // Cloudflare hides an address as "[email protected]" with the real one hex-encoded in
  // data-cfemail (the first byte is the key each later byte is XORed with). Chromium usually runs
  // the decoder before the read; this covers a page where it did not.
  const cfDecode = (hex: string): string => {
    if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2) return ''
    const key = parseInt(hex.slice(0, 2), 16)
    let s = ''
    for (let i = 2; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key)
    return /^[^\s@]+@[^\s@]+$/.test(s) ? s : ''
  }
  const cfHex = (el: Element): string => el.getAttribute('data-cfemail')
    || (/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/i.exec(el.getAttribute('href') || '')?.[1] ?? '')
  /**
   * Where a link in the text goes, written after its caption: "Applicant Privacy Statement
   * (https://...)" or "contact us (jobs@example.com)". Nothing when the caption already shows it,
   * or for a link within the page.
   */
  const linkTarget = (a: Element): string => {
    const raw = a.getAttribute('href') || ''
    if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw) || /\/cdn-cgi\/l\/email-protection/i.test(raw)) return ''
    const caption = clean(textOf(a)).toLowerCase()
    if (/^mailto:/i.test(raw)) {
      const address = decodeURIComponent(raw.replace(/^mailto:/i, '').split('?')[0] || '')
      return address && !caption.includes(address.toLowerCase()) ? `(${address})` : ''
    }
    const href = (a as HTMLAnchorElement).href || raw
    if (!/^https?:\/\//i.test(href)) return ''
    return caption.includes(href.toLowerCase().replace(/\/$/, '')) ? '' : `(${href})`
  }
  /** An element's visible text without the nodes in `skip` and NOT_DESC, with hidden addresses decoded and link targets kept. */
  const textWithout = (root: Element, skip: Element[]): string => {
    const parts: string[] = []
    const decoded = new Set<Element>()
    let openLink: Element | null = null
    const closeLink = () => {
      if (openLink) {
        const target = linkTarget(openLink)
        if (target) parts.push(target)
      }
      openLink = null
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement
      if (!parent) continue
      if (skip.some(s => s === parent || s.contains(parent))) continue
      const bad = parent.closest(NOT_DESC)
      if (bad && bad !== root && root.contains(bad)) continue
      const cf = parent.closest('[data-cfemail], a[href*="/cdn-cgi/l/email-protection"]')
      if (cf && root.contains(cf)) {
        closeLink()
        if (!decoded.has(cf)) {
          decoded.add(cf)
          const email = cfDecode(cfHex(cf))
          parts.push(email || (node.textContent || '').replace(/\[email\s*protected\]/i, ''))
        }
        continue
      }
      if (!parent.getClientRects().length || getComputedStyle(parent).visibility === 'hidden') continue
      const link = parent.closest('a[href]')
      const inLink = link && root.contains(link) ? link : null
      if (inLink !== openLink) {
        closeLink()
        openLink = inLink
      }
      parts.push(node.textContent || '')
    }
    closeLink()
    return parts.join(' ').replace(/\s+/g, ' ').replace(/\s+([.,;:!?)])/g, '$1').trim()
  }
  const norm = (s: string): string => clean(s).toLowerCase().replace(/[\s.:?!]+$/, '')
  /**
   * Text with the label cut off where it starts or ends it, then any option texts left at its
   * end. Never from the middle: "Please provide your GitHub username" keeps "GitHub" though the
   * label is "GitHub", and an option "No" never cuts into "now".
   */
  const without = (text: string, label: string, options: string[]): string => {
    let out = clean(text)
    const l = clean(label)
    if (l && out.toLowerCase().startsWith(l.toLowerCase())) out = out.slice(l.length)
    else if (l && out.toLowerCase().endsWith(l.toLowerCase())) out = out.slice(0, out.length - l.length)
    out = out.trim()
    const opts = options.map(o => clean(o)).filter(Boolean).sort((a, b) => b.length - a.length)
    for (let changed = true; changed && out;) {
      changed = false
      for (const o of opts) {
        if (out.length > o.length && out.toLowerCase().endsWith(o.toLowerCase()) && /[^A-Za-z0-9]$/.test(out.slice(0, out.length - o.length))) {
          out = out.slice(0, out.length - o.length).trim()
          changed = true
        }
      }
    }
    return out.replace(/^[\s|:.,;-]+/, '').trim()
  }
  /** At least two words with letters: drops "Required", "Select...", "0/500", a lone asterisk. */
  const saysSomething = (t: string): boolean => !GENERIC.test(t) && !/^(required|optional)$/i.test(t)
    && t.split(/\s+/).filter(w => /[a-z]{2,}/i.test(w)).length >= 2
  /** The largest ancestor that holds this field's controls and no other field's. */
  const ownBlock = (members: Element[]): Element | null => {
    let block: Element | null = null
    let cur: Element | null = members[0]?.parentElement ?? null
    for (let d = 0; cur && d < 12 && cur !== document.body && cur.tagName !== 'FORM'; d++, cur = cur.parentElement) {
      const foreign = Array.from(cur.querySelectorAll(CONTROLS)).some(c => !members.some(m => m === c || m.contains(c) || c.contains(m))
        && c.getAttribute('aria-hidden') !== 'true'
        && (visible(c) || c.getAttribute('type') === 'file'))
      if (foreign) break
      block = cur
    }
    return block
  }
  const descriptionOf = (members: Element[], label: string, options: string[]): string | null => {
    const parts: string[] = []
    const add = (raw: string) => {
      const t = without(raw, label, options)
      if (!t || !saysSomething(t)) return
      if (norm(label).includes(norm(t)) || parts.some(p => p.toLowerCase().includes(t.toLowerCase()))) return
      for (let i = parts.length - 1; i >= 0; i--) if (t.toLowerCase().includes(parts[i]!.toLowerCase())) parts.splice(i, 1)
      parts.push(t)
    }
    // 1. aria-describedby, minus error, placeholder, and status targets.
    for (const m of members) {
      for (const id of (m.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)) {
        if (/error|placeholder|live|status|count/i.test(id)) continue
        const n = document.getElementById(id)
        if (n && !members.includes(n)) add(textWithout(n, []))
      }
    }
    // 2. The field's own block, less its label elements and option labels.
    const labelEls: Element[] = []
    for (const m of members) {
      const l = labelElFor(m)
      if (l) labelEls.push(l)
      const wrap = m.closest('label')
      if (wrap) labelEls.push(wrap)
      for (const id of (m.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
        const n = document.getElementById(id)
        if (n) labelEls.push(n)
      }
    }
    const block = ownBlock(members)
    if (block) add(textWithout(block, [...members, ...labelEls]))
    // 3. Nothing yet: a paragraph directly above the field in the same group (no controls, not a heading).
    if (!parts.length && block) {
      const prev = block.previousElementSibling
      if (prev && visible(prev) && !prev.matches('h1, h2, h3, h4, h5, h6, legend, hr') && !prev.querySelector(`${CONTROLS}, h1, h2, h3, h4, legend`)) add(textWithout(prev, []))
    }
    const out = parts.join(' ').replace(/\s+/g, ' ').trim()
    return out ? out.slice(0, 1500) : null
  }

  const push = (f: Omit<RawField, 'description'>, members: Element[]) => {
    if (!f.selector || seen.has(f.selector)) return
    seen.add(f.selector)
    // The section and label decide EEO; the description never does (a consent box naming the
    // demographic survey is not a self-identification question).
    f.isEeo = EEO.test(`${f.label} ${f.section || ''}`) || /voluntary self|equal employment/i.test(f.section || '')
    let description: string | null = null
    if (f.type !== 'file') {
      try { description = descriptionOf(members, f.label, f.options) }
      catch { description = null }
    }
    out.push({ ...f, description })
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
        }, members)
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
        }, [el])
        continue
      }
      // A visually hidden checkbox whose label is visible is a styled checkbox.
      const lab = labelElFor(el) || el.closest('label')
      if (lab && visible(lab)) {
        const label = textOf(lab)
        push({ selector: selectorOf(el), label: clean(label), type: 'checkbox', required: requiredOf(el, label), options: [], maxLength: null, section: sectionOf(el), isEeo: false, control: 'native' }, [el])
      }
      continue
    }

    if (type === 'file') {
      const label = labelOf(el)
      const id = (el.getAttribute('id') || '') + (el.getAttribute('name') || '')
      // An unlabeled file input at the top of a form is the ATS's "autofill from resume" box.
      if (!id && !clean(textOf(labelElFor(el)))) continue
      const fileLabel = clean(label).replace(/\s+(attach|upload|choose|drop)\b.*$/i, '').trim() || clean(label)
      push({ selector: selectorOf(el), label: fileLabel, type: 'file', required: requiredOf(el, label), options: [], maxLength: null, section: sectionOf(el), isEeo: false, control: 'native' }, [el])
      continue
    }

    if (!visible(el)) continue
    if (el.getAttribute('aria-hidden') === 'true' || (el.getAttribute('tabindex') === '-1' && getComputedStyle(el).opacity === '0')) continue
    if (type === 'search' && role !== 'combobox') continue
    const label = labelOf(el)
    if (!clean(label)) continue

    if (role === 'combobox' && tag !== 'select') {
      push({ selector: selectorOf(el), label: clean(label), type: 'select', required: requiredOf(el, label), options: [], maxLength: null, section: sectionOf(el), isEeo: false, control: 'combobox' }, [el])
      continue
    }
    if (tag === 'select') {
      const opts = Array.from((el as HTMLSelectElement).options).map(o => clean(o.text)).filter(t => t && !/^(select|choose|please select|--)/i.test(t))
      push({ selector: selectorOf(el), label: clean(label), type: 'select', required: requiredOf(el, label), options: opts, maxLength: null, section: sectionOf(el), isEeo: false, control: 'native' }, [el])
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
    }, [el])
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

/**
 * A field's description as stored: whitespace collapsed, required markers dropped, at most 1,500
 * characters. Not cleanFieldLabel(): the employer's own sentences, addresses, and links stay as written.
 */
export function cleanFieldDescription(text: string | null | undefined, label = ''): string | null {
  const t = (text ?? '').replace(/[✱]+/g, ' ').replace(/\s\*+(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t || t.toLowerCase() === label.trim().toLowerCase()) return null
  return t.slice(0, 1500)
}

export function toFormFields(raw: RawField[]): FormField[] {
  return raw.map((r, i) => {
    const label = cleanFieldLabel(r.label).slice(0, 500)
    const description = cleanFieldDescription(r.description, label)
    return {
      id: `f${i + 1}`,
      selector: r.selector,
      label,
      type: r.type,
      required: r.required,
      ...(r.options.length ? { options: r.options } : {}),
      maxLength: r.maxLength,
      section: r.section,
      isEeo: r.isEeo,
      ...(description ? { description } : {}),
    }
  })
}
