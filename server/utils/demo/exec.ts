import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'

// Process helpers for the demo builder and publisher. Every command runs without a shell,
// in a working directory confined to one demo project, with an environment built from
// scratch: the server's own environment holds the Anthropic key and the GitHub token, so
// it is never passed to a child process.

export interface RunResult {
  code: number | null
  signal: string | null
  timedOut: boolean
  durationMs: number
  /** stdout and stderr interleaved, trimmed to the head and tail when long. */
  output: string
}

const MAX_CAPTURE = 400_000

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.3)
  const tail = max - head
  return `${text.slice(0, head)}\n\n[... ${text.length - max} characters omitted ...]\n\n${text.slice(-tail)}`
}

export function clipOutput(text: string, max = 6000) {
  return clip(text, max)
}

/** Extra PATH entries from NUXT_DEMO_TOOL_PATH, then the node binary's directory, then the server PATH. */
export function demoPath(): string {
  const extra = String(useRuntimeConfig().demoToolPath || '').split(/[:;]/).map(s => s.trim()).filter(Boolean)
  const parts = [...extra, dirname(process.execPath), '/usr/local/go/bin', ...(process.env.PATH || '').split(delimiter)]
  return [...new Set(parts.filter(Boolean))].join(delimiter)
}

/** Environment for commands inside a demo project. Caches live under the data directory. */
export function demoEnv(): Record<string, string> {
  const cache = (name: string) => {
    const dir = dataPath('demo-cache', name, '.keep')
    return dirname(dir)
  }
  return {
    PATH: demoPath(),
    HOME: cache('home'),
    TMPDIR: cache('tmp'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    CI: 'true',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    npm_config_cache: cache('npm'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_loglevel: 'warn',
    GOPATH: cache('gopath'),
    GOCACHE: cache('gocache'),
    GOMODCACHE: join(cache('gopath'), 'pkg', 'mod'),
    GOTOOLCHAIN: 'local',
    GOFLAGS: '-buildvcs=false',
  }
}

/** Environment for git: no global or system config (signing, hooks, credential helpers). */
export function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...demoEnv(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  }
}

export function runProcess(argv: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<RunResult> {
  const started = Date.now()
  return new Promise((resolvePromise) => {
    let output = ''
    let timedOut = false
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.length > MAX_CAPTURE) output = output.slice(0, 40_000) + '\n[... trimmed ...]\n' + output.slice(-(MAX_CAPTURE - 60_000))
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      }
      catch {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, opts.timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolvePromise({ code: null, signal: null, timedOut, durationMs: Date.now() - started, output: `${output}\n${e.message}`.trim() })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ code, signal, timedOut, durationMs: Date.now() - started, output })
    })
  })
}

/** git with a clean config. Throws with the output when git exits non-zero. */
export async function git(args: string[], cwd: string, extraEnv: Record<string, string> = {}, timeoutMs = 120_000): Promise<string> {
  const res = await runProcess(['git', ...args], { cwd, env: gitEnv(extraEnv), timeoutMs })
  if (res.code !== 0) {
    throw new Error(`git ${args[0]} failed (${res.timedOut ? 'timed out' : `exit ${res.code}`}): ${clip(res.output.trim(), 1500)}`)
  }
  return res.output.trim()
}

/**
 * Resolve a model-supplied relative path inside root. Rejects absolute paths, parent
 * traversal, the .git directory, and symlinks that point outside root.
 */
export function confinedPath(root: string, rel: string): string {
  if (!rel || typeof rel !== 'string') throw new Error('path is required')
  if (isAbsolute(rel) || rel.includes('\0')) throw new Error('path must be relative to the project root')
  const full = resolve(root, normalize(rel))
  const fromRoot = relative(root, full)
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new Error('path must stay inside the project root')
  const parts = fromRoot.split(/[\\/]/)
  if (parts[0] === '.git') throw new Error('the .git directory is managed by the build harness')
  // Walk up to the nearest existing ancestor and make sure it really is inside root.
  let probe = full
  while (!existsSync(probe) && probe !== root) probe = dirname(probe)
  const realRoot = realpathSync(root)
  const realProbe = realpathSync(probe)
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + '/')) throw new Error('path resolves outside the project root')
  return full
}

export function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true })
  return dir
}

// ── Toolchains ──────────────────────────────────────────────

export interface Toolchain {
  id: 'node' | 'go'
  /** Languages a demo can be written in with this toolchain. */
  languages: string[]
  version: string
}

let toolchainCache: { at: number; list: Toolchain[] } | null = null

/** Toolchains a demo build can use on this server, detected once every ten minutes. */
export async function availableToolchains(): Promise<Toolchain[]> {
  if (toolchainCache && Date.now() - toolchainCache.at < 10 * 60_000) return toolchainCache.list
  const env = demoEnv()
  const cwd = env.TMPDIR!
  const list: Toolchain[] = []
  const node = await runProcess(['node', '--version'], { cwd, env, timeoutMs: 15_000 })
  const npm = await runProcess(['npm', '--version'], { cwd, env, timeoutMs: 30_000 })
  if (node.code === 0 && npm.code === 0) {
    list.push({ id: 'node', languages: ['javascript', 'typescript'], version: `node ${node.output.trim()}, npm ${npm.output.trim()}` })
  }
  const go = await runProcess(['go', 'version'], { cwd, env, timeoutMs: 15_000 })
  if (go.code === 0) list.push({ id: 'go', languages: ['go'], version: go.output.trim() })
  toolchainCache = { at: Date.now(), list }
  return list
}

/** Language a demo stack is written in, judged from its stack list. */
export function primaryLanguage(stack: string[]): string {
  const s = stack.map(x => x.toLowerCase())
  if (s.some(x => x === 'go' || x === 'golang' || x.startsWith('go ') || x.startsWith('go('))) return 'go'
  if (s.some(x => x.includes('typescript'))) return 'typescript'
  if (s.some(x => x.includes('javascript') || x.includes('node') || x.includes('express') || x.includes('vue'))) return 'javascript'
  if (s.some(x => x.includes('python'))) return 'python'
  if (s.some(x => x.includes('rust'))) return 'rust'
  if (s.some(x => x.includes('java') || x.includes('kotlin'))) return 'java'
  if (s.some(x => x.includes('php') || x.includes('laravel'))) return 'php'
  return 'other'
}
