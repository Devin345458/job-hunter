// Launcher for the model evaluation. Copies the production snapshot once per model, reads the
// production Anthropic key from Coolify into memory, and starts scripts/eval/run-model.ts once
// per model in parallel. Results land in data/eval/results/<model>.json (gitignored).
//
//   node scripts/eval/run.mjs --db data/eval/prod-1103a.db --jobs 419,444 \
//     [--models claude-haiku-5-5,claude-opus-5-5] [--tag pilot]
//
// The key is read from the Coolify API (token in ~/.coolify-token) and handed to each child only
// through its environment. It is never printed or written. ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY,
// and ANTHROPIC_AUTH_TOKEN are removed from the child environment so calls reach the real API,
// not a local proxy.

import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const COOLIFY = 'http://remotes-mac-mini.local:8000'
const APP_UUID = 'i40g4ock48g0cwwgc4s88okk'

// Per-model spend caps in dollars. Together they stay under the $8 evaluation budget.
const CAPS = {
  'claude-opus-5-5': 3.6,
  'claude-sonnet-5-5': 2.2,
  'claude-haiku-4-5': 1.2,
  'claude-haiku-5-5': 0.5,
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const snapshot = resolve(arg('db', 'data/eval/prod-1103a.db'))
const jobs = arg('jobs')
const models = arg('models', Object.keys(CAPS).join(',')).split(',')
const tag = arg('tag', 'full')
if (!jobs) {
  console.error('--jobs is required')
  process.exit(2)
}
if (!existsSync(snapshot)) {
  console.error(`snapshot not found: ${snapshot}`)
  process.exit(2)
}

async function productionKey() {
  const token = readFileSync(resolve(homedir(), '.coolify-token'), 'utf8').trim()
  const res = await fetch(`${COOLIFY}/api/v1/applications/${APP_UUID}/envs`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Coolify env read failed: ${res.status}`)
  const list = await res.json()
  const entry = list.find(e => e.key === 'NUXT_ANTHROPIC_API_KEY' && !e.is_preview)
  const value = entry?.real_value ?? entry?.value
  if (!value) throw new Error('NUXT_ANTHROPIC_API_KEY not found on the production entry')
  return String(value).trim()
}

const key = await productionKey()
console.log(`key read from Coolify (type prefix ${key.match(/^sk-ant-[a-z]{3}/)?.[0] ?? 'unrecognized'})`)

// A stand-in `go` so availableToolchains() reports Go as production's image does (Go 1.27).
const shimDir = resolve('data/eval/toolshim')
mkdirSync(shimDir, { recursive: true })
writeFileSync(resolve(shimDir, 'go'), '#!/bin/sh\necho "go version go1.27.0 linux/amd64 (eval stand-in)"\n')
chmodSync(resolve(shimDir, 'go'), 0o755)

const childEnv = { ...process.env, NUXT_ANTHROPIC_API_KEY: key }
for (const name of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete childEnv[name]

mkdirSync(resolve('data/eval/results'), { recursive: true })
mkdirSync(resolve('data/eval/logs'), { recursive: true })

const runs = models.map((model) => {
  const cap = CAPS[model]
  if (cap == null) throw new Error(`no cap for ${model}`)
  const db = resolve(`data/eval/${tag}-${model}.db`)
  for (const suffix of ['', '-wal', '-shm']) rmSync(db + suffix, { force: true })
  copyFileSync(snapshot, db)
  const outJson = resolve(`data/eval/results/${tag}-${model}.json`)
  const log = createWriteStream(resolve(`data/eval/logs/${tag}-${model}.log`))
  const child = spawn('npx', ['tsx', '--tsconfig', 'scripts/eval/tsconfig.json', 'scripts/eval/run-model.ts', model, db, outJson, String(cap), shimDir, jobs], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => { log.write(d); process.stdout.write(d) })
  child.stderr.on('data', (d) => { log.write(d); process.stderr.write(d) })
  return new Promise(res => child.on('exit', code => res({ model, code })))
})

const results = await Promise.all(runs)
for (const r of results) console.log(`${r.model}: exit ${r.code}`)
