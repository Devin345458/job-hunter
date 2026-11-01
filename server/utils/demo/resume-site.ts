// Adds a demo project card to the resume site's "Selected work" grid (index.html of the
// resume repo). The card copies the markup of the existing case-study cards: case-type,
// a linked h3, case-desc, the tech list, and a Key Outcomes column. Outcomes are facts about
// the code only (what it does, the passing test suite, where the source lives).

export interface ResumeCard {
  repoName: string
  title: string
  summary: string
  techStack: string[]
  repoUrl: string
  highlights: Array<{ title: string; detail: string }>
  testCount: number | null
  testCommand: string | null
}

const CHECK_ICON = '<svg class="outcome-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>'

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Model-written text goes on a public page under Devin's name: no em or en dashes. */
export function undash(text: string): string {
  return text
    .replace(/(\d)\s*[–—]\s*(\d)/g, '$1 to $2')
    .replace(/\s*[–—]\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
}

function marker(repoName: string) {
  return `<!-- Demo project: ${repoName} (added by job-hunter) -->`
}

export function renderCaseCard(card: ResumeCard): string {
  const url = escapeHtml(card.repoUrl)
  const shortUrl = escapeHtml(card.repoUrl.replace(/^https?:\/\//, '').replace(/^file:\/\//, ''))
  const outcome = (inner: string) => [
    '          <div class="outcome-item">',
    `            ${CHECK_ICON}`,
    `            <div class="outcome-text">${inner}</div>`,
    '          </div>',
  ].join('\n')
  const outcomes = [
    ...card.highlights.slice(0, 2).map(h => outcome(`<strong>${escapeHtml(undash(h.title))}</strong>${h.detail ? `: ${escapeHtml(undash(h.detail))}` : ''}`)),
    outcome(card.testCount
      ? `<strong>${card.testCount} automated tests</strong>${card.testCommand ? ` run with <code>${escapeHtml(card.testCommand)}</code>` : ''}`
      : `<strong>Automated test suite</strong>${card.testCommand ? ` run with <code>${escapeHtml(card.testCommand)}</code>` : ''}`),
    outcome(`<strong>Open source</strong>: <a href="${url}" target="_blank" rel="noopener" style="color: var(--accent-primary); text-decoration: none;">${shortUrl} &rarr;</a>`),
  ]
  return [
    `      ${marker(card.repoName)}`,
    `      <div class="case-card reveal" data-demo-repo="${escapeHtml(card.repoName)}">`,
    '        <div class="case-meta">',
    '          <div class="case-type">Open Source Demo</div>',
    `          <h3><a href="${url}" target="_blank" rel="noopener" style="color: inherit; text-decoration: none; border-bottom: 2px solid var(--accent-primary); transition: color 0.2s;">${escapeHtml(undash(card.title))}</a></h3>`,
    `          <p class="case-desc">${escapeHtml(undash(card.summary))}</p>`,
    '          <div class="case-tech-list">',
    ...card.techStack.slice(0, 7).map(t => `            <span class="case-tech-item">${escapeHtml(undash(t))}</span>`),
    '          </div>',
    '        </div>',
    '        <div class="case-outcomes">',
    '          <h4>Key Outcomes</h4>',
    ...outcomes,
    '        </div>',
    '      </div>',
  ].join('\n')
}

/**
 * Insert the card as the last item of the cases-grid div. Idempotent: a page that already
 * has this repo's card is returned unchanged.
 */
export function insertCaseCard(html: string, card: ResumeCard): { html: string; changed: boolean } {
  if (html.includes(marker(card.repoName)) || html.includes(`data-demo-repo="${escapeHtml(card.repoName)}"`)) {
    return { html, changed: false }
  }
  const open = /<div\s+class="cases-grid"\s*>/.exec(html)
  if (!open) throw new Error('The resume page has no <div class="cases-grid">, so the demo card has nowhere to go')
  const tag = /<div\b[^>]*>|<\/div\s*>/gi
  tag.lastIndex = open.index + open[0].length
  let depth = 1
  let match: RegExpExecArray | null
  let closeAt = -1
  while ((match = tag.exec(html))) {
    depth += match[0].startsWith('</') ? -1 : 1
    if (depth === 0) {
      closeAt = match.index
      break
    }
  }
  if (closeAt < 0) throw new Error('The resume page\'s cases-grid div is not closed')
  const lineStart = html.lastIndexOf('\n', closeAt - 1) + 1
  const before = html.slice(0, lineStart)
  const lead = /\n\s*\n$/.test(before) ? '' : '\n'
  return { html: `${before}${lead}${renderCaseCard(card)}\n\n${html.slice(lineStart)}`, changed: true }
}

/** Count of passing tests in common runner output, or null when the output does not say. */
export function countPassingTests(output: string): number | null {
  const node = /^#\s*pass\s+(\d+)/m.exec(output) || /^ℹ\s*pass\s+(\d+)/m.exec(output)
  if (node) return Number(node[1])
  const jest = /Tests:\s+(?:\d+\s+\w+,\s+)*(\d+)\s+passed/.exec(output)
  if (jest) return Number(jest[1])
  const vitest = /Tests\s+(\d+)\s+passed/.exec(output)
  if (vitest) return Number(vitest[1])
  const goPass = output.match(/^\s*--- PASS: /gm)
  if (goPass?.length) {
    // Count top-level tests only; subtests are indented further.
    const top = output.match(/^--- PASS: /gm)
    return (top?.length || goPass.length)
  }
  return null
}

/**
 * Stand-in for the resume repo when no seed is configured: the same section, grid, and card
 * markup as the real site, with one placeholder card, so the sandbox publish exercises the
 * same insertion code.
 */
export const SANDBOX_RESUME_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sandbox resume site</title>
<style>
  :root { --bg-primary: #0b0d12; --bg-card: #141821; --text-primary: #e8eaf0; --text-secondary: #9aa3b5; --accent-primary: #4f8cff; --border: #262c3a; }
  body { margin: 0; background: var(--bg-primary); color: var(--text-primary); font-family: system-ui, sans-serif; }
  .container { max-width: 1100px; margin: 0 auto; padding: 4rem 1.5rem; }
  .cases-grid { display: grid; gap: 1.5rem; }
  .case-card { display: grid; grid-template-columns: 1.3fr 1fr; gap: 2.5rem; background: var(--bg-card); border: 1px solid var(--border); border-radius: 14px; padding: 2rem; }
  .case-type { font-size: 0.8rem; color: var(--accent-primary); text-transform: uppercase; letter-spacing: 0.08em; }
  .case-desc { color: var(--text-secondary); line-height: 1.6; }
  .case-tech-list { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .case-tech-item { font-size: 0.8rem; border: 1px solid var(--border); border-radius: 6px; padding: 0.2rem 0.6rem; }
  .outcome-item { display: flex; gap: 0.75rem; margin-bottom: 0.9rem; }
  .outcome-icon { width: 18px; height: 18px; flex-shrink: 0; color: var(--accent-primary); }
  .outcome-text { color: var(--text-secondary); line-height: 1.5; }
  @media (max-width: 760px) { .case-card { grid-template-columns: 1fr; gap: 2rem; } }
</style>
</head>
<body>
<!-- CASE STUDIES -->
<section class="case-studies" id="work">
  <div class="container">
    <span class="section-label reveal">Case Studies</span>
    <h2 class="section-title reveal">Selected work.</h2>

    <div class="cases-grid">

      <!-- Placeholder card -->
      <div class="case-card reveal">
        <div class="case-meta">
          <div class="case-type">Sandbox Placeholder</div>
          <h3>Placeholder Project</h3>
          <p class="case-desc">Stand-in for the real resume site's existing cards.</p>
          <div class="case-tech-list">
            <span class="case-tech-item">HTML</span>
          </div>
        </div>
        <div class="case-outcomes">
          <h4>Key Outcomes</h4>
          <div class="outcome-item">
            ${CHECK_ICON}
            <div class="outcome-text"><strong>Placeholder</strong></div>
          </div>
        </div>
      </div>

    </div>
  </div>
</section>
</body>
</html>
`
