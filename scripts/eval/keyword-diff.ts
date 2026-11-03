// Compares two runs of keyword-evidence.ts with verdicts on the commits that changed.
//
//   npx tsx --tsconfig scripts/eval/tsconfig.json scripts/eval/keyword-diff.ts <snapshotCopy.db> <beforeTag> <afterTag> <verdicts.txt>...
//
// A verdict file has one line per commit: "<case id> <owner/repo@sha> R|N <reason>" (R: the commit
// shows work on the subject). Prints per case: hits before and after, real hits among the commits
// that left and joined the list, and for every real commit that left whether it still matches the
// new anchors (pushed out by ranking and the cap of 14) or no longer matches (dropped by the rule).
// Reads only the commit messages and paths from the snapshot copy.

import { readFileSync } from 'node:fs'
import { setupGlobals } from './globals'

const [dbPath, beforeTag, afterTag, ...verdictFiles] = process.argv.slice(2)
if (!dbPath || !beforeTag || !afterTag || !verdictFiles.length) {
  console.error('usage: keyword-diff.ts <snapshotCopy.db> <beforeTag> <afterTag> <verdicts.txt>...')
  process.exit(2)
}
await setupGlobals({ databasePath: dbPath, anthropicApiKey: '', aiModel: 'none', aiFallbackModel: 'none', dailyAiBudgetUsd: '0', schedulerEnabled: 'false', demoToolPath: '' })
const { useDb } = await import('../../server/utils/db')
const { anchorPattern, messageBody, pathMatches } = await import('../../server/utils/repos/search')

const sqlite = useDb().$client
const commits = new Map((sqlite.prepare('SELECT repo, sha, message, paths_json AS pathsJson FROM repo_commits').all() as Array<{ repo: string; sha: string; message: string; pathsJson: string | null }>).map(c => [`${c.repo}@${c.sha}`, c] as const))
const load = (tag: string) => JSON.parse(readFileSync(`data/eval/keyword/${tag}.json`, 'utf8')) as Array<{ id: string; subject: string; hits: Array<{ key: string }>; anchors?: { code: string[]; paths: string[]; packages: string[] } | null }>
const before = load(beforeTag)
const after = load(afterTag)

const verdict = new Map<string, { r: boolean; why: string }>()
for (const f of verdictFiles) {
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^(\S+)\s+(\S+@[0-9a-f]{7,64})\s+([RN])\b\s*(.*)$/.exec(line.trim())
    if (m) verdict.set(`${m[1]} ${m[2]}`, { r: m[3] === 'R', why: m[4] ?? '' })
  }
}

function stillMatches(key: string, anchors: { code: string[]; paths: string[]; packages: string[] }): boolean {
  const c = commits.get(key)
  if (!c) return false
  const words = [...anchors.code, ...anchors.packages]
  if (words.length && new RegExp(words.map(anchorPattern).join('|'), 'i').test(messageBody(c.message))) return true
  const paths = JSON.parse(c.pathsJson ?? '[]') as string[]
  return anchors.paths.length > 0 && paths.some(p => pathMatches(p, anchors.paths))
}

let tb = 0, ta = 0, outR = 0, outN = 0, inR = 0, inN = 0, missing = 0, dropped = 0, pushed = 0
const droppedList: string[] = []
for (let i = 0; i < after.length; i++) {
  const b = before[i]!
  const a = after[i]!
  const kb = new Set(b.hits.map(h => h.key))
  const ka = new Set(a.hits.map(h => h.key))
  const out = [...kb].filter(k => !ka.has(k))
  const inn = [...ka].filter(k => !kb.has(k))
  tb += kb.size
  ta += ka.size
  if (!out.length && !inn.length) continue
  const v = (k: string) => verdict.get(`${a.id} ${k}`)
  const oR = out.filter(k => v(k)?.r)
  const iR = inn.filter(k => v(k)?.r)
  missing += [...out, ...inn].filter(k => !v(k)).length
  outR += oR.length
  outN += out.length - oR.length
  inR += iR.length
  inN += inn.length - iR.length
  const lost = oR.filter(k => !a.anchors || !stillMatches(k, a.anchors))
  dropped += lost.length
  pushed += oR.length - lost.length
  for (const k of lost) droppedList.push(`${a.id} ${a.subject}: ${k.replace(/@(.{10}).*/, '@$1')} | ${(commits.get(k)?.message ?? '').split('\n')[0]!.slice(0, 100)} | ${v(k)?.why}`)
  console.log(`${a.id.padEnd(5)} ${a.subject.slice(0, 44).padEnd(45)} hits ${String(kb.size).padStart(2)} -> ${String(ka.size).padStart(2)} | left ${out.length} (real ${oR.length}, dropped by rule ${lost.length}) | joined ${inn.length} (real ${iR.length})`)
}
console.log(`\nTotal hits ${tb} -> ${ta}. Left the lists: ${outR + outN} (real ${outR}: ${pushed} still match but ranked below the cap, ${dropped} dropped by the rule). Joined: ${inR + inN} (real ${inR}). Unjudged: ${missing}.`)
if (droppedList.length) console.log(`\nReal commits the rule drops:\n${droppedList.join('\n')}`)
