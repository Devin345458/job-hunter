import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DemoPreview, DemoTestCase } from '#shared/types/pipeline'
import { confinedPath } from './exec'
import { previewBusy } from './progress'
import type { DemoRow } from './store'

// What a demo's preview is and where it lives. The builder (preview.ts) writes it; the
// detail API and the public /demo-preview route read it. Nothing here runs project code.
//
// A web demo's static build goes to <demo dir>/.preview, which is untracked (it is built
// after the commit) and wiped with the rest of the directory on a rebuild. The result of
// the last preview build or test run is cached next to the demo as <slug>.preview.json,
// beside the <slug>.card.json the builder already writes.

export const PREVIEW_DIR = '.preview'
/** Where vitest and jest write their JSON report inside the demo directory. Deleted after reading. */
export const TEST_REPORT_FILE = '.demo-test-report.json'

export interface PreviewRecord {
  kind: 'web' | 'tests'
  tool: string
  status: 'ready' | 'failed'
  builtAt: string
  error: string | null
  tests: DemoTestCase[] | null
}

export type TestRunner = 'vitest' | 'jest' | 'node-test' | 'go'

export interface ProjectShape {
  kind: 'web' | 'tests' | 'none'
  tool: string | null
  runner: TestRunner | null
  note: string | null
}

export function demoRoot(demo: Pick<DemoRow, 'localPath' | 'slug'>): string {
  return demo.localPath ? resolveStoredPath(demo.localPath) : join(dataDir(), 'demos', demo.slug)
}

// ── Token ───────────────────────────────────────────────────
// The preview URL is public so the model-written page never runs with Devin's session. The
// token in it is an HMAC of the demo id keyed with NUXT_SESSION_PASSWORD, so only someone
// the app showed the link to can open it.

export function previewToken(demoId: number): string | null {
  const secret = String(useRuntimeConfig().sessionPassword || '')
  if (secret.length < 16) return null
  return createHmac('sha256', secret).update(`demo-preview:${demoId}`).digest('base64url')
}

/** Constant-time check: both sides are hashed first so their lengths always match. */
export function previewTokenMatches(demoId: number, token: string): boolean {
  const expected = previewToken(demoId)
  if (!expected || !token) return false
  const digest = (v: string) => createHash('sha256').update(v).digest()
  return timingSafeEqual(digest(token), digest(expected))
}

/** Trailing slash on purpose: the build uses relative asset paths. */
export function previewUrl(demoId: number): string | null {
  const token = previewToken(demoId)
  return token ? `/demo-preview/${demoId}/${token}/` : null
}

// ── Reading files the model wrote ───────────────────────────
// The demo directory belongs to the unprivileged build user, and the code in it can create
// symlinks. Reads here refuse a symlink at the last step (O_NOFOLLOW) and anything whose
// real path leaves the directory (confinedPath), so a link to a server file reads as missing.

export function readInside(root: string, rel: string, maxBytes = 2_000_000): string | null {
  let full: string
  try {
    full = confinedPath(root, rel)
  }
  catch {
    return null
  }
  let fd: number | undefined
  try {
    fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW)
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > maxBytes) return null
    return readFileSync(fd, 'utf8')
  }
  catch {
    return null
  }
  finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function fileInside(root: string, rel: string): boolean {
  try {
    return lstatSync(confinedPath(root, rel)).isFile()
  }
  catch {
    return false
  }
}

// ── What kind of project it is ─────────────────────────────

const VITE_CONFIGS = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts']

export function projectShape(root: string): ProjectShape {
  if (!existsSync(root) || readdirSync(root).filter(n => n !== '.git').length === 0) {
    return { kind: 'none', tool: null, runner: null, note: 'Nothing on disk yet. The preview appears once a build passes.' }
  }
  let pkg: any = null
  try {
    pkg = JSON.parse(readInside(root, 'package.json', 200_000) ?? 'null')
  }
  catch {}
  const deps: Record<string, string> = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }
  const testScript = typeof pkg?.scripts?.test === 'string' ? pkg.scripts.test as string : ''
  const hasIndex = fileInside(root, 'index.html')
  const hasVite = !!deps.vite || VITE_CONFIGS.some(f => fileInside(root, f))

  let runner: TestRunner | null = null
  if (/\bvitest\b/.test(testScript)) runner = 'vitest'
  else if (/\bjest\b/.test(testScript)) runner = 'jest'
  else if (/(^|\s)--test(\s|$)/.test(testScript)) runner = 'node-test'
  else if (fileInside(root, 'go.mod')) runner = 'go'
  else if (deps.vitest) runner = 'vitest'
  else if (deps.jest) runner = 'jest'
  const runnerLabel = runner ? RUNNER_LABEL[runner] : null

  if (hasIndex && hasVite) return { kind: 'web', tool: 'vite', runner, note: null }
  if (runner) {
    return {
      kind: 'tests',
      tool: runnerLabel,
      runner,
      note: hasIndex
        ? 'It has an index.html but no Vite build to preview, so its tests show what it does.'
        : runner === 'go'
          ? 'No web interface (a Go program), so its tests show what it does.'
          : 'No web interface (a library), so its tests show what it does.',
    }
  }
  return { kind: 'none', tool: null, runner: null, note: 'No web interface, and no test runner the preview knows (Vitest, Jest, node --test, go test).' }
}

export const RUNNER_LABEL: Record<TestRunner, string> = {
  'vitest': 'vitest',
  'jest': 'jest',
  'node-test': 'node --test',
  'go': 'go test',
}

// ── Cached result ───────────────────────────────────────────

function recordPath(slug: string): string {
  return join(dataDir(), 'demos', `${slug}.preview.json`)
}

export function readPreviewRecord(demo: Pick<DemoRow, 'slug'>): PreviewRecord | null {
  try {
    return JSON.parse(readFileSync(recordPath(demo.slug), 'utf8')) as PreviewRecord
  }
  catch {
    return null
  }
}

export function writePreviewRecord(demo: Pick<DemoRow, 'slug'>, record: PreviewRecord) {
  writeFileSync(recordPath(demo.slug), JSON.stringify(record, null, 2))
}

export function clearPreviewRecord(demo: Pick<DemoRow, 'slug'>) {
  rmSync(recordPath(demo.slug), { force: true })
}

/** True when the built preview's index.html is on disk (a rebuild wipes it). */
export function previewBuilt(root: string): boolean {
  return fileInside(root, `${PREVIEW_DIR}/index.html`)
}

const HAS_CODE: DemoRow['status'][] = ['built', 'publishing', 'published']

/** The preview block of GET /api/demos/:id. */
export function previewView(demo: DemoRow): DemoPreview {
  // Building in the worker, or waiting in the job queue.
  const building = previewBusy(demo.id)
  const empty: DemoPreview = { kind: 'none', tool: null, status: building ? 'building' : 'missing', url: null, builtAt: null, error: null, tests: null, note: null }
  if (!HAS_CODE.includes(demo.status) && !building) return empty
  const root = demoRoot(demo)
  const record = readPreviewRecord(demo)
  const shape = record ? null : projectShape(root)
  const kind = record?.kind ?? shape!.kind
  if (kind === 'none') return { ...empty, note: shape?.note ?? null }
  const ready = record?.status === 'ready' && (record.kind !== 'web' || previewBuilt(root))
  return {
    kind,
    tool: record?.tool ?? shape?.tool ?? null,
    status: building ? 'building' : record ? (ready ? 'ready' : 'failed') : 'missing',
    url: kind === 'web' && ready ? previewUrl(demo.id) : null,
    builtAt: record?.builtAt ?? null,
    error: record?.status === 'failed' ? record.error : (record?.status === 'ready' && !ready ? 'The preview files are missing on disk. Build the preview again.' : record?.error ?? null),
    tests: record?.kind === 'tests' ? record.tests : null,
    note: kind === 'tests' ? (shape?.note ?? projectShape(root).note) : null,
  }
}
