// Runs the fake Anthropic API (fake-api.ts) on 127.0.0.1 until stopped, for driving a built server
// end to end without a real token: point NUXT_CLAUDE_CODE_PATH at a shim that sets
// ANTHROPIC_BASE_URL to this server and runs the real binary. Switch modes with
// POST /__mode {"mode":"limit","resetInSeconds":3600}. Logs each request's path and auth kind.
//   npx tsx scripts/agent-sdk/fake-api-server.ts [port] [expectedToken]

import { startFakeApi } from './fake-api'

const api = await startFakeApi({ expectedToken: process.argv[3] }, Number(process.argv[2]) || 0)
console.log(`fake API listening on ${api.url}`)
let seen = 0
setInterval(() => {
  for (const r of api.requests.slice(seen)) {
    console.log(`${new Date(r.at).toISOString()} ${r.method} ${r.path} auth=${r.auth} tokenOk=${r.sentExpectedToken} model=${r.body?.model ?? ''} tools=${(r.body?.tools ?? []).map((t: any) => t.name).join(',')}`)
  }
  seen = api.requests.length
}, 500)
