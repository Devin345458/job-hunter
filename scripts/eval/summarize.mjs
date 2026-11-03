// Unblinds the judges' verdicts and prints the per-step numbers for the report.
//
//   node scripts/eval/summarize.mjs
//
// Reads data/eval/judge/key.json, data/eval/judge/mechanical.json, and
// data/eval/judge/verdicts/job-<id>.json. Writes data/eval/judge/summary.json.
// Error count per step is the number of jobs (out of the jobs judged) whose output had at least one
// error, plus the total number of errors. Style codes (M4, G7) are counted apart from accuracy.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'

const key = JSON.parse(readFileSync('data/eval/judge/key.json', 'utf8'))
const mech = JSON.parse(readFileSync('data/eval/judge/mechanical.json', 'utf8'))
const dir = 'data/eval/judge/verdicts'
const files = existsSync(dir) ? readdirSync(dir).filter(f => /^job-\d+\.json$/.test(f)) : []
const STYLE = new Set(['M4', 'G7'])

const models = Object.keys(mech.models)
const agg = Object.fromEntries(models.map(m => [m, {
  enrich: { jobsWithError: 0, compErrors: 0, reqErrors: 0, byCode: {}, benefitsMissed: 0, benefitsDroppedByApp: 0, mustHavesMissed: 0, judged: 0, failed: 0 },
  match: { jobsWithError: 0, errors: 0, style: 0, byCode: {}, wording: [], judged: 0, failed: 0 },
  gaps: { jobsWithError: 0, errors: 0, style: 0, byCode: {}, wording: [], judged: 0, failed: 0 },
}]))
const cannotJudge = []
const disagreements = []

for (const f of files) {
  const v = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))
  const id = v.jobId
  const map = key[id]
  if (!map) continue
  for (const [letter, model] of Object.entries(map)) {
    const o = v[letter]
    if (!o) continue
    const a = agg[model]
    const pj = mech.models[model].perJob[id]
    // enrich
    if (pj?.enrich?.ok === false) a.enrich.failed++
    else if (o.enrich) {
      a.enrich.judged++
      const comp = o.enrich.comp ?? []
      const reqs = o.enrich.reqs ?? []
      a.enrich.compErrors += comp.length
      a.enrich.reqErrors += reqs.length
      for (const e of [...comp, ...reqs]) a.enrich.byCode[e.code] = (a.enrich.byCode[e.code] ?? 0) + 1
      if (comp.length + reqs.length > 0) a.enrich.jobsWithError++
      a.enrich.benefitsMissed += o.enrich.benefitsMissed ?? 0
      a.enrich.benefitsDroppedByApp += o.enrich.benefitsDroppedByApp ?? 0
      a.enrich.mustHavesMissed += o.enrich.mustHavesMissed ?? 0
    }
    for (const step of ['match', 'gaps']) {
      if (pj?.[step]?.ok === false) { a[step].failed++; continue }
      if (!o[step]) continue
      a[step].judged++
      const errs = o[step].errors ?? []
      const acc = errs.filter(e => !STYLE.has(e.code))
      a[step].errors += acc.length
      a[step].style += errs.length - acc.length
      for (const e of errs) a[step].byCode[e.code] = (a[step].byCode[e.code] ?? 0) + 1
      if (acc.length) a[step].jobsWithError++
      if (Number.isFinite(o[step].wording)) a[step].wording.push(o[step].wording)
    }
  }
  for (const c of v.cannotJudge ?? []) cannotJudge.push(`#${id}: ${c}`)
  for (const d of v.disagreements ?? []) {
    const named = String(d.who_is_right ?? '').replace(/\b([ABCD])\b/g, (_, L) => map[L] ?? L)
    disagreements.push({ jobId: id, topic: d.topic, who_is_right: named, why: d.why })
  }
}

const avg = xs => xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length * 10) / 10 : null
const lines = []
for (const step of ['enrich', 'match', 'gaps']) {
  lines.push(`== ${step}`)
  for (const m of models) {
    const a = agg[m][step]
    const p = mech.models[m].perStep[step]
    const errs = step === 'enrich' ? `${a.compErrors} comp + ${a.reqErrors} req` : `${a.errors}${a.style ? ` (+${a.style} style)` : ''}`
    lines.push(`${m}: ${a.jobsWithError}/${a.judged} jobs with an error, ${errs} errors, ${a.failed} failed, $${p.costPerJob?.toFixed(4)} per job, median ${(p.medianMs / 1000).toFixed(1)}s${a.wording ? `, wording ${avg(a.wording)}` : ''} ${JSON.stringify(a.byCode)}`)
  }
}
console.log(lines.join('\n'))
console.log(`verdict files: ${files.length}`)
writeFileSync('data/eval/judge/summary.json', JSON.stringify({ agg, cannotJudge, disagreements }, null, 2))
