import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Options, SDKMessage, SDKUserMessage, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { chownTree } from './demo/exec'
import { dataDir } from './paths'
import type { Effort, UsageCounts } from './model'

// The agent backend: one Claude call run as one Claude Agent SDK query on Devin's personal Claude
// subscription. The SDK starts the Claude Code binary as a child process; this module decides
// what that process sees:
// - auth: NUXT_CLAUDE_CODE_OAUTH_TOKEN, only as CLAUDE_CODE_OAUTH_TOKEN in the child's
//   environment. The environment is an allowlist, so nothing else of the server's reaches it
//   (no API key, no ANTHROPIC_BASE_URL, no GitHub tokens, no session password).
// - no tools (tools: []), no MCP servers, no settings, skills, or CLAUDE.md from any ~/.claude or
//   project (settingSources: [], HOME and CLAUDE_CONFIG_DIR under dataDir()/agent), no session
//   files, and a throwaway working directory per call, deleted afterward.
// - in the container (server running as root) the process runs as its own unprivileged user
//   (NUXT_AGENT_UID, default 10003), so neither demo builds (10001) nor git (10002) can read the
//   token from its environment.
// - at most NUXT_AGENT_CONCURRENCY processes at once in this server; calls Devin started go
//   before background calls when they wait for a slot.
// It returns what happened (answer, limit, auth failure, ...); ai.ts logs it, keeps the
// subscription pause, and throws the app's errors.

export type AgentFailure = 'limit' | 'auth' | 'timeout' | 'model' | 'refusal' | 'truncated' | 'schema' | 'error'

export interface AgentRunInput {
  purpose: string
  model: string
  /** The step's system prompt, joined. */
  system: string
  /** The prompt: a string, or text blocks from cachedPrompt(). */
  prompt: string | Array<{ type: string; text?: string; cache_control?: unknown }>
  /** JSON Schema (draft-07) for structured output; absent for a text answer. */
  jsonSchema?: Record<string, unknown>
  effort?: Effort
  /** Whether the model accepts an effort setting. */
  effortSupported?: boolean
  maxTokens?: number
  /** A call Devin is waiting on (chat, drafts, Apply preparation): goes first for a free slot. */
  foreground: boolean
  /** Adaptive thinking (agentThinking(purpose)); off sends thinking disabled. */
  thinking?: boolean
  timeoutMs?: number
}

export interface AgentUsage extends UsageCounts {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

interface AgentRunBase {
  model: string
  usage: AgentUsage | null
  /** The SDK's own estimate of what the call would cost on the API (result.total_cost_usd). */
  estCostUsd: number
  durationMs: number
  /** Milliseconds from spawning the process to its first message. */
  startupMs: number | null
}

export type AgentRunResult =
  | (AgentRunBase & { ok: true; structured: unknown; text: string })
  | (AgentRunBase & { ok: false; kind: AgentFailure; message: string; resetsAtMs: number | null; limitKind: string | null })

export const AGENT_TIMEOUT_MS = 10 * 60_000

// ── Tests and measurement only ──────────────────────────────

type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => AsyncIterable<SDKMessage> & { close?: () => void }

interface AgentHooks {
  /** Replaces the SDK's query() (unit tests). */
  query?: QueryFn | null
  /** Added to the child's environment (the measurement script points it at a local fake API). */
  extraEnv?: Record<string, string> | null
  /** Called with every process this module starts. */
  onSpawn?: ((info: { pid: number | undefined; command: string; args: string[]; env: Record<string, string | undefined> }) => void) | null
}

let hooks: AgentHooks = {}

/** For tests and scripts/agent-sdk: swap the SDK, add environment, watch spawns. Never called by the app. */
export function setAgentTestHooks(next: AgentHooks) {
  hooks = { ...next }
}

// ── Token ───────────────────────────────────────────────────

function subscriptionToken(): string {
  return String(useRuntimeConfig().claudeCodeOauthToken ?? '').trim()
}

/** True when NUXT_CLAUDE_CODE_OAUTH_TOKEN is set, so steps can run on the subscription. */
export function subscriptionTokenSet(): boolean {
  return subscriptionToken().length > 0
}

/** Removes the subscription token (and anything shaped like a Claude OAuth token) from text that will be logged or stored. */
export function redactAgentSecrets(text: string): string {
  let out = String(text ?? '')
  const token = subscriptionToken()
  if (token) out = out.split(token).join('[token]')
  return out.replace(/sk-ant-o[a-z]*\d*-[A-Za-z0-9_-]{8,}/g, '[token]')
}

// ── Thinking ────────────────────────────────────────────────

/**
 * Whether a step asks Claude Code for thinking (NUXT_AGENT_THINKING; off by default, "on"/"all"/"*"
 * for every step, or a comma separated list of purposes such as "tailor,cover_letter").
 * What it changes, measured on Claude Code 2.1.317 against the fake API on 2026-11-03:
 * - claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5: nothing. Claude Code sends adaptive
 *   thinking either way, which is also what the API key path gets (it omits `thinking`, and these
 *   models then think adaptively; Opus 5.5 cannot turn thinking off at all). Effort, passed per
 *   step on both backends, is the control on these models.
 * - claude-haiku-4-5 (the fallback model): off sends thinking disabled, matching the API key path;
 *   without it Claude Code would add a 32K-token thinking budget.
 */
export function agentThinking(purpose: string): boolean {
  const raw = String(useRuntimeConfig().agentThinking ?? '').trim().toLowerCase()
  if (!raw || raw === 'off' || raw === 'false' || raw === '0') return false
  if (raw === 'on' || raw === 'true' || raw === '1' || raw === 'all' || raw === '*') return true
  return raw.split(',').map(s => s.trim()).includes(purpose.toLowerCase())
}

// ── Concurrency ─────────────────────────────────────────────

let active = 0
const waiters: Array<{ foreground: boolean; go: () => void }> = []

/** Claude Code processes this server runs at once (NUXT_AGENT_CONCURRENCY, 1 to 8). */
export function agentConcurrency(): number {
  return Math.max(1, Math.min(8, Number(useRuntimeConfig().agentConcurrency) || 3))
}

async function acquireSlot(foreground: boolean) {
  if (active < agentConcurrency()) {
    active++
    return
  }
  await new Promise<void>(go => waiters.push({ foreground, go }))
}

function releaseSlot() {
  const i = waiters.findIndex(w => w.foreground)
  const next = i >= 0 ? waiters.splice(i, 1)[0] : waiters.shift()
  if (next) next.go() // the slot passes straight to the next call
  else active = Math.max(0, active - 1)
}

/** Running and waiting calls, for /api/health and tests. */
export function agentSlots(): { running: number; waiting: number; max: number } {
  return { running: active, waiting: waiters.length, max: agentConcurrency() }
}

// ── Process: binary, user, directories, environment ─────────

let identity: { uid: number; gid: number } | null | undefined

/**
 * uid and gid Claude Code runs as, or null when the server is not root (local dev). Its own user
 * (NUXT_AGENT_UID, default 10003, created in the Dockerfile). Without that user it runs as the
 * server's own user, never as the demo user, whose builds run model-written code.
 */
export function agentIdentity(): { uid: number; gid: number } | null {
  if (identity !== undefined) return identity
  identity = null
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null
  const uid = Number(useRuntimeConfig().agentUid) || 10003
  try {
    const line = readFileSync('/etc/passwd', 'utf8').split('\n').find(l => l.split(':')[2] === String(uid))
    if (line) identity = { uid, gid: Number(line.split(':')[3]) }
  }
  catch {}
  if (!identity) console.warn(`[agent] uid ${uid} does not exist, so Claude Code runs as the server's user`)
  return identity
}

/** The Claude Code binary: NUXT_CLAUDE_CODE_PATH, else the SDK's platform package in node_modules. */
export function claudeCodeBinary(): string | undefined {
  const configured = String(useRuntimeConfig().claudeCodePath ?? '').trim()
  if (configured) return configured
  const req = createRequire(join(process.cwd(), 'package.json'))
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  for (const pkg of process.platform === 'linux' ? [base, `${base}-musl`] : [base]) {
    try {
      return req.resolve(`${pkg}/claude${process.platform === 'win32' ? '.exe' : ''}`)
    }
    catch {}
  }
  return undefined // the SDK looks for itself and says what is missing
}

let dirsReady = false

/** dataDir()/agent: home (Claude Code's config) and work (one throwaway directory per call), owned by the agent user. */
function agentDirs() {
  const root = join(dataDir(), 'agent')
  const home = join(root, 'home')
  const work = join(root, 'work')
  const tmp = join(root, 'tmp')
  if (!dirsReady) {
    for (const d of [join(home, '.claude'), work, tmp]) mkdirSync(d, { recursive: true })
    const id = agentIdentity()
    if (id) chownTree(root, id)
    try {
      chmodSync(root, 0o700)
    }
    catch {}
    dirsReady = true
  }
  return { root, home, work, tmp }
}

/** The child's whole environment. Nothing of the server's environment is inherited but PATH and the locale. */
function agentEnv(dirs: { home: string; tmp: string }, maxTokens: number, timeoutMs: number): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: process.env.TZ ?? 'UTC',
    HOME: dirs.home,
    TMPDIR: dirs.tmp,
    CLAUDE_CONFIG_DIR: join(dirs.home, '.claude'),
    CLAUDE_CODE_OAUTH_TOKEN: subscriptionToken(),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens),
    // A limit is reported at once (it does not clear with retries); a dropped connection is retried twice.
    CLAUDE_CODE_MAX_RETRIES: '2',
    API_TIMEOUT_MS: String(timeoutMs),
    CLAUDE_AGENT_SDK_CLIENT_APP: 'job-hunter',
    ...(hooks.extraEnv ?? {}),
  }
}

// ── Prompt ──────────────────────────────────────────────────

/**
 * The prompt as one user message. Claude Code marks three cache breakpoints itself (its system
 * prompt, ours, and its environment note) with a 1 hour lifetime, and a request allows four, each
 * no shorter-lived than one before it. So of cachedPrompt()'s breakpoints only the last (the end of
 * the stable part: instructions, then the knowledge base) is kept, with the same 1 hour lifetime.
 */
export function agentUserMessage(prompt: AgentRunInput['prompt']): SDKUserMessage {
  if (typeof prompt === 'string') {
    return { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: prompt } }
  }
  let last = -1
  prompt.forEach((b, i) => {
    if (b.cache_control) last = i
  })
  const content = prompt.map((b, i) => {
    const { cache_control: _, ...rest } = b
    return (i === last ? { ...rest, cache_control: { type: 'ephemeral', ttl: '1h' } } : rest)
  })
  return { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: content as any } }
}

// ── Reading the run ─────────────────────────────────────────

const AUTH_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold'])

function toMs(resetsAt: unknown): number | null {
  const n = Number(resetsAt)
  if (!Number.isFinite(n) || n <= 0) return null
  return n < 1e12 ? n * 1000 : n
}

function usageOf(result: any): AgentUsage | null {
  if (!result) return null
  const per = result.modelUsage && typeof result.modelUsage === 'object' ? Object.values(result.modelUsage) as any[] : []
  if (per.length) {
    return per.reduce<AgentUsage>((acc, u) => ({
      input_tokens: acc.input_tokens + (u.inputTokens ?? 0),
      output_tokens: acc.output_tokens + (u.outputTokens ?? 0),
      cache_read_input_tokens: acc.cache_read_input_tokens + (u.cacheReadInputTokens ?? 0),
      cache_creation_input_tokens: acc.cache_creation_input_tokens + (u.cacheCreationInputTokens ?? 0),
    }), { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  }
  const u = result.usage ?? {}
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  }
}

/**
 * What a finished query means, from the messages it streamed and the error it threw (query()
 * throws after an error result, so the result is read from the messages first). A subscription
 * limit shows as a rejected rate_limit_event with resetsAt (Unix seconds), an assistant error
 * rate_limit, or api_error_status 429; an expired or revoked token as authentication_failed or 401.
 */
export function readAgentRun(messages: SDKMessage[], thrown: unknown, ctx: { model: string; structured: boolean; timedOut: boolean; durationMs: number; startupMs: number | null; stderr?: string }): AgentRunResult {
  let result: any = null
  let rejected: { resetsAtMs: number | null; kind: string | null } | null = null
  let assistantError: string | null = null
  let refusal = false
  let model = ctx.model
  for (const m of messages as any[]) {
    if (m?.type === 'rate_limit_event' && m.rate_limit_info?.status === 'rejected') {
      const info = m.rate_limit_info
      rejected = { resetsAtMs: toMs(info.resetsAt), kind: info.rateLimitType ?? info.errorCode ?? null }
    }
    else if (m?.type === 'assistant') {
      if (m.error) assistantError = String(m.error)
      const used = m.message?.model
      if (typeof used === 'string' && used && !used.startsWith('<')) model = used
    }
    else if (m?.type === 'system' && m.subtype === 'model_refusal_no_fallback') {
      refusal = true
    }
    else if (m?.type === 'result') {
      result = m
    }
  }
  const base: AgentRunBase = {
    model,
    usage: usageOf(result),
    estCostUsd: Number(result?.total_cost_usd) || 0,
    durationMs: ctx.durationMs,
    startupMs: ctx.startupMs,
  }
  const status = Number(result?.api_error_status) || null
  const thrownText = thrown ? redactAgentSecrets(String((thrown as any)?.message ?? thrown)) : ''
  const resultText = typeof result?.result === 'string' ? redactAgentSecrets(result.result) : ''
  const errorsText = Array.isArray(result?.errors) ? redactAgentSecrets(result.errors.join('; ')) : ''
  const fail = (kind: AgentFailure, message: string, extra: { resetsAtMs?: number | null; limitKind?: string | null } = {}): AgentRunResult => ({
    ...base, ok: false, kind, message: message.slice(0, 1000), resetsAtMs: extra.resetsAtMs ?? null, limitKind: extra.limitKind ?? null,
  })

  if (rejected || assistantError === 'rate_limit' || assistantError === 'billing_error' || status === 429) {
    return fail('limit', resultText || thrownText || 'Claude subscription limit reached', { resetsAtMs: rejected?.resetsAtMs ?? null, limitKind: rejected?.kind ?? null })
  }
  if ((assistantError && AUTH_ERRORS.has(assistantError)) || status === 401 || status === 403) {
    return fail('auth', resultText || thrownText || 'Claude rejected the subscription token')
  }
  if (assistantError === 'model_not_found' || status === 404) {
    return fail('model', resultText || thrownText || `Model ${ctx.model} is not available on the subscription`)
  }
  if (refusal || result?.stop_reason === 'refusal') return fail('refusal', 'Claude declined the request')
  if (assistantError === 'max_output_tokens' || result?.stop_reason === 'max_tokens') return fail('truncated', 'Claude ran out of output tokens')
  if (ctx.timedOut) return fail('timeout', `No answer within ${Math.round(AGENT_TIMEOUT_MS / 60_000)} minutes`)
  if (result?.subtype === 'error_max_structured_output_retries') return fail('schema', errorsText || 'Claude did not return output matching the schema')
  if (result && result.subtype === 'success' && !result.is_error) {
    if (ctx.structured) {
      if (result.structured_output === undefined || result.structured_output === null) return fail('schema', 'Claude returned no structured output')
      return { ...base, ok: true, structured: result.structured_output, text: resultText }
    }
    return { ...base, ok: true, structured: null, text: typeof result.result === 'string' ? result.result : '' }
  }
  const stderr = ctx.stderr ? redactAgentSecrets(ctx.stderr).trim().split('\n').slice(-3).join(' ') : ''
  return fail('error', resultText || errorsText || thrownText || stderr || 'Claude Code ended without an answer')
}

// ── Running one call ────────────────────────────────────────

/** Starts the Claude Code process as the agent user, keeping its stderr tail for error messages. */
function spawner(onChild: (child: ChildProcess, startedAt: number) => void) {
  return (o: SpawnOptions): SpawnedProcess => {
    const id = agentIdentity()
    const child = spawn(o.command, o.args, {
      cwd: o.cwd,
      env: o.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: o.signal,
      windowsHide: true,
      ...(id ? { uid: id.uid, gid: id.gid } : {}),
    })
    onChild(child, Date.now())
    hooks.onSpawn?.({ pid: child.pid, command: o.command, args: [...o.args], env: { ...o.env } })
    return child as unknown as SpawnedProcess
  }
}

/** One call on the subscription. Never throws: failures come back as { ok: false, kind }. */
export async function runAgentQuery(input: AgentRunInput): Promise<AgentRunResult> {
  const timeoutMs = input.timeoutMs ?? AGENT_TIMEOUT_MS
  await acquireSlot(input.foreground)
  const started = Date.now()
  const messages: SDKMessage[] = []
  let thrown: unknown = null
  let timedOut = false
  let child: ChildProcess | null = null
  let spawnedAt = 0
  let firstMessageAt = 0
  let stderr = ''
  let work: string | null = null
  const abort = new AbortController()
  const timer = setTimeout(() => {
    timedOut = true
    abort.abort()
  }, timeoutMs)
  try {
    const dirs = agentDirs()
    work = mkdtempSync(join(dirs.work, 'call-'))
    const id = agentIdentity()
    if (id) chownSync(work, id.uid, id.gid)
    const options: Options = {
      model: input.model,
      systemPrompt: { type: 'custom', prompt: input.system.trim() || 'Follow the instructions in the user message.' },
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      permissionMode: 'dontAsk',
      persistSession: false,
      maxTurns: input.jsonSchema ? 4 : 2,
      cwd: work,
      thinking: input.thinking ? { type: 'adaptive' } : { type: 'disabled' },
      env: agentEnv(dirs, input.maxTokens ?? 16000, timeoutMs),
      abortController: abort,
      pathToClaudeCodeExecutable: claudeCodeBinary(),
      spawnClaudeCodeProcess: spawner((c, at) => {
        child = c
        spawnedAt = at
        c.stderr?.on('data', (d) => {
          stderr = (stderr + String(d)).slice(-4000)
        })
      }),
      ...(input.effortSupported && input.effort ? { effort: input.effort } : {}),
      ...(input.jsonSchema ? { outputFormat: { type: 'json_schema', schema: input.jsonSchema } } : {}),
    }
    const query = hooks.query ?? ((await import('@anthropic-ai/claude-agent-sdk')).query as unknown as QueryFn)
    const message = agentUserMessage(input.prompt)
    const q = query({
      prompt: (async function* () {
        yield message
      })(),
      options,
    })
    try {
      for await (const m of q) {
        if (!firstMessageAt) firstMessageAt = Date.now()
        messages.push(m)
      }
    }
    finally {
      try {
        q.close?.()
      }
      catch {}
    }
  }
  catch (e) {
    thrown = e
  }
  finally {
    clearTimeout(timer)
    // The process must be gone when the call returns: close() ends it; anything left is killed.
    const c = child as ChildProcess | null
    if (c && c.exitCode === null && c.signalCode === null) {
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => {
          try {
            c.kill('SIGKILL')
          }
          catch {}
          resolve()
        }, 3000)
        c.once('exit', () => {
          clearTimeout(kill)
          resolve()
        })
      })
    }
    if (work) rmSync(work, { recursive: true, force: true })
    releaseSlot()
  }
  return readAgentRun(messages, thrown, {
    model: input.model,
    structured: !!input.jsonSchema,
    timedOut,
    durationMs: Date.now() - started,
    startupMs: spawnedAt && firstMessageAt ? firstMessageAt - spawnedAt : null,
    stderr,
  })
}
