import { existsSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { DemoTestCase } from '#shared/types/pipeline'
import { clipOutput, demoEnv, runUntrusted, type RunResult } from './exec'
import { claimPreview, notePreviewLine, releasePreview } from './progress'
import { demoRoot, PREVIEW_DIR, projectShape, readInside, RUNNER_LABEL, TEST_REPORT_FILE, writePreviewRecord, type PreviewRecord, type ProjectShape, type TestRunner } from './preview-state'
import { appendBuildLog, getDemo } from './store'

// Shows what a built demo does without publishing it. A demo with a web UI (index.html plus
// Vite) gets a static build with relative asset paths in <demo dir>/.preview, served by the
// public, sandboxed /demo-preview route. A demo without one gets its own test runner run once
// with a machine-readable reporter, and the test list is cached for the detail page.
//
// Every command here runs project code, so all of it goes through runUntrusted: the same
// unprivileged user, clean environment, and time limits as the build itself. No Claude calls.

const INSTALL_MS = 600_000
const BUILD_MS = 300_000
const TEST_MS = 600_000

/**
 * Rewrites root-absolute references to files from public/ (for example "/photos/a.svg" in
 * a JSON data file) to "./photos/a.svg" in the built .js and .html files. Vite only rewrites
 * the URLs it processes, and under /demo-preview/<id>/<token>/ a root path would leave the
 * preview. Runs as the build user with node -e; process.argv[1] is the output directory.
 */
const REWRITE_PUBLIC_PATHS = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const out = process.argv[1];
const names = fs.existsSync('public') ? fs.readdirSync('public').filter(n => n !== 'assets' && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(n)) : [];
if (!names.length) { console.log('no public files to rewrite'); process.exit(0); }
const alt = names.map(n => n.split('.').join('\\.')).join('|');
const re = new RegExp('(["\'\x60])/(' + alt + ')(?=[/"\'\x60?#])', 'g');
let changed = 0;
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { walk(p); continue; }
    if (!/\.(m?js|html)$/.test(name)) continue;
    const text = fs.readFileSync(p, 'utf8');
    const next = text.replace(re, '$1./$2');
    if (next !== text) { fs.writeFileSync(p, next); changed++; }
  }
};
walk(out);
console.log('rewrote root paths to public files in ' + changed + ' file(s)');
`

function seconds(res: RunResult) {
  return `${(res.durationMs / 1000).toFixed(1)}s`
}

function outcome(res: RunResult) {
  return res.timedOut ? 'timed out' : `exit ${res.code}`
}

/** The last few meaningful output lines, for an error message. */
function tail(output: string, lines = 4): string {
  return output.split('\n').map(l => l.trim()).filter(Boolean).slice(-lines).join(' | ').slice(0, 600)
}

interface Runner {
  run: (argv: string[], timeoutMs: number, extraEnv?: Record<string, string>, label?: string) => Promise<RunResult>
  /** npm ci (or npm install without a lockfile). Only once per preview. */
  install: () => Promise<RunResult | null>
  installed: () => boolean
}

function runnerFor(root: string, log: (line: string) => void): Runner {
  let installed = false
  const run = async (argv: string[], timeoutMs: number, extraEnv: Record<string, string> = {}, label?: string) => {
    const res = await runUntrusted(argv, { root, cwd: root, env: { ...demoEnv(), ...extraEnv }, timeoutMs })
    log(`preview: ${label ?? `${argv.slice(0, 4).join(' ')}${argv.length > 4 ? ' ...' : ''}`} -> ${outcome(res)} (${seconds(res)})`)
    return res
  }
  return {
    run,
    installed: () => installed,
    install: async () => {
      if (installed || !existsSync(join(root, 'package.json'))) return null
      installed = true
      const argv = existsSync(join(root, 'package-lock.json')) ? ['npm', 'ci', '--no-audit', '--no-fund'] : ['npm', 'install', '--no-audit', '--no-fund']
      return run(argv, INSTALL_MS)
    },
  }
}

// ── Web preview ─────────────────────────────────────────────

async function buildWebPreview(root: string, r: Runner, log: (line: string) => void): Promise<PreviewRecord> {
  const base = { kind: 'web' as const, tool: 'vite', builtAt: new Date().toISOString(), tests: null }
  if (!existsSync(join(root, 'node_modules'))) {
    const res = await r.install()
    if (res && res.code !== 0) return { ...base, status: 'failed', error: `Installing dependencies failed (${outcome(res)}): ${tail(res.output)}` }
  }
  const argv = ['npx', '--no', 'vite', 'build', '--base', './', '--outDir', PREVIEW_DIR, '--emptyOutDir', '--logLevel', 'warn']
  let res = await r.run(argv, BUILD_MS)
  if (res.code !== 0 && !r.installed()) {
    // node_modules can come from another platform (a copied data volume) or be incomplete.
    log('preview: vite build failed; reinstalling dependencies and trying once more')
    const inst = await r.install()
    if (inst && inst.code === 0) res = await r.run(argv, BUILD_MS)
  }
  if (res.code !== 0) return { ...base, status: 'failed', error: `vite build failed (${outcome(res)}): ${tail(res.output)}` }
  if (readInside(root, `${PREVIEW_DIR}/index.html`, 5_000_000) == null) {
    return { ...base, status: 'failed', error: 'vite build finished but wrote no index.html' }
  }
  const fix = await r.run(['node', '-e', REWRITE_PUBLIC_PATHS, PREVIEW_DIR], 60_000, {}, 'rewrite paths to public files')
  log(`preview: ${tail(fix.output, 1)}`)
  if (fix.code !== 0) return { ...base, status: 'failed', error: `Fixing paths to public files failed: ${tail(fix.output)}` }
  return { ...base, status: 'ready', error: null }
}

// ── Test list for demos without a UI ────────────────────────

function caseStatus(s: unknown): DemoTestCase['status'] {
  if (s === 'passed' || s === 'pass') return 'passed'
  if (s === 'failed' || s === 'fail') return 'failed'
  return 'skipped'
}

/** Vitest's json reporter and jest --json write the same shape. */
export function parseJestJson(text: string, root: string): DemoTestCase[] {
  const report = JSON.parse(text)
  const cases: DemoTestCase[] = []
  for (const file of report?.testResults ?? []) {
    const fileName = typeof file?.name === 'string' ? relative(root, file.name) : null
    for (const t of file?.assertionResults ?? []) {
      const ancestors = Array.isArray(t?.ancestorTitles) ? t.ancestorTitles.filter(Boolean) : []
      cases.push({
        name: String(t?.title ?? t?.fullName ?? 'unnamed test'),
        suite: ancestors.length ? ancestors.join(' > ') : fileName,
        status: caseStatus(t?.status),
        durationMs: typeof t?.duration === 'number' ? Math.round(t.duration) : null,
      })
    }
  }
  return cases
}

/**
 * Node's test runner TAP output (node --test and tsx --test). Nested "# Subtest:" lines
 * name the describe blocks; only tests without subtests are listed.
 */
export function parseNodeTap(output: string): DemoTestCase[] {
  const cases: DemoTestCase[] = []
  const stack: Array<{ name: string; indent: number; children: number }> = []
  const lines = output.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const sub = /^(\s*)# Subtest: (.*)$/.exec(line)
    if (sub) {
      stack.push({ name: sub[2]!.trim(), indent: sub[1]!.length, children: 0 })
      continue
    }
    const res = /^(\s*)(not ok|ok) \d+ - (.*?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/i.exec(line)
    if (!res) continue
    const indent = res[1]!.length
    while (stack.length && stack[stack.length - 1]!.indent > indent) stack.pop()
    const own = stack.length && stack[stack.length - 1]!.indent === indent ? stack.pop()! : null
    if (stack.length) stack[stack.length - 1]!.children++
    if (own && own.children > 0) continue // a describe block or a test with subtests
    let durationMs: number | null = null
    for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
      const d = /^\s*duration_ms:\s*([\d.]+)/.exec(lines[j]!)
      if (d) { durationMs = Math.round(Number(d[1])); break }
      if (/^\s*\.\.\.\s*$/.test(lines[j]!)) break
    }
    cases.push({
      name: res[3]!.trim(),
      suite: stack.length ? stack.map(s => s.name).join(' > ') : null,
      status: res[4] ? 'skipped' : res[2]!.toLowerCase() === 'ok' ? 'passed' : 'failed',
      durationMs,
    })
  }
  return cases
}

/** go test -json: one event per line; subtests are listed, their parents are not. */
export function parseGoJson(output: string): DemoTestCase[] {
  const results = new Map<string, DemoTestCase>()
  for (const line of output.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const ev = JSON.parse(line)
      if (!ev?.Test || !['pass', 'fail', 'skip'].includes(ev.Action)) continue
      const pkg = typeof ev.Package === 'string' ? ev.Package.split('/').pop() : null
      results.set(`${ev.Package}::${ev.Test}`, {
        name: String(ev.Test),
        suite: pkg,
        status: caseStatus(ev.Action),
        durationMs: typeof ev.Elapsed === 'number' ? Math.round(ev.Elapsed * 1000) : null,
      })
    }
    catch {}
  }
  const all = [...results.values()]
  return all.filter(c => !all.some(o => o.suite === c.suite && o.name.startsWith(`${c.name}/`)))
}

async function runTestList(root: string, runner: TestRunner, r: Runner): Promise<PreviewRecord> {
  const tool = RUNNER_LABEL[runner]
  const base = { kind: 'tests' as const, tool, builtAt: new Date().toISOString() }
  const node = runner !== 'go'
  if (node && !existsSync(join(root, 'node_modules'))) {
    const res = await r.install()
    if (res && res.code !== 0) return { ...base, status: 'failed', tests: null, error: `Installing dependencies failed (${outcome(res)}): ${tail(res.output)}` }
  }

  const once = async (): Promise<{ res: RunResult; cases: DemoTestCase[]; parseError: string | null }> => {
    rmSync(join(root, TEST_REPORT_FILE), { force: true })
    let res: RunResult
    if (runner === 'vitest') res = await r.run(['npx', '--no', 'vitest', 'run', '--reporter=json', `--outputFile=${TEST_REPORT_FILE}`], TEST_MS)
    else if (runner === 'jest') res = await r.run(['npx', '--no', 'jest', '--json', `--outputFile=${TEST_REPORT_FILE}`], TEST_MS)
    else if (runner === 'node-test') res = await r.run(['npm', 'test'], TEST_MS, { NODE_OPTIONS: '--test-reporter=tap --test-reporter-destination=stdout' })
    else res = await r.run(['go', 'test', '-json', './...'], TEST_MS)
    let cases: DemoTestCase[] = []
    let parseError: string | null = null
    try {
      if (runner === 'vitest' || runner === 'jest') {
        const text = readInside(root, TEST_REPORT_FILE, 20_000_000)
        rmSync(join(root, TEST_REPORT_FILE), { force: true })
        if (text == null) parseError = `${tool} wrote no JSON report`
        else cases = parseJestJson(text, root)
      }
      else if (runner === 'node-test') cases = parseNodeTap(res.output)
      else cases = parseGoJson(res.output)
    }
    catch {
      // The report is model-influenced output; never echo it into the error.
      parseError = `${tool} wrote a report that could not be read`
    }
    return { res, cases, parseError }
  }

  let run = await once()
  if (run.cases.length === 0 && node && !r.installed()) {
    const inst = await r.install()
    if (inst && inst.code === 0) run = await once()
  }
  const { res, cases, parseError } = run
  if (cases.length === 0) {
    return { ...base, status: 'failed', tests: null, error: parseError ?? `${tool} reported no tests (${outcome(res)}): ${tail(res.output)}` }
  }
  const failed = cases.filter(c => c.status === 'failed').length
  return { ...base, status: 'ready', tests: cases, error: failed ? `${failed} of ${cases.length} tests failed in this run` : null }
}

// ── Entry points ────────────────────────────────────────────

/**
 * Build the preview (or the test list) for one demo and cache the result. Throws when one is
 * already running. Returns null when the project has nothing to preview.
 */
export async function refreshPreview(demoId: number, log: (line: string) => void = () => {}): Promise<{ shape: ProjectShape; record: PreviewRecord | null }> {
  const demo = getDemo(demoId)
  if (!demo) throw new Error(`Demo ${demoId} not found`)
  if (!claimPreview(demoId)) throw new Error(`The preview for demo ${demoId} is already building`)
  const outer = log
  log = (line: string) => {
    notePreviewLine(demoId, line)
    outer(line)
  }
  try {
    const root = demoRoot(demo)
    const shape = projectShape(root)
    if (shape.kind === 'none') {
      log(`preview: none (${shape.note})`)
      return { shape, record: null }
    }
    const r = runnerFor(root, log)
    const record = shape.kind === 'web' ? await buildWebPreview(root, r, log) : await runTestList(root, shape.runner!, r)
    writePreviewRecord(demo, record)
    log(record.status === 'ready'
      ? `preview: ${record.kind === 'web' ? 'web preview built with vite' : `${record.tests!.length} tests listed with ${record.tool}`}${record.error ? ` (${record.error})` : ''}`
      : `preview: failed: ${record.error}`)
    return { shape, record }
  }
  finally {
    releasePreview(demoId)
  }
}

/** For POST /api/demos/:id/preview: claims the preview now (so a second click gets a 409), builds in the background. */
export function startPreview(demoId: number): void {
  const lines: string[] = []
  const done = refreshPreview(demoId, line => lines.push(line))
  done
    .then(() => appendBuildLog(demoId, clipOutput(lines.join('\n'), 4000)))
    .catch((e: any) => {
      lines.push(`preview: error: ${e?.message || e}`)
      appendBuildLog(demoId, clipOutput(lines.join('\n'), 4000))
      console.error(`[demos] preview for demo ${demoId} failed:`, e)
    })
}
