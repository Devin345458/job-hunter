import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { chownTree, demoPath, untrustedIdentity } from '../demo/exec'

// git for the repo cache. Every command runs without a shell, with an environment built from
// scratch (no global or system config, no hooks, no credential helper, no prompts), and in the
// container as an unprivileged user that owns only the cache. Nothing is ever checked out, so
// no file from a cloned repo is ever executed.
//
// The read token reaches git only as an environment-provided config entry
// (http.https://github.com/.extraheader), so it is never in argv (visible to every process), never
// in .git/config, and never in this module's error text. The remote URL is the plain https URL.

export interface GitResult {
  code: number | null
  timedOut: boolean
  /** Stopped because stdout passed maxBytes. */
  truncated: boolean
  stdout: string
  stderr: string
}

/** Root of the cache: one partial clone per repo at <dataDir>/repo-cache/<owner>/<name>. */
export function repoCacheRoot(): string {
  return dirname(dataPath('repo-cache', '.keep'))
}

export function repoCacheDir(fullName: string): string {
  const [owner, name] = fullName.split('/')
  if (!owner || !name || /[^\w.-]/.test(owner) || /[^\w.-]/.test(name) || owner.startsWith('.') || name.startsWith('.')) {
    throw new Error(`Not a GitHub repo name: ${fullName}`)
  }
  const root = repoCacheRoot()
  const dir = resolve(root, owner, name)
  if (!dir.startsWith(root + sep)) throw new Error(`Not a GitHub repo name: ${fullName}`)
  return dir
}

/** Delete one repo's clone (a repo switched off, or one the tokens lost). */
export function removeRepoCache(fullName: string) {
  const dir = repoCacheDir(fullName)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

let identity: { uid: number; gid: number } | null | undefined

/**
 * uid and gid git runs as, or null when the server is not root (local dev). Prefers its own user
 * (NUXT_REPO_UID, default 10002, created in the Dockerfile) so the demo builder's user, which runs
 * model-written code, can read neither the token in git's environment nor the cloned code. Falls
 * back to the demo user when the image has no repo user.
 */
export function repoIdentity(): { uid: number; gid: number } | null {
  if (identity !== undefined) return identity
  identity = null
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null
  const uid = Number(useRuntimeConfig().repoUid) || 10002
  try {
    const line = readFileSync('/etc/passwd', 'utf8').split('\n').find(l => l.split(':')[2] === String(uid))
    if (line) identity = { uid, gid: Number(line.split(':')[3]) }
  }
  catch {}
  if (!identity) {
    identity = untrustedIdentity()
    console.warn(`[repos] uid ${uid} does not exist, so git runs as the demo user${identity ? '' : ' (not sandboxed)'}`)
  }
  return identity
}

/** Make the cache directory, owned by the git user and closed to everyone else. Once per run. */
export function prepareRepoCache() {
  const root = repoCacheRoot()
  mkdirSync(join(root, '.home'), { recursive: true })
  const id = repoIdentity()
  if (id) chownTree(root, id)
  try {
    chmodSync(root, 0o700)
  }
  catch {}
}

function authHeader(token: string) {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
}

function gitEnv(token: string | null): Record<string, string> {
  const root = repoCacheRoot()
  const config: Array<[string, string]> = [
    ['safe.directory', '*'],
    ['core.hooksPath', '/dev/null'],
    ['core.fsmonitor', 'false'],
    ['credential.helper', ''],
    ['protocol.file.allow', 'never'],
    ['submodule.recurse', 'false'],
  ]
  if (token) config.push(['http.https://github.com/.extraheader', authHeader(token)])
  const env: Record<string, string> = {
    PATH: demoPath(),
    HOME: join(root, '.home'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_CONFIG_COUNT: String(config.length),
  }
  config.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k
    env[`GIT_CONFIG_VALUE_${i}`] = v
  })
  // Without a token there is nothing to fetch with, so a missing object fails instead of trying.
  if (!token) env.GIT_NO_LAZY_FETCH = '1'
  return env
}

/** Plain https remote. The token is never part of it. */
export function remoteUrl(fullName: string) {
  return `https://github.com/${fullName}.git`
}

export function runGit(args: string[], opts: { cwd: string; token?: string | null; input?: string; timeoutMs?: number; maxBytes?: number }): Promise<GitResult> {
  const id = repoIdentity()
  const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024
  return new Promise((done) => {
    const out: Buffer[] = []
    let outBytes = 0
    let err = ''
    let timedOut = false
    let truncated = false
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: gitEnv(opts.token ?? null),
      shell: false,
      detached: true,
      stdio: [opts.input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      ...(id ? { uid: id.uid, gid: id.gid } : {}),
    })
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      }
      catch {
        child.kill('SIGKILL')
      }
    }
    child.stdout!.on('data', (chunk: Buffer) => {
      if (truncated) return
      outBytes += chunk.length
      out.push(chunk)
      if (outBytes > maxBytes) {
        truncated = true
        kill()
      }
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      if (err.length < 20_000) err += chunk.toString('utf8')
    })
    if (opts.input != null) {
      child.stdin!.on('error', () => {})
      child.stdin!.end(opts.input)
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, opts.timeoutMs ?? 120_000)
    const finish = (code: number | null) => {
      clearTimeout(timer)
      done({ code, timedOut, truncated, stdout: Buffer.concat(out).toString('utf8'), stderr: err })
    }
    child.on('error', (e) => {
      err += `\n${e.message}`
      finish(null)
    })
    child.on('close', code => finish(code))
  })
}

/** stderr without git's partial clone notice, cut to one readable line or two. */
export function gitErrorText(r: GitResult): string {
  if (r.timedOut) return 'git timed out'
  const text = r.stderr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !/promisor remotes|Some objects may not be loaded/i.test(l))
    .join(' ')
  return (text || `git exited with ${r.code}`).slice(0, 400)
}

/** Run git and throw a plain error when it fails (or stopped early, unless that is allowed). */
export async function gitOk(args: string[], opts: Parameters<typeof runGit>[1] & { allowTruncated?: boolean }): Promise<string> {
  const r = await runGit(args, opts)
  if (r.truncated && opts.allowTruncated) return r.stdout
  if (r.code !== 0) throw new Error(`git ${args.find(a => !a.startsWith('-')) ?? args[0]} failed: ${gitErrorText(r)}`)
  return r.stdout
}
