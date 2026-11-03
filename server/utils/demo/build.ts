import { DEMOS_OFF_MESSAGE, demosEnabled } from './enabled'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { applications, demoProjects, jobs } from '../../db/schema'
import { AiBudgetExceeded, AiOutputTruncated, aiToolTurn } from '../ai'
import type { DemoFile, GapAnalysis, GapItem } from '#shared/types/pipeline'
import { attachDemoToResume } from './attach'
import { availableToolchains, clipOutput, confinedPath, demoEnv, git, primaryLanguage, runProcess, runUntrusted, type Toolchain } from './exec'
import { gapAnalysisIsStale, refreshGapAnalysis } from './gaps'
import { refreshPreview } from './preview'
import { clearPreviewRecord, PREVIEW_DIR } from './preview-state'
import { claimBuild, isDemoBuilding, noteBuildLine, noteBuildTurn, releaseBuild, setBuildPhase } from './progress'
import { countPassingTests, undash } from './resume-site'
import { isBudgetFailure } from './stop-reason'
import { demoCost, demoItem, demosForApplication, getAppWithJob, getDemo, githubRepoUrl, updateDemo, type DemoRow } from './store'

// Builds one demo project with a tool-use loop on Claude (aiToolTurn in ai.ts, so every turn
// is budget-checked, falls back to the fallback model, and is logged to ai_calls with
// ref demo/<id>). The model can only list, read, write, and delete files inside the demo
// directory and run an allowlisted set of programs there. The harness, not the model,
// re-runs the tests, writes the git history, and decides whether the build passed.

// ── Limits ──────────────────────────────────────────────────

export interface BuildLimits {
  maxTurns: number
  maxMs: number
  maxCostUsd: number
}

export function buildLimits(): BuildLimits {
  const c = useRuntimeConfig()
  return {
    maxTurns: Math.max(5, Number(c.demoMaxTurns) || 80),
    maxMs: Math.max(2, Number(c.demoMaxMinutes) || 25) * 60_000,
    maxCostUsd: Math.max(0.1, Number(c.demoMaxCostUsd) || 3),
  }
}

const MAX_FILES = 80
const MAX_FILE_BYTES = 200_000
const MAX_TOTAL_BYTES = 1_500_000
const RESULT_CHARS = 6000
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'vendor', 'dist', 'coverage', '.cache', PREVIEW_DIR])

const NPM_SUBCOMMANDS = new Set(['install', 'i', 'ci', 'test', 't', 'run', 'run-script', 'ls', 'init', 'pkg'])
const GO_SUBCOMMANDS = new Set(['build', 'test', 'vet', 'run', 'fmt', 'mod', 'version', 'env', 'list', 'doc'])

/** Throws when a command is not one the builder may run. Returns the argv to execute. */
export function vetCommand(argv: string[], root: string): string[] {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(a => typeof a !== 'string')) throw new Error('argv must be a non-empty array of strings')
  const [bin, ...args] = argv
  switch (bin) {
    case 'node':
      return argv
    case 'npm': {
      const sub = args.find(a => !a.startsWith('-'))
      if (!sub || !NPM_SUBCOMMANDS.has(sub)) throw new Error(`npm ${sub ?? ''} is not allowed. Allowed: ${[...NPM_SUBCOMMANDS].join(', ')}`)
      if (args.some(a => a === '-g' || a === '--global' || a.startsWith('--prefix') || a.startsWith('--registry') || a.startsWith('--userconfig'))) {
        throw new Error('global installs and registry or config overrides are not allowed')
      }
      return argv
    }
    case 'npx': {
      const pkg = args.find(a => !a.startsWith('-'))
      if (!pkg || !existsSync(join(root, 'node_modules', '.bin', pkg))) {
        throw new Error('npx only runs binaries already installed in node_modules/.bin. Add the package to devDependencies and run npm install first.')
      }
      // Only the binary and its own arguments, after "--": npm would otherwise read options it knows
      // (--json, --loglevel, --package) as its own, and the model's npx options are not needed.
      return ['npx', '--no', '--', ...args.slice(args.indexOf(pkg))]
    }
    case 'go': {
      const sub = args[0]
      if (!sub || !GO_SUBCOMMANDS.has(sub)) throw new Error(`go ${sub ?? ''} is not allowed. Allowed: ${[...GO_SUBCOMMANDS].join(', ')}`)
      if (sub === 'env' && args.includes('-w')) throw new Error('go env -w is not allowed')
      return argv
    }
    case 'gofmt':
      return argv
    default:
      throw new Error(`${bin} is not allowed. Allowed programs: node, npm, npx (installed binaries only), go, gofmt. The harness handles git.`)
  }
}

// ── File helpers ────────────────────────────────────────────

export function listProjectFiles(root: string): DemoFile[] {
  const out: DemoFile[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (IGNORED_DIRS.has(name)) continue
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (st.isFile()) out.push({ path: relative(root, full), bytes: st.size })
    }
  }
  if (existsSync(root)) walk(root)
  return out
}

function isTestFile(path: string) {
  return /(^|\/)(test|tests|__tests__)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /_test\.go$/.test(path)
}

/** Fails a test run that exited 0 but ran nothing. */
function testsActuallyRan(output: string): boolean {
  if (/^#\s*tests\s+0\b/m.test(output) || /No test files found|No tests found/i.test(output)) return false
  if (/\[no test files\]/.test(output) && !/^ok\s/m.test(output)) return false
  return true
}

// ── Tools ───────────────────────────────────────────────────

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'list_files',
    description: 'List files in the project (node_modules and .git are hidden), with sizes in bytes.',
    input_schema: { type: 'object', properties: { dir: { type: 'string', description: 'Subdirectory relative to the project root. Omit for the whole project.' } }, additionalProperties: false },
  },
  {
    name: 'read_file',
    description: 'Read a text file from the project. Long files come back trimmed.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the full content given. Parent directories are created. Keep each file under 200 KB.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the project.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'run',
    description: 'Run one program without a shell (no pipes, redirects, &&, or globs) and return its exit code and output. Allowed: node, npm (install, ci, test, run, ls, init, pkg), npx (binaries already in node_modules/.bin), go (build, test, vet, run, fmt, mod, version, env, list, doc), gofmt.',
    input_schema: {
      type: 'object',
      properties: {
        argv: { type: 'array', items: { type: 'string' }, description: 'Program and arguments, e.g. ["go", "test", "./..."]' },
        cwd: { type: 'string', description: 'Directory relative to the project root. Omit for the root.' },
        timeout_seconds: { type: 'number', description: 'Default 180, maximum 600.' },
      },
      required: ['argv'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description: 'Call once the project is complete and its tests pass. The harness reruns test_command in a clean process; if it fails you get the output back and keep working.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Two short sentences, under 280 characters, for a resume and a portfolio card: what the project does and how. Plain American English, no dashes, no adjectives like production-grade or comprehensive, no claims about the author.' },
        highlights: {
          type: 'array',
          description: 'Two facts about the code worth showing, each a short bold title and one plain sentence.',
          items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' } }, required: ['title', 'detail'], additionalProperties: false },
        },
        tech_stack: { type: 'array', items: { type: 'string' }, description: 'Language first, then libraries and tools actually used.' },
        test_command: { type: 'array', items: { type: 'string' }, description: 'argv that runs the full test suite from the project root, e.g. ["go", "test", "-v", "./..."] or ["npm", "test"].' },
      },
      required: ['summary', 'highlights', 'tech_stack', 'test_command'],
      additionalProperties: false,
    },
  },
]

const FinishSchema = z.object({
  summary: z.string().min(20),
  highlights: z.array(z.object({ title: z.string(), detail: z.string() })).max(4),
  tech_stack: z.array(z.string()).min(1),
  test_command: z.array(z.string()).min(1),
})

function systemPrompt(owner: string, repoName: string, toolchains: Toolchain[]) {
  return `You build a small, real, working software project from an empty directory, using only the tools provided. A senior web developer will publish it on GitHub under his own name and must be able to explain every line in an interview. Keep it small, idiomatic, and easy to read.

Environment
- Toolchains: ${toolchains.map(t => t.version).join('; ')}.
- Paths are relative to the project root. Commands run without a shell in the project root unless you pass cwd.
- The network is available only so package managers can install dependencies. The project and its tests must run offline: no external APIs, accounts, API keys, or database servers. Use in-memory storage, local files, or test doubles.
- Keep tool output small. Do not print whole files or long logs.

Requirements
- Real working code, not stubs, placeholders, or TODOs. Aim for about the hours of focused work the brief states: a few hundred lines of source plus tests.
- Tests that exercise the real behavior: the main path, edge cases, and error handling.
- README.md: what the project does, the design choices and why, how to run it, how to run the tests, and the file layout. Plain American English. Do not use em dashes or en dashes; use colons, commas, or separate sentences. No emojis. No badges.
- Do not mention any employer, job posting, or the author's background, experience, or employment. Do not invent usage numbers, benchmarks, or claims about production use. Do not call the project production-grade, production-ready, enterprise-grade, battle-tested, robust, or comprehensive. Do not put counts (tests, lines, files) in the README.
- Idiomatic code a reviewer in that language would accept: check every error, close what you open, keep functions small, and guard shared state (Go HTTP handlers run concurrently, so a map they share needs a sync.Mutex or sync.RWMutex).
- A .gitignore suited to the stack.
- Go: standard library only (for example net/http, net/http/httptest, encoding/json, crypto/hmac, testing). go.mod declares module github.com/${owner}/${repoName} and the Go version of the toolchain above. Run gofmt -l . and go vet ./... before finishing. Test command: go test -v ./...
- JavaScript or TypeScript: ES modules. Prefer zero runtime dependencies. For JavaScript use the built-in test runner (node --test). For TypeScript, add typescript and tsx as devDependencies and run tests with tsx --test. package.json must have a "test" script, and package-lock.json must be committed after npm install.

How to work
1. Plan the files briefly, then write them with write_file.
2. Install dependencies if there are any, run the tests with run, and fix failures.
3. As soon as the tests pass (and for Go, gofmt -l . prints nothing and go vet ./... passes), call finish. Do not re-read files or rerun passing checks to double check. Do not call finish before the tests pass.`
}

function briefMessage(item: GapItem, job: { title: string; company: string }) {
  const idea = item.demoIdea!
  return `Build this project.

Title: ${idea.title}
What it is: ${idea.summary}
Stack: ${idea.stack.join(', ')}
Scope: about ${idea.scopeHours} hours of focused work.
Skill it should show clearly: ${item.requirement}

(Background for you only, never put it in the project: the developer is applying to a ${job.title} role and wants a public example of this skill.)`
}

// ── One build ───────────────────────────────────────────────
// Which demos are building, and what each build is doing, lives in progress.ts so the API can
// read it without importing the builder.

export function kebab(text: string, max = 40): string {
  const s = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return (s.slice(0, max).replace(/-+$/g, '') || 'demo')
}

/** Insert the demo row for a gap item. Directory slug carries the application id; the repo name does not. */
export function createDemo(applicationId: number, item: GapItem): DemoRow {
  const row = getAppWithJob(applicationId)
  if (!row) throw new Error(`Application ${applicationId} not found`)
  if (!item.demoIdea) throw new Error('Gap item has no demo idea')
  const db = useDb()
  const base = kebab(item.demoIdea.title)
  // A discarded demo was never published, so its repo name is free again. Slugs stay unique (directories stay on disk).
  const rows = db.select({ repoName: demoProjects.repoName, slug: demoProjects.slug, status: demoProjects.status }).from(demoProjects).all()
  const taken = new Set(rows.flatMap(r => [r.status === 'discarded' ? null : r.repoName, r.slug]).filter(Boolean))
  let repoName = base
  for (let n = 2; taken.has(repoName); n++) repoName = `${base}-${n}`
  let slug = `${repoName}-a${applicationId}`
  for (let n = 2; taken.has(slug) || existsSync(join(dataDir(), 'demos', slug)); n++) slug = `${repoName}-a${applicationId}-${n}`
  return db.insert(demoProjects).values({
    applicationId,
    jobId: row.job.id,
    slug,
    title: item.demoIdea.title,
    summary: item.demoIdea.summary,
    gapAddressed: item.requirement,
    techStackJson: JSON.stringify(item.demoIdea.stack),
    status: 'proposed',
    repoName,
  }).returning().get()
}

type Finished = { summary: string; highlights: Array<{ title: string; detail: string }>; techStack: string[]; testCommand: string[]; testOutput: string }

interface ToolOutcome {
  content: string
  isError: boolean
  finished?: Finished
  /** The first finish whose tests passed, answered with the self-review checklist. */
  passedBeforeReview?: Finished
}

const HYPE = /\b(production[- ](?:grade|ready|quality)|enterprise[- ](?:grade|ready)|battle[- ]tested|comprehensive|robust|world[- ]class|blazing(?:ly)?[- ]fast|cutting[- ]edge|state[- ]of[- ]the[- ]art|seamless(?:ly)?)\b/gi

/** Words and characters the public README and the resume summary may not contain. */
export function claimProblems(text: string): string[] {
  const problems = [...new Set((text.match(HYPE) ?? []).map(w => w.toLowerCase()))].map(w => `"${w}"`)
  if (/[\u2013\u2014]/.test(text)) problems.push('em or en dashes')
  return problems
}

const REVIEW_CHECKLIST = `Tests pass. Before the build is accepted, review your own code once against this checklist, reading the files you need:
1. Shared state: any map, slice, or counter that more than one request can touch is guarded (Go serves each HTTP request on its own goroutine, so use sync.Mutex or sync.RWMutex).
2. Every error is checked or deliberately ignored with a comment, and everything opened is closed.
3. The README matches the code: commands, file layout, and behavior. No counts, no claims about production use.
4. No leftover scratch files, debug prints, or commented-out code.
Fix anything that fails, rerun the tests, then call finish again. If everything already holds, call finish again unchanged.`

interface BuildState {
  reviewed: boolean
}

async function runTool(root: string, block: Anthropic.Beta.BetaToolUseBlock, log: (line: string) => void, state: BuildState): Promise<ToolOutcome> {
  const input = (block.input ?? {}) as Record<string, any>
  try {
    switch (block.name) {
      case 'list_files': {
        const dir = input.dir ? confinedPath(root, String(input.dir)) : root
        const files = listProjectFiles(dir)
        log(`list_files ${input.dir ?? '.'} (${files.length})`)
        return { content: files.length ? files.map(f => `${relative(root, join(dir, f.path))} (${f.bytes} B)`).join('\n') : '(empty)', isError: false }
      }
      case 'read_file': {
        const path = confinedPath(root, String(input.path))
        if (!existsSync(path)) throw new Error(`${input.path} does not exist`)
        log(`read_file ${input.path}`)
        return { content: clipOutput(readFileSync(path, 'utf8'), 12_000), isError: false }
      }
      case 'write_file': {
        const path = confinedPath(root, String(input.path))
        const content = String(input.content ?? '')
        const rel = relative(root, path)
        if (rel.split('/').some(p => IGNORED_DIRS.has(p))) throw new Error(`${rel} is inside a generated directory`)
        const bytes = Buffer.byteLength(content)
        if (bytes > MAX_FILE_BYTES) throw new Error(`File is ${bytes} bytes; the limit is ${MAX_FILE_BYTES}. Split it.`)
        const files = listProjectFiles(root)
        const existing = files.find(f => f.path === rel)
        if (!existing && files.length >= MAX_FILES) throw new Error(`The project already has ${MAX_FILES} files`)
        const total = files.reduce((s, f) => s + f.bytes, 0) - (existing?.bytes ?? 0) + bytes
        if (total > MAX_TOTAL_BYTES) throw new Error('The project would exceed 1.5 MB of source')
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, content)
        log(`write_file ${rel} (${bytes} B)`)
        return { content: `Wrote ${rel} (${bytes} bytes).`, isError: false }
      }
      case 'delete_file': {
        const path = confinedPath(root, String(input.path))
        if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${input.path} is not a file`)
        unlinkSync(path)
        log(`delete_file ${input.path}`)
        return { content: `Deleted ${input.path}.`, isError: false }
      }
      case 'run': {
        const cwd = input.cwd ? confinedPath(root, String(input.cwd)) : root
        const argv = vetCommand(input.argv, root)
        const timeoutMs = Math.min(600, Math.max(5, Number(input.timeout_seconds) || 180)) * 1000
        const res = await runUntrusted(argv, { root, cwd, env: demoEnv(), timeoutMs })
        log(`run ${JSON.stringify(input.argv)} -> ${res.timedOut ? 'timed out' : `exit ${res.code}`} (${(res.durationMs / 1000).toFixed(1)}s)`)
        const head = res.timedOut ? `Timed out after ${timeoutMs / 1000}s.` : `Exit code ${res.code}.`
        return { content: `${head}\n${clipOutput(res.output.trim(), RESULT_CHARS) || '(no output)'}`, isError: res.code !== 0 }
      }
      case 'finish': {
        const parsed = FinishSchema.safeParse(input)
        if (!parsed.success) throw new Error(`finish input is invalid: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
        const f = parsed.data
        const files = listProjectFiles(root)
        if (!files.some(x => x.path.toLowerCase() === 'readme.md')) throw new Error('README.md is missing at the project root')
        if (!files.some(x => isTestFile(x.path))) throw new Error('No test files found (expected *_test.go, *.test.js, *.test.ts, or a test/ directory)')
        const readme = readFileSync(join(root, files.find(x => x.path.toLowerCase() === 'readme.md')!.path), 'utf8')
        const problems = [...new Set([...claimProblems(readme), ...claimProblems(f.summary), ...f.highlights.flatMap(h => claimProblems(`${h.title} ${h.detail}`))])]
        if (problems.length) {
          log(`finish: rejected wording ${problems.join(', ')}`)
          return { content: `The README, summary, or highlights use wording that cannot be published: ${problems.join(', ')}. Describe what the code does in plain words instead, then call finish again.`, isError: true }
        }
        const argv = vetCommand(f.test_command, root)
        log(`finish: harness runs ${JSON.stringify(f.test_command)}`)
        const res = await runUntrusted(argv, { root, cwd: root, env: demoEnv(), timeoutMs: 600_000 })
        const output = res.output.trim()
        log(`finish: tests ${res.timedOut ? 'timed out' : `exit ${res.code}`} (${(res.durationMs / 1000).toFixed(1)}s)`)
        if (res.code !== 0 || res.timedOut) {
          return { content: `The harness ran ${f.test_command.join(' ')} and it failed (${res.timedOut ? 'timed out' : `exit ${res.code}`}). Fix it and call finish again.\n${clipOutput(output, RESULT_CHARS)}`, isError: true }
        }
        if (!testsActuallyRan(output)) {
          return { content: `The test command exited 0 but no tests ran. Make sure the tests are found by ${f.test_command.join(' ')}.\n${clipOutput(output, RESULT_CHARS)}`, isError: true }
        }
        if (!state.reviewed) {
          state.reviewed = true
          log('finish: tests pass, asking for one self-review before accepting')
          return {
            content: REVIEW_CHECKLIST,
            isError: false,
            passedBeforeReview: { summary: f.summary, highlights: f.highlights, techStack: f.tech_stack, testCommand: f.test_command, testOutput: output },
          }
        }
        return {
          content: 'Tests pass. The build is complete.',
          isError: false,
          finished: { summary: f.summary, highlights: f.highlights, techStack: f.tech_stack, testCommand: f.test_command, testOutput: output },
        }
      }
      default:
        throw new Error(`Unknown tool ${block.name}`)
    }
  }
  catch (e: any) {
    log(`${block.name} error: ${e?.message || e}`)
    return { content: `Error: ${e?.message || String(e)}`, isError: true }
  }
}

const GITIGNORE: Record<string, string> = {
  go: '# Binaries\n/bin/\n*.exe\n*.test\n*.out\n\n# Editors\n.idea/\n.vscode/\n.DS_Store\n',
  node: 'node_modules/\ncoverage/\ndist/\n*.log\n.env\n.DS_Store\n',
}

/**
 * For POST /api/demos/:id/rebuild: builds one demo in the background and records the build in
 * pipeline_runs as demos:rebuild (trigger manual), with the demo and how the build ended, so the
 * run log explains a build started from the demo page. withRun calls buildDemo before its first
 * await, so isDemoBuilding() is true once this returns, as the route relies on.
 */
export function startRebuild(demoId: number): void {
  void withRun('demos:rebuild', 'manual', async (log) => {
    const done = await buildDemo(demoId, log)
    const cost = Number(demoCost(demoId).toFixed(4))
    const built = done.status === 'built'
    const budgetStopped = !built && isBudgetFailure(done.error)
    return {
      built: built ? 1 : 0,
      failed: !built && !budgetStopped ? 1 : 0,
      budgetStopped,
      costUsd: cost,
      ...(!built && done.error ? { errors: [done.error] } : {}),
      demos: [{ id: done.id, applicationId: done.applicationId, slug: done.slug, title: done.title, status: done.status, costUsd: cost }],
    }
  }, { lockKey: `demos:rebuild#${demoId}` })
}

/**
 * Build one demo. Returns the final row; never throws for a build failure (the row is
 * marked failed with the reason), only for programming errors before the build starts.
 * Everything up to the first await runs synchronously, so a caller that does not await it
 * (POST /api/demos/:id/rebuild) can rely on isDemoBuilding() being true once it returns.
 */
export async function buildDemo(demoId: number, runLog: (msg: string) => void = () => {}): Promise<DemoRow> {
  const demo = getDemo(demoId)
  if (!demo) throw new Error(`Demo ${demoId} not found`)
  if (isDemoBuilding(demoId)) throw new Error(`Demo ${demoId} is already building`)
  const row = getAppWithJob(demo.applicationId)
  if (!row) throw new Error(`Application ${demo.applicationId} not found`)
  const gap = parseJson<GapAnalysis | null>(row.app.gapAnalysisJson, null)
  const item: GapItem = gap?.items.find(i => i.decision === 'demo' && i.requirement === demo.gapAddressed && i.demoIdea)
    ?? { requirement: demo.gapAddressed ?? demo.title, mustHave: false, decision: 'demo', rationale: '', demoIdea: { title: demo.title, summary: demo.summary ?? '', stack: parseJson<string[]>(demo.techStackJson, []), scopeHours: 4 } }

  const limits = buildLimits()
  if (!claimBuild(demoId, limits.maxTurns)) throw new Error(`Demo ${demoId} is already building`)
  const started = Date.now()
  const lines: string[] = []
  const log = (line: string) => {
    const t = ((Date.now() - started) / 1000).toFixed(0).padStart(4, ' ')
    lines.push(`[${t}s] ${line}`)
    noteBuildLine(demoId, line)
    runLog(`demo ${demoId}: ${line}`)
  }
  const root = join(dataDir(), 'demos', demo.slug)
  const fail = (reason: string): DemoRow => {
    log(`FAILED: ${reason}`)
    updateDemo(demoId, { status: 'failed', error: reason, buildLog: clipOutput(lines.join('\n'), 60_000), costUsd: demoCost(demoId), filesJson: JSON.stringify(listProjectFiles(root)) })
    return getDemo(demoId)!
  }

  try {
    const { name, contact } = candidateContact()
    if (!contact.email) return fail('The knowledge base has no profile Email, which the demo commits need')
    const toolchains = await availableToolchains()
    const lang = primaryLanguage(item.demoIdea!.stack)
    if (!toolchains.some(t => t.languages.includes(lang))) return fail(`No ${lang} toolchain on this server (found: ${toolchains.map(t => t.id).join(', ') || 'none'})`)

    // Fresh directory. A previous failed attempt for this row is replaced.
    if (!root.startsWith(join(dataDir(), 'demos') + '/')) throw new Error('demo path escaped the demos directory')
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    clearPreviewRecord(demo)
    updateDemo(demoId, { status: 'building', localPath: root, error: null, testsPassed: null, testOutput: null, builtAt: null })
    log(`building "${demo.title}" in ${relative(dataDir(), root)} with limits ${limits.maxTurns} turns, ${limits.maxMs / 60_000} min, $${limits.maxCostUsd}`)

    const owner = useRuntimeConfig().githubOwner || 'Devin345458'
    const system = systemPrompt(owner, demo.repoName!, toolchains)
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: [{ type: 'text', text: briefMessage(item, row.job) }] }]
    const model = useRuntimeConfig().demoModel || undefined
    let finished: Finished | null = null
    // Tests passed and the self-review was asked for. If a limit or a Claude failure ends the
    // loop during the review, the build is still accepted once its tests pass again.
    let passing: Finished | null = null
    /** Why the loop ended early; the caller adds whether the tests had passed. */
    let stop: { reason: string; suffix: boolean } | null = null
    let idleTurns = 0
    let truncations = 0
    const state: BuildState = { reviewed: false }

    for (let turn = 1; turn <= limits.maxTurns && !finished; turn++) {
      noteBuildTurn(demoId, turn)
      if (Date.now() - started > limits.maxMs) {
        stop = { reason: `Stopped at the ${limits.maxMs / 60_000} minute limit`, suffix: true }
        break
      }
      const spent = demoCost(demoId)
      if (spent >= limits.maxCostUsd) {
        stop = { reason: `Stopped at the $${limits.maxCostUsd} per-build limit ($${spent.toFixed(2)} spent)`, suffix: true }
        break
      }

      let response: Anthropic.Beta.BetaMessage
      try {
        response = await aiToolTurn({ purpose: 'demo_build', system, messages, tools: TOOLS, maxTokens: 16000, effort: 'medium', ref: { type: 'demo', id: demoId }, model })
      }
      catch (e: any) {
        if (e instanceof AiOutputTruncated && truncations < 2) {
          truncations++
          log(`turn ${turn}: reply cut off at the output limit, asking for smaller steps`)
          messages.push({ role: 'user', content: [{ type: 'text', text: 'Your last reply was cut off because it was too long, so none of its tool calls ran. Write one or two files per reply and keep each file focused.' }] })
          continue
        }
        stop = e instanceof AiBudgetExceeded
          ? { reason: `Waiting for Claude: ${e.message} The next run retries this demo.`, suffix: false }
          : { reason: `Claude call failed on turn ${turn}: ${e?.message || e}`, suffix: false }
        break
      }
      log(`turn ${turn}: ${response.model}, ${response.usage.input_tokens} in + ${response.usage.cache_read_input_tokens ?? 0} cached + ${response.usage.output_tokens} out, stop ${response.stop_reason}`)
      for (const b of response.content) if (b.type === 'text' && b.text.trim()) log(`  note: ${b.text.trim().replace(/\s+/g, ' ').slice(0, 300)}`)
      messages.push({ role: 'assistant', content: response.content as any })

      const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      if (calls.length === 0) {
        if (++idleTurns >= 3) {
          stop = { reason: 'The model stopped calling tools three times without finishing', suffix: false }
          break
        }
        messages.push({ role: 'user', content: [{ type: 'text', text: 'Keep going with the tools. Call finish once the tests pass.' }] })
        continue
      }
      idleTurns = 0
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
      for (const call of calls) {
        const outcome = await runTool(root, call, line => log(`  ${line}`), state)
        if (outcome.finished && !finished) finished = outcome.finished
        if (outcome.passedBeforeReview && !passing) passing = outcome.passedBeforeReview
        results.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) })
      }
      messages.push({ role: 'user', content: results })
    }
    stop ??= finished ? null : { reason: `Stopped at the ${limits.maxTurns} turn limit`, suffix: true }
    if (!finished && passing && stop) {
      log(`${stop.reason} during the self-review, after the tests had passed. Rerunning ${JSON.stringify(passing.testCommand)} before accepting the build.`)
      const res = await runUntrusted(vetCommand(passing.testCommand, root), { root, cwd: root, env: demoEnv(), timeoutMs: 600_000 })
      const output = res.output.trim()
      log(`self-review cut short: tests ${res.timedOut ? 'timed out' : `exit ${res.code}`} (${(res.durationMs / 1000).toFixed(1)}s)`)
      if (res.code === 0 && !res.timedOut && testsActuallyRan(output)) finished = { ...passing, testOutput: output }
      else return fail(`${stop.reason} during the self-review, and the tests no longer pass`)
    }
    if (!finished) return fail(`${stop!.reason}${stop!.suffix ? ' before the tests passed' : ''}`)

    // ── Harness: git history authored as Devin ──
    const stackLang = primaryLanguage(finished.techStack.length ? finished.techStack : item.demoIdea!.stack)
    if (!existsSync(join(root, '.gitignore'))) writeFileSync(join(root, '.gitignore'), stackLang === 'go' ? GITIGNORE.go! : GITIGNORE.node!)
    const author = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: contact.email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: contact.email }
    await git(['init', '-q', '-b', 'main'], root)
    await git(['add', '-A'], root)
    await git(['commit', '-q', '-m', `Initial commit: ${undash(finished.summary.split(/(?<=\.)\s/)[0]!).slice(0, 120)}`], root, author)
    const sha = await git(['rev-parse', '--short', 'HEAD'], root)
    const tracked = (await git(['ls-files', '-z'], root)).split('\0').filter(Boolean)
    const files: DemoFile[] = tracked.map(p => ({ path: p, bytes: statSync(join(root, p)).size }))
    log(`committed ${sha} as ${name} <${contact.email}>: ${files.length} files`)
    const readmePath = files.find(f => f.path.toLowerCase() === 'readme.md')?.path
    const testCount = countPassingTests(finished.testOutput)

    updateDemo(demoId, {
      status: 'built',
      summary: undash(finished.summary),
      techStackJson: JSON.stringify(finished.techStack),
      filesJson: JSON.stringify(files),
      readme: readmePath ? readFileSync(join(root, readmePath), 'utf8') : null,
      testCommand: finished.testCommand.join(' '),
      testOutput: clipOutput(finished.testOutput, 20_000),
      testsPassed: true,
      builtAt: nowSql(),
      error: null,
    })
    log(`built: ${testCount ?? 'unknown number of'} tests passing, $${demoCost(demoId).toFixed(4)} spent`)
    writeFileSync(join(dataDir(), 'demos', `${demo.slug}.card.json`), JSON.stringify({ highlights: finished.highlights, testCount }, null, 2))

    try {
      const attached = await attachDemoToResume(demoId)
      log(attached.updated
        ? `added to the tailored resume as ${githubRepoUrl(demo.repoName!)} and regenerated ${relative(dataDir(), attached.pdfPath!)}`
        : `resume not updated: ${attached.reason}`)
    }
    catch (e: any) {
      log(`resume update failed: ${e?.message || e}`)
    }

    // ── Harness: preview, after the commit so its files are never part of the repo ──
    setBuildPhase(demoId, 'preview')
    try {
      await refreshPreview(demoId, log)
    }
    catch (e: any) {
      log(`preview: error: ${e?.message || e}`)
    }
    updateDemo(demoId, { buildLog: clipOutput(lines.join('\n'), 60_000), costUsd: demoCost(demoId) })
    return getDemo(demoId)!
  }
  catch (e: any) {
    return fail(e?.message || String(e))
  }
  finally {
    releaseBuild(demoId)
  }
}

/** Highlights and test count saved next to the repo at build time, for the resume site card. */
export function readCardFacts(demo: DemoRow): { highlights: Array<{ title: string; detail: string }>; testCount: number | null } {
  try {
    return JSON.parse(readFileSync(join(dataDir(), 'demos', `${demo.slug}.card.json`), 'utf8'))
  }
  catch {
    return { highlights: [], testCount: countPassingTests(demo.testOutput ?? '') }
  }
}

// ── The demos:build task body ───────────────────────────────

export interface DemoRunOptions {
  /** Only this application. Also allows rebuilding after a failed demo. */
  applicationId?: number
  /** Builds per run; defaults to NUXT_DEMO_MAX_PER_RUN. */
  max?: number
  retryFailed?: boolean
}

export async function runDemoBuilds(opts: DemoRunOptions, log: (msg: string) => void) {
  const db = useDb()
  if (!demosEnabled()) {
    log(DEMOS_OFF_MESSAGE)
    return { candidates: 0, analyzed: 0, recommended: 0, built: 0, failed: 0, skipped: 0, interrupted: 0, budgetStopped: false, costUsd: 0, demos: [], note: DEMOS_OFF_MESSAGE }
  }
  const max = Math.max(0, Number(opts.max ?? useRuntimeConfig().demoMaxPerRun) || 1)

  // A demo left in building by a server restart is not building anymore.
  const stuck = db.select().from(demoProjects).where(eq(demoProjects.status, 'building')).all().filter(d => !isDemoBuilding(d.id))
  for (const d of stuck) updateDemo(d.id, { status: 'failed', error: 'The build was interrupted (the server restarted while it ran)' })

  const apps = db.select({ app: applications, job: jobs })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .where(opts.applicationId
      ? and(eq(applications.id, opts.applicationId), inArray(applications.status, ['proposed', 'needs_input']))
      : inArray(applications.status, ['proposed', 'needs_input']))
    .orderBy(desc(jobs.matchScore))
    .all()

  const stats = { candidates: apps.length, analyzed: 0, recommended: 0, built: 0, failed: 0, skipped: 0, interrupted: stuck.length, budgetStopped: false, costUsd: 0, demos: [] as Array<{ id: number; applicationId: number; slug: string; title: string; status: string; costUsd: number }> }
  const queue: Array<{ applicationId: number; item: GapItem; retry: boolean }> = []
  for (const { app } of apps) {
    let gap = parseJson<GapAnalysis | null>(app.gapAnalysisJson, null)
    if ((!gap || gapAnalysisIsStale(gap)) && stats.analyzed < 20) {
      try {
        log(`application ${app.id}: ${gap ? 'refreshing' : 'running'} gap analysis`)
        gap = await refreshGapAnalysis(app.id)
        stats.analyzed++
      }
      catch (e: any) {
        log(`application ${app.id}: gap analysis failed: ${e?.message || e}`)
        if (e instanceof AiBudgetExceeded) { stats.budgetStopped = true; break }
        continue
      }
    }
    const item = demoItem(gap)
    if (!item) continue
    stats.recommended++
    const existing = demosForApplication(app.id)
    const active = existing.find(d => ['building', 'built', 'publishing', 'published'].includes(d.status))
    // A demo that failed only because Claude was out of credit or over the daily budget is
    // retried automatically; any other failure waits for a manual retry.
    const failedBefore = existing.find(d => d.status === 'failed' && !isBudgetFailure(d.error))
    if (active || (failedBefore && !opts.retryFailed && !opts.applicationId)) {
      stats.skipped++
      continue
    }
    // A build stopped by the account (credit, key, budget) was promised a retry: it goes first.
    const retry = existing.some(d => d.status === 'failed' && isBudgetFailure(d.error))
    queue.push({ applicationId: app.id, item, retry })
  }
  // Stable: retries first, then the rest by match score as the query ordered them.
  queue.sort((a, b) => Number(b.retry) - Number(a.retry))

  for (const { applicationId, item } of queue.slice(0, max)) {
    // Reuse a failed (or never started) row so the history stays on one demo.
    const reuse = demosForApplication(applicationId).find(d => (d.status === 'failed' || d.status === 'proposed') && d.gapAddressed === item.requirement)
    const demo = reuse ?? createDemo(applicationId, item)
    log(`application ${applicationId}: building demo ${demo.id} "${demo.title}"`)
    const done = await buildDemo(demo.id, log)
    if (done.status === 'built') stats.built++
    else if (isBudgetFailure(done.error)) stats.budgetStopped = true
    else stats.failed++
    const cost = demoCost(demo.id)
    stats.costUsd += cost
    stats.demos.push({ id: demo.id, applicationId, slug: done.slug, title: done.title, status: done.status, costUsd: Number(cost.toFixed(4)) })
    if (stats.budgetStopped) break
  }
  stats.skipped += Math.max(0, queue.length - max)
  stats.costUsd = Number(stats.costUsd.toFixed(4))
  return stats
}
