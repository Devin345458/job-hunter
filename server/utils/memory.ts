import { scrubDashes } from './apply/text'

// A small MCP client for Devin's claude-self-reflect memory server (streamable HTTP, no login).
// It runs initialize, notifications/initialized, then tools/call csr_reflect_on_past, and reads
// the answer whether the server replies with JSON or an SSE stream. It never throws: when the
// server is off, closed, or slow it returns { available: false, reason }.
//
// Memory is a source of leads, never evidence. Excerpts are never logged; only counts are.
// They are stored only on question rows (memory_leads_json) and sent only to Claude in the
// question chat.

export const MEMORY_LIMITS = {
  /** The server must start answering within this long. */
  connectMs: 4000,
  /** The whole search (all three requests) must finish within this long. */
  totalMs: 15000,
  /** Results asked for; the filters below usually keep a handful. */
  fetchLimit: 15,
  /** Characters of one excerpt kept for the chat. */
  excerptChars: 1200,
  /** Characters of the card's one plain line. */
  lineChars: 150,
  /**
   * Similarity floor. Against the real server, every result under 0.40 was index metadata
   * (session heuristics, signatures, daily commit reports) with no story in it, while useful and
   * useless results were mixed between 0.40 and 0.60. So 0.40 drops the metadata and the content
   * filters in filterMemoryResults() do the real work.
   */
  minScore: 0.4,
  /** Results kept in this process's cache, and for how long. */
  cacheEntries: 100,
  cacheMs: 10 * 60 * 1000,
} as const

const TOOL = 'csr_reflect_on_past'
const PROTOCOL = '2025-03-26'

/** One search result as the memory server gave it, before filtering. */
export interface MemoryResult {
  /** The session's folder as the server names it, e.g. "-Users-x-PhpstormProjects-visilaunch". */
  projectPath: string
  /** Short display name, e.g. "visilaunch". */
  project: string
  date: string | null
  score: number
  /** Raw excerpt, cleaned of index metadata and capped at MEMORY_LIMITS.excerptChars. */
  excerpt: string
}

export type MemorySearch =
  | { available: true; results: MemoryResult[]; found: number; dropped: Record<string, number> }
  | { available: false; reason: string }

// ── Last check, for Settings ────────────────────────────────

let lastCheck: { at: string; ok: boolean; reason: string | null } | null = null

/** The last time this server process reached (or failed to reach) the memory server. */
export function memoryLastCheck() {
  return lastCheck
}

function noteCheck(ok: boolean, reason: string | null) {
  lastCheck = { at: new Date().toISOString(), ok, reason }
}

// ── MCP over streamable HTTP ────────────────────────────────

class MemoryError extends Error {}

/** A few plain words for why the memory server could not answer. Never includes excerpt text. */
function reasonFor(e: unknown, timedOut: { connect: boolean; total: boolean }): string {
  if (timedOut.connect) return `it did not answer within ${MEMORY_LIMITS.connectMs / 1000} seconds`
  if (timedOut.total) return `the search took longer than ${MEMORY_LIMITS.totalMs / 1000} seconds`
  if (e instanceof MemoryError) return e.message
  const code = (e as any)?.cause?.code ?? (e as any)?.code
  if (code === 'ECONNREFUSED') return 'nothing is listening at that address'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the host name was not found'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ETIMEDOUT') return 'the host is not reachable'
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'the connection was dropped'
  return 'the connection failed'
}

interface Session {
  url: string
  id: string | null
  signal: AbortSignal
}

function headers(session: Session | null): Record<string, string> {
  return {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    ...(session?.id ? { 'mcp-session-id': session.id, 'mcp-protocol-version': PROTOCOL } : {}),
  }
}

/** Reads JSON-RPC messages from an SSE body until the one with this id arrives. */
async function readSse(res: Response, id: number): Promise<any> {
  if (!res.body) throw new MemoryError('it sent an empty reply')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const take = (block: string) => {
    const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n').trim()
    if (!data) return null
    try {
      const msg = JSON.parse(data)
      return msg && msg.id === id ? msg : null
    }
    catch {
      return null
    }
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (value) buffer += decoder.decode(value, { stream: true })
      let cut = buffer.search(/\r?\n\r?\n/)
      while (cut >= 0) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '')
        const msg = take(block)
        if (msg) return msg
        cut = buffer.search(/\r?\n\r?\n/)
      }
      if (done) {
        const msg = take(buffer)
        if (msg) return msg
        throw new MemoryError('its reply ended before the answer arrived')
      }
    }
  }
  finally {
    reader.cancel().catch(() => {})
  }
}

async function readReply(res: Response, id: number): Promise<any> {
  if (!res.ok) throw new MemoryError(`it answered with HTTP ${res.status}`)
  const type = res.headers.get('content-type') ?? ''
  const msg = type.includes('text/event-stream')
    ? await readSse(res, id)
    : await res.json().then((body: any) => (Array.isArray(body) ? body.find(m => m?.id === id) : body))
  if (!msg) throw new MemoryError('it sent a reply the app could not read')
  if (msg.error) throw new MemoryError(`it returned an error (${String(msg.error.message ?? msg.error.code ?? 'unknown').slice(0, 120)})`)
  return msg.result
}

async function rpc(session: Session, id: number, method: string, params: unknown, signal = session.signal): Promise<any> {
  const res = await fetch(session.url, { method: 'POST', headers: headers(session), body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal })
  return await readReply(res, id)
}

/** Opens a session. The server must start answering within connectMs. */
async function open(url: string, total: AbortSignal, timedOut: { connect: boolean }): Promise<Session> {
  const connect = new AbortController()
  const timer = setTimeout(() => {
    timedOut.connect = true
    connect.abort()
  }, MEMORY_LIMITS.connectMs)
  const signal = AbortSignal.any([total, connect.signal])
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headers(null),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'job-hunter', version: '1' } } }),
      signal,
    })
  }
  finally {
    clearTimeout(timer)
  }
  const session: Session = { url, id: res.headers.get('mcp-session-id'), signal: total }
  await readReply(res, 1)
  const note = await fetch(url, { method: 'POST', headers: headers(session), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: total })
  await note.arrayBuffer().catch(() => null)
  return session
}

/** Ends the session on the server. Best effort, never awaited by callers. */
function close(session: Session) {
  if (!session.id) return
  fetch(session.url, { method: 'DELETE', headers: headers(session), signal: AbortSignal.timeout(2000) })
    .then(r => r.arrayBuffer())
    .catch(() => {})
}

/** Runs fn inside a fresh session with the connect and total timeouts. Never throws. */
async function withSession<T>(url: string, fn: (s: Session) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const timedOut = { connect: false, total: false }
  const total = new AbortController()
  const timer = setTimeout(() => {
    timedOut.total = true
    total.abort()
  }, MEMORY_LIMITS.totalMs)
  let session: Session | null = null
  try {
    session = await open(url, total.signal, timedOut)
    const value = await fn(session)
    noteCheck(true, null)
    return { ok: true, value }
  }
  catch (e) {
    const reason = reasonFor(e, timedOut)
    noteCheck(false, reason)
    return { ok: false, reason }
  }
  finally {
    clearTimeout(timer)
    if (session) close(session)
  }
}

// ── Parsing the tool's answer ───────────────────────────────

function decodeEntities(s: string): string {
  return s.replace(/&apos;/g, '\'').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

const ROOTS = ['PhpstormProjects-', 'orca-workspaces-', 'My-Drive-', 'Shared-drives-', 'Projects-', 'Sites-', 'Code-']

/** "-Users-x-PhpstormProjects-visilaunch" reads "visilaunch"; a Google Drive folder reads its last part. */
export function projectName(path: string): string {
  const p = path.trim()
  let best = -1
  let root = ''
  for (const r of ROOTS) {
    const i = p.lastIndexOf(r)
    if (i > best) {
      best = i
      root = r
    }
  }
  if (best >= 0) return p.slice(best + root.length) || p
  if (/^-?Users-/.test(p)) return 'home folder'
  return p || 'unknown'
}

/** Index metadata the server appends to some excerpts (signatures, error recovery logs). */
function stripMetadata(s: string): string {
  return s
    .replace(/\n-{3}\nSignature:[\s\S]*$/, '')
    .replace(/\nSignature: \{[\s\S]*$/, '')
    .replace(/\nContext:\n## Error Recovery[\s\S]*$/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function capExcerpt(s: string): string {
  if (s.length <= MEMORY_LIMITS.excerptChars) return s
  const cut = s.slice(0, MEMORY_LIMITS.excerptChars)
  const space = cut.lastIndexOf(' ')
  return `${cut.slice(0, space > MEMORY_LIMITS.excerptChars - 200 ? space : cut.length)} [...]`
}

/** The results inside csr_reflect_on_past's text answer (one <r> element per result). */
export function parseReflectText(text: string): Array<MemoryResult & { rawExcerpt: string }> {
  const out: Array<MemoryResult & { rawExcerpt: string }> = []
  for (const m of text.matchAll(/<r rank="\d+">([\s\S]*?)<\/r>/g)) {
    const body = m[1]!
    const score = Number(body.match(/<s>([\d.]+)<\/s>/)?.[1])
    const projectPath = decodeEntities(body.match(/<p>([^<]*)<\/p>/)?.[1] ?? '').trim()
    const when = decodeEntities(body.match(/<t>([^<]*)<\/t>/)?.[1] ?? '')
    const raw = body.match(/<excerpt><!\[CDATA\[([\s\S]*?)\]\]><\/excerpt>/)?.[1] ?? decodeEntities(body.match(/<excerpt>([\s\S]*?)<\/excerpt>/)?.[1] ?? '')
    if (!Number.isFinite(score)) continue
    out.push({
      projectPath,
      project: projectName(projectPath),
      date: when.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null,
      score,
      rawExcerpt: raw,
      excerpt: capExcerpt(stripMetadata(raw)),
    })
  }
  return out
}

// ── Filters ─────────────────────────────────────────────────

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function shingles(s: string, n = 6): Set<string> {
  const w = norm(s).split(' ').filter(Boolean)
  const out = new Set<string>()
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '))
  return out
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const x of a) if (b.has(x)) shared++
  return shared / Math.min(a.size, b.size)
}

/** Share of the excerpt that is letters and spaces. Tool output, JSON, and tables score low. */
function proseRatio(s: string): number {
  if (!s.length) return 0
  return (s.match(/[A-Za-z\s.,']/g)?.length ?? 0) / s.length
}

/** Source code: numbered comment lines ("19 * 20 *"), braces, arrows, and semicolons. */
function looksLikeCode(s: string): boolean {
  if (/(?:^|\s)\d+ \* \d+ \*/.test(s)) return true
  const marks = s.match(/[{}();=<>\\]|=>|::/g)?.length ?? 0
  return s.length > 0 && marks / s.length > 0.03
}

/** Instructions loaded into many sessions (skills, standing rules, agent prompts), not something that happened. */
const BOILERPLATE = [
  /base directory for this skill/i,
  /^-{3}\s*\n?name:/,
  /\bdescription: use (?:this skill )?when\b/i,
  /^you are (?:doing|generating|a |an |the )/i,
  /reminder: you must/i,
  /\[reflection\] \[heuristic\]/i,
  /<system-reminder>/i,
  // Skill and standing-rule text addressed to Claude.
  /your human partner/i,
  /\bREQUIRED (?:BACKGROUND|SUB-SKILL)\b/,
  /\bYou MUST\b|\bMUST NOT\b|\bDo NOT\b/,
  /\bsuperpowers:|\bSKILL\.md\b|\bCLAUDE\.md\b/,
  /^(?:Before you start|Use (?:plain|detailed)|When (?:you|the user) )/,
]

/**
 * Keeps the results worth showing Devin as leads and counts what each filter dropped (counts
 * only; nothing here is logged with text).
 * - score under MEMORY_LIMITS.minScore (index metadata, see above).
 * - job-hunter's own sessions, by folder or by text: building this app quotes every question.
 * - delegated research (folders "subagents" and "wf_*"): web research by sub-agents, where
 *   Devin's own words and work never appear.
 * - "[keyword]" hits: literal word matches the server scores at a flat 0.450; against the real
 *   server every one was tool output, JSON, or this app's own logs.
 * - fragments under 80 characters, tool output and tables (little prose), loaded instructions.
 * - the question's own text (a screen dump of the question card).
 * - near duplicates: the same text in two results keeps the first; text found in three or more
 *   results is instructions loaded into many sessions, so all copies go.
 */
export function filterMemoryResults<T extends MemoryResult & { rawExcerpt?: string }>(
  results: T[],
  opts: { question?: string | null } = {},
): { kept: T[]; dropped: Record<string, number> } {
  const dropped: Record<string, number> = {}
  const drop = (why: string) => {
    dropped[why] = (dropped[why] ?? 0) + 1
  }
  const questionKey = opts.question ? norm(opts.question).slice(0, 60) : ''
  const candidates: T[] = []
  for (const r of results) {
    const raw = r.rawExcerpt ?? r.excerpt
    const text = r.excerpt
    const path = r.projectPath.toLowerCase()
    if (r.score < MEMORY_LIMITS.minScore) drop('weak score')
    else if (path.includes('job-hunter') || /job-hunter/i.test(raw)) drop('job-hunter session')
    else if (path === 'subagents' || path.startsWith('wf_')) drop('delegated research')
    else if (/^\s*\[keyword\]/i.test(raw)) drop('keyword match')
    else if (text.replace(/\s+/g, ' ').trim().length < 80) drop('fragment')
    else if (BOILERPLATE.some(re => re.test(raw))) drop('loaded instructions')
    else if (proseRatio(text) < 0.82 || looksLikeCode(text) || /\[ref=e\d+\]/.test(raw) || /^\s*[[{]/.test(text)) drop('tool output')
    else if (questionKey.length > 20 && norm(text).includes(questionKey)) drop('screen of this question')
    else candidates.push(r)
  }
  // Near duplicates, grouped greedily.
  const groups: Array<{ first: T; sh: Set<string>; size: number }> = []
  for (const r of candidates) {
    const sh = shingles(r.excerpt)
    const g = groups.find(x => overlap(x.sh, sh) >= 0.3)
    if (g) g.size++
    else groups.push({ first: r, sh, size: 1 })
  }
  const kept: T[] = []
  for (const g of groups) {
    if (g.size >= 3) {
      dropped['loaded instructions'] = (dropped['loaded instructions'] ?? 0) + g.size
      continue
    }
    if (g.size === 2) drop('duplicate')
    kept.push(g.first)
  }
  kept.sort((a, b) => b.score - a.score)
  return { kept, dropped }
}

// ── The card's one plain line ───────────────────────────────

const LINE_STOP = new Set(['have', 'with', 'your', 'that', 'this', 'from', 'what', 'when', 'were', 'been', 'into', 'used', 'using', 'real', 'project', 'projects', 'describe', 'situation', 'experience', 'worked', 'work'])

function queryWords(query: string): string[] {
  return [...new Set(norm(query).split(' ').filter(w => w.length >= 4 && !LINE_STOP.has(w)))]
}

/**
 * One plain sentence from the excerpt for the question card: the sentence that shares the most
 * words with the question, cleaned of markdown, code, links, and tags, cut to about 150
 * characters, with any em or en dash rewritten. It is quoted on the card, never reworded into a
 * claim about Devin.
 */
export function leadLine(excerpt: string, query: string): string {
  const asked = /^\s*\[reflection\]\s*##\s*User Request\s*/i.test(excerpt)
  let text = excerpt
    .replace(/^\s*\[(?:reflection|story|narrative|keyword)\]\s*/i, '')
    .replace(/^##\s*User Request\s*/i, '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/\[(?:Bash|Read|Edit|Write|Grep|Glob|Tool)[^\]]*\]/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    // People's addresses and file paths do not belong on the card.
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '(email)')
    .replace(/(?:~|\/(?:Users|private|tmp|var|home))\/\S+/g, '(a file)')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__|^#+\s*/gm, '')
    .replace(/[|]/g, ' ')
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // Excerpts start wherever the index cut the session, often mid-word or mid-sentence, so the
  // first piece is used only when nothing else is long enough.
  const pieces = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(*])/).map(s => s.replace(/^\*?Speaker \d+:\*\s*|^\*?Devin:\*\s*/g, '').trim())
  const rest = (asked ? pieces : pieces.slice(1)).filter(s => s.length >= 25)
  const sentences = rest.length ? rest : pieces.filter(s => s.length >= 25)
  const want = queryWords(query)
  let best = sentences[0] ?? text
  let bestScore = -1
  for (const s of sentences) {
    const have = new Set(norm(s).split(' '))
    const score = want.filter(w => have.has(w)).length
    if (score > bestScore) {
      best = s
      bestScore = score
    }
  }
  let line = scrubDashes(best).replace(/\s+/g, ' ').trim()
  if (line.length > MEMORY_LIMITS.lineChars) {
    const cut = line.slice(0, MEMORY_LIMITS.lineChars)
    const space = cut.lastIndexOf(' ')
    line = `${cut.slice(0, space > 80 ? space : cut.length).replace(/[,;:]$/, '')}...`
  }
  return asked ? `You asked: ${line}` : line
}

// ── Search ──────────────────────────────────────────────────

const cache = new Map<string, { at: number; value: MemorySearch }>()

function cached(key: string): MemorySearch | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > MEMORY_LIMITS.cacheMs) {
    cache.delete(key)
    return null
  }
  return hit.value
}

function remember(key: string, value: MemorySearch) {
  if (!value.available) return
  cache.set(key, { at: Date.now(), value })
  while (cache.size > MEMORY_LIMITS.cacheEntries) cache.delete(cache.keys().next().value!)
}

/**
 * Searches memory with one or more queries in one session (in parallel), merges the results,
 * and filters them. `question` is the question's own text, for the screen-dump filter.
 * Never throws.
 */
export async function searchMemory(url: string, queries: string[], opts: { question?: string | null; limit?: number } = {}): Promise<MemorySearch> {
  const list = [...new Set(queries.map(q => q.trim()).filter(Boolean))]
  if (!url) return { available: false, reason: 'memory is off' }
  if (!list.length) return { available: true, results: [], found: 0, dropped: {} }
  const key = `${url}\n${list.join('\n')}\n${opts.question ?? ''}`
  const hit = cached(key)
  if (hit) return hit
  const out = await withSession(url, async (session) => {
    const answers = await Promise.all(list.map((query, i) => rpc(session, 10 + i, 'tools/call', {
      name: TOOL,
      arguments: { query, limit: opts.limit ?? MEMORY_LIMITS.fetchLimit, project: 'all' },
    })))
    const all: Array<MemoryResult & { rawExcerpt: string }> = []
    for (const a of answers) {
      if (a?.isError) throw new MemoryError('the search tool returned an error')
      const text = (a?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => String(c.text ?? '')).join('\n')
      all.push(...parseReflectText(text))
    }
    // The same chunk can come back from two queries; keep its best score.
    const byText = new Map<string, MemoryResult & { rawExcerpt: string }>()
    for (const r of all) {
      const k = `${r.projectPath}\n${r.excerpt.slice(0, 200)}`
      const prev = byText.get(k)
      if (!prev || prev.score < r.score) byText.set(k, r)
    }
    const { kept, dropped } = filterMemoryResults([...byText.values()], { question: opts.question })
    return { found: all.length, kept, dropped }
  })
  if (!out.ok) return { available: false, reason: out.reason }
  const results = out.value.kept.map(({ rawExcerpt: _raw, ...r }) => r)
  const value: MemorySearch = { available: true, results, found: out.value.found, dropped: out.value.dropped }
  remember(key, value)
  return value
}

/** Opens a session and closes it: is the memory server there? Never throws. */
export async function pingMemory(url: string): Promise<{ ok: boolean; reason: string | null }> {
  if (!url) return { ok: false, reason: 'memory is off' }
  const out = await withSession(url, async () => true)
  return out.ok ? { ok: true, reason: null } : { ok: false, reason: out.reason }
}

/** NUXT_MEMORY_MCP_URL, or an empty string when the feature is off. */
export function memoryUrl(): string {
  return String(useRuntimeConfig().memoryMcpUrl ?? '').trim()
}

/** One log line with counts only, never excerpt text or the query. */
export function memoryLogLine(what: string, search: MemorySearch): string {
  if (!search.available) return `[memory] ${what}: not reachable (${search.reason})`
  const dropped = Object.entries(search.dropped).map(([k, v]) => `${v} ${k}`).join(', ')
  return `[memory] ${what}: ${search.found} found, ${search.results.length} kept${dropped ? ` (dropped: ${dropped})` : ''}`
}
