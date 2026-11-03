// Round two summary: before and after the prompt fixes, judged together under rubric-v2.md.
//
//   node scripts/eval/summarize-ab.mjs [abDir]     (default data/eval/judge-ab)
//
// Reads <abDir>/key.json, <abDir>/verdicts/job-<id>.json, and mechanical.json from
// data/eval/judge (round one, before) and data/eval/judge-fix (after) for cost and latency.
// An error counts once per output and field (the judge names the field). Style codes (M4, G7)
// are counted apart. Inherited errors (the output repeated a wrong input status) are counted and
// also shown on their own.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'

const dir = process.argv[2] ?? 'data/eval/judge-ab'
const key = JSON.parse(readFileSync(`${dir}/key.json`, 'utf8'))
const mech = {
  full: JSON.parse(readFileSync('data/eval/judge/mechanical.json', 'utf8')),
  fix: JSON.parse(readFileSync('data/eval/judge-fix/mechanical.json', 'utf8')),
}
const STYLE = new Set(['M4', 'G7'])

function kindOf(step, e) {
  const c = e.code
  if (step === 'comp') return ['C3', 'C6'].includes(c) ? 'comp: base pay range dropped or joined' : ['C1', 'C2'].includes(c) ? 'comp: figure in the wrong field, unit, or currency' : 'comp: non-pay item filed as pay'
  if (step === 'reqs') {
    if (c === 'R1') return 'reqs: status too high'
    if (c === 'R4') return /stored have/i.test(e.detail ?? '') ? 'reqs: status too high' : 'reqs: status too low'
    if (c === 'R2' || c === 'R3') return 'reqs: status too low'
    return /marked (nice|must)/i.test(e.detail ?? '') ? 'reqs: must or nice wrong' : 'reqs: not a requirement, split, or merged'
  }
  if (step === 'match') return c === 'M1' ? (e.inherited ? 'match: claim repeats a wrong input status' : 'match: claim contradicts the knowledge base') : c === 'M2' ? 'match: score part off the rubric' : c === 'M3' ? 'match: misstates the job' : 'style'
  return c === 'G1' || c === 'G2' ? 'gaps: candidate list wrong' : c === 'G3' ? 'gaps: showable flag wrong' : c === 'G4' ? 'gaps: question not one-tap yes or no' : c === 'G5' ? 'gaps: plan or reframe wrong' : c === 'G6' ? 'gaps: states a fact the KB does not' : 'style'
}

function oncePerField(list) {
  const seen = new Set()
  return (list ?? []).filter((e) => {
    const f = String(e.field ?? e.row ?? e.code).toLowerCase().trim()
    if (seen.has(f)) return false
    seen.add(f)
    return true
  })
}

const agg = {}
const get = (label) => (agg[label] ??= {
  comp: { jobs: 0, errors: 0, items: 0, judged: 0, kinds: {} },
  reqs: { jobs: 0, errors: 0, rows: 0, judged: 0, kinds: {}, mustHavesMissed: 0, benefitsMissed: 0 },
  match: { jobs: 0, errors: 0, inherited: 0, style: 0, judged: 0, kinds: {}, wording: [] },
  gaps: { jobs: 0, errors: 0, inherited: 0, style: 0, candidates: 0, judged: 0, kinds: {}, wording: [] },
})
const files = existsSync(`${dir}/verdicts`) ? readdirSync(`${dir}/verdicts`).filter(f => /^job-\d+\.json$/.test(f)) : []
for (const f of files) {
  const v = JSON.parse(readFileSync(`${dir}/verdicts/${f}`, 'utf8'))
  const k = key[v.jobId]
  for (const [letter, label] of Object.entries(k.enrich)) {
    const o = v.enrich?.[letter]
    if (!o) continue
    const a = get(label)
    const comp = oncePerField(o.comp)
    const reqs = oncePerField(o.reqs)
    a.comp.judged++; a.reqs.judged++
    a.comp.errors += comp.length; a.reqs.errors += reqs.length
    a.comp.items += Number(o.compItems) || 0; a.reqs.rows += Number(o.requirementRows) || 0
    a.reqs.mustHavesMissed += Number(o.mustHavesMissed) || 0; a.reqs.benefitsMissed += Number(o.benefitsMissed) || 0
    if (comp.length) a.comp.jobs++
    if (reqs.length) a.reqs.jobs++
    for (const e of comp) a.comp.kinds[kindOf('comp', e)] = (a.comp.kinds[kindOf('comp', e)] ?? 0) + 1
    for (const e of reqs) a.reqs.kinds[kindOf('reqs', e)] = (a.reqs.kinds[kindOf('reqs', e)] ?? 0) + 1
  }
  for (const step of ['match', 'gaps']) {
    for (const [letter, label] of Object.entries(k[step])) {
      const o = v[step]?.[letter]
      if (!o) continue
      const a = get(label)[step]
      const errs = oncePerField(o.errors)
      const acc = errs.filter(e => !STYLE.has(e.code))
      a.judged++
      a.errors += acc.length
      a.inherited += acc.filter(e => e.inherited).length
      a.style += errs.length - acc.length
      if (step === 'gaps') a.candidates += Number(o.candidates) || 0
      if (acc.length) a.jobs++
      for (const e of acc) a.kinds[kindOf(step, e)] = (a.kinds[kindOf(step, e)] ?? 0) + 1
      if (Number.isFinite(o.wording)) a.wording.push(o.wording)
    }
  }
}

const avg = xs => xs.length ? (xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(1) : 'n/a'
const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : 'n/a'
const labels = Object.keys(agg).sort()
for (const label of labels) {
  const [model, tag] = label.split('@')
  const a = agg[label]
  const per = mech[tag]?.models?.[model]?.perStep ?? {}
  const c = s => per[s] ? `$${per[s].costPerJob.toFixed(4)}/job, median ${(per[s].medianMs / 1000).toFixed(1)}s` : ''
  console.log(`== ${label}`)
  console.log(`  enrich: comp ${a.comp.jobs}/${a.comp.judged} jobs, ${a.comp.errors} errors in ${a.comp.items} items (${pct(a.comp.errors, a.comp.items)}); reqs ${a.reqs.jobs}/${a.reqs.judged} jobs, ${a.reqs.errors} errors in ${a.reqs.rows} rows (${pct(a.reqs.errors, a.reqs.rows)}); must-haves missed ${a.reqs.mustHavesMissed}, benefits missed ${a.reqs.benefitsMissed}; ${c('enrich')}`)
  console.log(`    ${JSON.stringify({ ...a.comp.kinds, ...a.reqs.kinds })}`)
  console.log(`  match: ${a.match.jobs}/${a.match.judged} jobs, ${a.match.errors} errors (${a.match.inherited} inherited, +${a.match.style} style), wording ${avg(a.match.wording)}; ${c('match')}`)
  console.log(`    ${JSON.stringify(a.match.kinds)}`)
  console.log(`  gaps: ${a.gaps.jobs}/${a.gaps.judged} jobs, ${a.gaps.errors} errors in ${a.gaps.candidates} candidates (${pct(a.gaps.errors, a.gaps.candidates)}, ${a.gaps.inherited} inherited, +${a.gaps.style} style), wording ${avg(a.gaps.wording)}; ${c('gaps')}`)
  console.log(`    ${JSON.stringify(a.gaps.kinds)}`)
}
console.log(`verdict files: ${files.length}`)
writeFileSync(`${dir}/summary.json`, JSON.stringify(agg, null, 2))
