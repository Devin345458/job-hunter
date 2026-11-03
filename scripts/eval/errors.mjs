// Flattens unblinded verdicts into one list of errors: data/eval/judge/<dir>/errors.json.
//
//   node scripts/eval/errors.mjs [judgeDir]     (default data/eval/judge)
//
// Each row: jobId, model, step (comp, reqs, match, gaps), code, row (requirement row when given),
// requirement, detail. Adjudications in <judgeDir>/adjudications.json are included and marked.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'

const dir = process.argv[2] ?? 'data/eval/judge'
const key = JSON.parse(readFileSync(`${dir}/key.json`, 'utf8'))
const adjudications = existsSync(`${dir}/adjudications.json`) ? JSON.parse(readFileSync(`${dir}/adjudications.json`, 'utf8')) : []
const rows = []
for (const f of readdirSync(`${dir}/verdicts`).filter(f => /^job-\d+\.json$/.test(f))) {
  const v = JSON.parse(readFileSync(`${dir}/verdicts/${f}`, 'utf8'))
  const map = key[v.jobId]
  for (const [letter, model] of Object.entries(map)) {
    const o = v[letter]
    if (!o) continue
    const push = (step, e) => rows.push({ jobId: v.jobId, model, letter, step, code: e.code, row: e.row ?? null, requirement: e.requirement ?? null, detail: e.detail ?? '', evidence: e.evidence ?? '' })
    for (const e of o.enrich?.comp ?? []) push('comp', e)
    for (const e of o.enrich?.reqs ?? []) push('reqs', e)
    for (const e of o.match?.errors ?? []) push('match', e)
    for (const e of o.gaps?.errors ?? []) push('gaps', e)
  }
  // Removals first: a judge error that an adjudication marks as a false positive.
  for (const adj of adjudications.filter(a => a.jobId === v.jobId && a.remove)) {
    const i = rows.findIndex(r => r.jobId === v.jobId && r.model === adj.model && r.step === adj.kind && r.code === adj.code && r.detail.includes(adj.match))
    if (i >= 0) rows.splice(i, 1)
  }
  for (const adj of adjudications.filter(a => a.jobId === v.jobId && !a.remove)) {
    const letter = Object.entries(map).find(([, m]) => m === adj.model)?.[0]
    const o = v[letter]
    const already = (adj.kind === 'reqs' ? o?.enrich?.reqs : o?.enrich?.comp)?.some(e => e.code === adj.code)
    if (!already) rows.push({ jobId: v.jobId, model: adj.model, letter, step: adj.kind, code: adj.code, row: null, requirement: null, detail: `[adjudicated] ${adj.detail}`, evidence: '' })
  }
}
rows.sort((a, b) => a.jobId - b.jobId || a.step.localeCompare(b.step) || a.model.localeCompare(b.model))
writeFileSync(`${dir}/errors.json`, JSON.stringify(rows, null, 1))
console.log(`${rows.length} errors written to ${dir}/errors.json`)
