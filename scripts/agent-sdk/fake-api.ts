// A stand-in for the Anthropic Messages API on 127.0.0.1, so the real Claude Code binary that the
// Agent SDK starts can be run with no real token: tests and the measurement script point the child
// process at it with ANTHROPIC_BASE_URL. It records every request (the Authorization header only as
// a fingerprint, never its value) and answers:
// - a request that offers a structured output tool: a tool_use block calling it with `structured`
// - any other request: a short text answer
// - mode 'limit': a 429 with the unified rate limit headers a Claude subscription sends
// Only for tests and measurement. Never used by the app.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeRequest {
  method: string
  path: string
  /** "Bearer" or "x-api-key" plus whether the expected token was sent; never the value itself. */
  auth: string
  sentExpectedToken: boolean
  headers: Record<string, string>
  body: any
  /** Date.now() when the request arrived. */
  at: number
}

export interface FakeApiOptions {
  /** The object the structured output tool call returns. */
  structured?: unknown
  /** The token the client should send; recorded as matched or not. */
  expectedToken?: string
  mode?: 'ok' | 'limit' | 'auth'
  /** Unix seconds the limit resets at, for mode 'limit'. */
  resetAt?: number
  /** Milliseconds to wait before answering, to imitate model latency. */
  latencyMs?: number
}

export interface FakeApi {
  url: string
  requests: FakeRequest[]
  options: FakeApiOptions
  close(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function sse(res: ServerResponse, events: Array<Record<string, unknown>>) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_fake' })
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  res.end()
}

function structuredTool(body: any): { name: string; input_schema?: any } | null {
  const tools: Array<{ name?: string; input_schema?: any }> = Array.isArray(body?.tools) ? body.tools : []
  const tool = tools.find(t => /structured/i.test(String(t.name ?? '')))
  return tool?.name ? { name: tool.name, input_schema: tool.input_schema } : null
}

/** The smallest value a JSON Schema accepts: required properties only, first enum value, empty arrays. */
export function sampleFor(schema: any, root: any = schema, depth = 0): unknown {
  if (!schema || typeof schema !== 'object' || depth > 12) return null
  if (schema.$ref && typeof schema.$ref === 'string') {
    const path = schema.$ref.replace(/^#\//, '').split('/')
    let target: any = root
    for (const p of path) target = target?.[p]
    return sampleFor(target, root, depth + 1)
  }
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]
  if ('const' in schema) return schema.const
  for (const k of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[k]) && schema[k].length) return sampleFor(schema[k].find((s: any) => s?.type !== 'null') ?? schema[k][0], root, depth + 1)
  }
  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== 'null') : schema.type
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const key of Array.isArray(schema.required) ? schema.required : []) out[key] = sampleFor(schema.properties?.[key], root, depth + 1)
      return out
    }
    case 'array': {
      const min = Number(schema.minItems) || 0
      return Array.from({ length: min }, () => sampleFor(schema.items, root, depth + 1))
    }
    case 'string': return 'Sample answer from the fake API.'
    case 'integer':
    case 'number': return typeof schema.minimum === 'number' ? schema.minimum : 1
    case 'boolean': return false
    case 'null': return null
  }
  return null
}

function lastUserHasToolResult(body: any): boolean {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : []
  const last = messages[messages.length - 1]
  return Array.isArray(last?.content) && last.content.some((b: any) => b?.type === 'tool_result')
}

export async function startFakeApi(options: FakeApiOptions = {}, port = 0): Promise<FakeApi> {
  const requests: FakeRequest[] = []
  const server: Server = createServer(async (req, res) => {
    const at = Date.now()
    const raw = await readBody(req)
    let body: any = null
    try {
      body = raw ? JSON.parse(raw) : null
    }
    catch {
      body = raw
    }
    const authHeader = String(req.headers.authorization ?? '')
    const apiKey = String(req.headers['x-api-key'] ?? '')
    const token = options.expectedToken ?? ''
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'authorization' || k === 'x-api-key') continue
      headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '')
    }
    requests.push({
      method: req.method ?? '',
      path: req.url ?? '',
      auth: authHeader ? authHeader.split(' ')[0]! : apiKey ? 'x-api-key' : 'none',
      sentExpectedToken: !!token && (authHeader === `Bearer ${token}` || apiKey === token),
      headers,
      body,
      at,
    })

    const path = (req.url ?? '').split('?')[0]
    // Test control: POST /__mode {"mode":"limit","resetInSeconds":3600,"latencyMs":0}
    if (req.method === 'POST' && path === '/__mode') {
      const b = body && typeof body === 'object' ? body : {}
      if (b.mode) options.mode = b.mode
      if (b.resetInSeconds != null) options.resetAt = Math.floor(Date.now() / 1000) + Number(b.resetInSeconds)
      if (b.latencyMs != null) options.latencyMs = Number(b.latencyMs)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ mode: options.mode ?? 'ok', resetAt: options.resetAt ?? null, latencyMs: options.latencyMs ?? 0 }))
      return
    }
    if (req.method !== 'POST' || path !== '/v1/messages') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }))
      return
    }
    if (options.latencyMs) await new Promise(r => setTimeout(r, options.latencyMs))

    if (options.mode === 'auth') {
      res.writeHead(401, { 'content-type': 'application/json', 'request-id': 'req_fake' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'OAuth token has expired.' } }))
      return
    }
    if (options.mode === 'limit') {
      const reset = options.resetAt ?? Math.floor(Date.now() / 1000) + 3600
      res.writeHead(429, {
        'content-type': 'application/json',
        'request-id': 'req_fake',
        'retry-after': '3600',
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-reset': String(reset),
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-reset': String(reset),
        'anthropic-ratelimit-unified-5h-utilization': '1.0',
      })
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'This request would exceed your account\'s rate limit. Please try again later.' } }))
      return
    }

    const model = String(body?.model ?? 'claude-sonnet-5-5')
    const usage = { input_tokens: 1200, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    const start = { type: 'message_start', message: { id: `msg_fake_${requests.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }
    const tool = structuredTool(body)
    const toolName = tool?.name ?? null
    const answerWithTool = toolName && !lastUserHasToolResult(body)
    const answer = options.structured ?? sampleFor(tool?.input_schema) ?? {}
    const events: Array<Record<string, unknown>> = [start]
    if (answerWithTool) {
      const json = JSON.stringify(answer)
      events.push(
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_fake_${requests.length}`, name: toolName, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 40 } },
      )
    }
    else {
      const text = toolName ? 'Done.' : 'A short plain answer from the fake API.'
      events.push(
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } },
      )
    }
    events.push({ type: 'message_stop' })
    if (body?.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_fake' })
      const content = answerWithTool
        ? [{ type: 'tool_use', id: 'toolu_fake', name: toolName, input: answer }]
        : [{ type: 'text', text: 'A short plain answer from the fake API.' }]
      res.end(JSON.stringify({ ...start.message, content, stop_reason: answerWithTool ? 'tool_use' : 'end_turn', usage: { ...usage, output_tokens: 40 } }))
      return
    }
    sse(res, events)
  })
  await new Promise<void>(r => server.listen(port, '127.0.0.1', r))
  const bound = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${bound}`,
    requests,
    options,
    close: () => new Promise<void>(r => server.close(() => r())),
  }
}
