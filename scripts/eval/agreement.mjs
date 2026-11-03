// Agreement between the round one judge and a blind re-judge of the same packets.
//
//   node scripts/eval/agreement.mjs
//
// Reads data/eval/judge/verdicts/job-<id>.json and data/eval/judge/rejudge/job-<id>.json for every
// job that has both, plus key.json, results (for requirement row counts), and adjudications.json
// (removals apply to both judges). Prints:
// - output level: per job, letter, and step (comp, reqs, match, gaps), whether both judges agree
//   that the output has at least one error or has none.
// - requirement rows: per row, whether both judges agree it is wrong or right (rows are numbered,
//   so this is the one field both rubric versions identify exactly).
// - error counts per output and step, side by side.

import { existsSync, readFileSync, readdirSync } from 'node:fs'

const key = JSON.parse(readFileSync('data/eval/judge/key.json', 'utf8'))
const adj = existsSync('data/eval/judge/adjudications.json') ? JSON.parse(readFileSync('data/eval/judge/adjudications.json', 'utf8')) : []
const results = {}
for (const m of new Set(Object.values(key).flatMap(k => Object.values(k)))) results[m] = JSON.parse(readFileSync(`data/eval/results/full-${m}.json`, 'utf8'))

const ids = readdirSync('data/eval/judge/rejudge').filter(f => /^job-\d+\.json$/.test(f)).map(f => Number(f.match(/\d+/)[0])).sort((a, b) => a - b)
const STEPS = ['comp', 'reqs', 'match', 'gaps']

function errorsOf(v, letter, step, model, id) {
  const o = v[letter] ?? {}
  const list = step === 'comp' ? o.enrich?.comp : step === 'reqs' ? o.enrich?.reqs : o[step]?.errors
  const removals = adj.filter(a => a.remove && a.jobId === id && a.model === model && a.kind === step)
  return (list ?? []).filter(e => !removals.some(r => r.code === e.code && String(e.detail).includes(r.match)))
}

let outAgree = 0, outTotal = 0
const perStep = Object.fromEntries(STEPS.map(s => [s, { agree: 0, total: 0, j1: 0, j2: 0 }]))
let rowAgree = 0, rowTotal = 0, rowBoth = 0, rowOnly1 = 0, rowOnly2 = 0
const lines = []
for (const id of ids) {
  const v1 = JSON.parse(readFileSync(`data/eval/judge/verdicts/job-${id}.json`, 'utf8'))
  const v2 = JSON.parse(readFileSync(`data/eval/judge/rejudge/job-${id}.json`, 'utf8'))
  for (const [letter, model] of Object.entries(key[id])) {
    const counts = []
    for (const step of STEPS) {
      const e1 = errorsOf(v1, letter, step, model, id)
      const e2 = errorsOf(v2, letter, step, model, id)
      const same = (e1.length > 0) === (e2.length > 0)
      outTotal++
      perStep[step].total++
      perStep[step].j1 += e1.length > 0 ? 1 : 0
      perStep[step].j2 += e2.length > 0 ? 1 : 0
      if (same) { outAgree++; perStep[step].agree++ }
      counts.push(`${step} ${e1.length}/${e2.length}`)
      if (step === 'reqs') {
        const rows = results[model].enrich[id]?.requirements?.length ?? 0
        const r1 = new Set(e1.map(e => Number(e.row)).filter(Boolean))
        const r2 = new Set(e2.map(e => Number(e.row)).filter(Boolean))
        for (let r = 1; r <= rows; r++) {
          rowTotal++
          const a = r1.has(r), b = r2.has(r)
          if (a === b) rowAgree++
          if (a && b) rowBoth++
          else if (a) rowOnly1++
          else if (b) rowOnly2++
        }
      }
    }
    lines.push(`#${id} ${letter} ${model.replace('claude-', '')}: ${counts.join(', ')}`)
  }
}
console.log(lines.join('\n'))
console.log(`\noutputs (job x letter x step): judges agree on error or no error in ${outAgree}/${outTotal} (${Math.round(100 * outAgree / outTotal)}%)`)
for (const s of STEPS) console.log(`  ${s}: ${perStep[s].agree}/${perStep[s].total}; outputs with an error: first judge ${perStep[s].j1}, re-judge ${perStep[s].j2}`)
console.log(`requirement rows: agree on ${rowAgree}/${rowTotal} (${Math.round(100 * rowAgree / rowTotal)}%); flagged by both ${rowBoth}, first judge only ${rowOnly1}, re-judge only ${rowOnly2}`)
