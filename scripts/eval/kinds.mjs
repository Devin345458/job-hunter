// Error kinds per model and the systematic errors (same job and field, three or four models).
//
//   node scripts/eval/kinds.mjs [judgeDir] [resultsTag]     (defaults data/eval/judge, full)
//
// Reads <judgeDir>/errors.json (from errors.mjs) and <judgeDir>/mechanical.json. Kinds are mapped
// from the rubric code, and for R4 and R5 from the judge's wording ("Stored have" means the
// status was too high; "Marked nice" or "Marked must" means must or nice was wrong). An error
// counts once per job, model, and field: requirement errors by row, everything else by code.
// The systematic groups are listed by hand below (found by reading every error on every job) and
// counted here, so the count of models per group is checked against the verdicts.

import { readFileSync } from 'node:fs'

const dir = process.argv[2] ?? 'data/eval/judge'
const E = JSON.parse(readFileSync(`${dir}/errors.json`, 'utf8'))
const mech = JSON.parse(readFileSync(`${dir}/mechanical.json`, 'utf8'))
const models = Object.keys(mech.models)

// Match errors that repeat a wrong status from the stored input (checked against requirements_json).
const INHERITED = [
  { jobId: 452, re: /onboard/i },
  { jobId: 444, re: /7\+ years/i },
  { jobId: 624, re: /8\+ years/i },
  { jobId: 649, re: /infrastructure/i },
]

function kindOf(e) {
  if (e.step === 'comp') {
    if (['C3', 'C6'].includes(e.code)) return 'comp: base pay range dropped or joined'
    if (['C1', 'C2'].includes(e.code)) return 'comp: figure in the wrong field, unit, or currency'
    return 'comp: non-pay item filed as pay (price, purchase plan, donation match)'
  }
  if (e.step === 'reqs') {
    if (e.code === 'R1') return 'reqs: status too high'
    if (e.code === 'R4') return /stored have/i.test(e.detail) ? 'reqs: status too high' : 'reqs: status too low'
    if (e.code === 'R2' || e.code === 'R3') return 'reqs: status too low'
    return /marked (nice|must)/i.test(e.detail) ? 'reqs: must or nice wrong' : 'reqs: not a requirement, split, or merged'
  }
  if (e.step === 'match') {
    if (e.code === 'M1') return INHERITED.some(x => x.jobId === e.jobId && x.re.test(e.detail)) ? 'match: claim repeats a wrong input status' : 'match: claim contradicts the knowledge base'
    if (e.code === 'M2') return 'match: score part off the rubric'
    if (e.code === 'M3') return 'match: misstates the job'
    return 'style: dash or third person'
  }
  if (e.code === 'G1' || e.code === 'G2') return 'gaps: candidate list wrong (missed or extra)'
  if (e.code === 'G3') return 'gaps: showable flag wrong'
  if (e.code === 'G4') return 'gaps: question not a one-tap yes or no'
  if (e.code === 'G5') return 'gaps: plan or reframe wrong'
  if (e.code === 'G6') return 'gaps: states a fact the knowledge base does not'
  return 'style: dash or third person'
}

// One per job, model, and field.
const seen = new Set()
const unique = E.filter((e) => {
  const field = e.step === 'reqs' && e.row ? `row${e.row}` : e.code
  const k = `${e.jobId}|${e.model}|${e.step}|${field}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})

const kinds = [...new Set(unique.map(kindOf))].sort()
const short = m => m.replace('claude-', '')
console.log(`== error kinds (one per job and field), columns: ${models.map(short).join(', ')}`)
for (const k of kinds) console.log(`${k}: ${models.map(m => unique.filter(e => e.model === m && kindOf(e) === k).length).join(', ')}`)

// Denominators
console.log('\n== errors per field')
for (const m of models) {
  const J = Object.values(mech.models[m].perJob)
  const rows = J.reduce((s, j) => s + j.enrich.requirements, 0)
  const comp = J.reduce((s, j) => s + j.enrich.rawBenefits + (j.enrich.base?.[0] != null || j.enrich.base?.[1] != null ? 1 : 0), 0)
  const cands = J.reduce((s, j) => s + (j.gaps.candidates ?? 0), 0)
  const n = step => unique.filter(e => e.model === m && e.step === step && !/^style/.test(kindOf(e))).length
  console.log(`${short(m)}: requirements ${n('reqs')}/${rows} rows (${(100 * n('reqs') / rows).toFixed(1)}%), comp ${n('comp')}/${comp} items (${(100 * n('comp') / comp).toFixed(1)}%), match ${n('match')} in 20 jobs, gaps ${n('gaps')}/${cands} candidates (${(100 * n('gaps') / cands).toFixed(1)}%)`)
}

// Systematic groups
const GROUPS = [
  { id: 'S1', jobId: 627, step: 'comp', test: e => ['C3', 'C6'].includes(e.code), what: 'Calendly base joined Tier 3 min to Tier 1 max, app dropped it' },
  { id: 'S2', jobId: 419, step: 'comp', test: e => ['C3', 'C6'].includes(e.code), what: 'Toast base joined or quoted across lines, app dropped it' },
  { id: 'S3', jobId: 624, step: 'comp', test: e => e.code === 'C3', what: 'Gusto base joined Denver min to San Francisco max' },
  { id: 'S4', jobId: 445, step: 'comp', test: e => e.code === 'C2' && /euro|1250/i.test(e.detail), what: 'Nearform remote allowance in euros stored as a USD amount' },
  { id: 'S5', jobId: 658, step: 'comp', test: e => /literacy|\$85|85 per year/i.test(e.detail), what: 'SkySlope $85 membership price valued as a benefit' },
  { id: 'S6', jobId: 658, step: 'comp', test: e => /stock purchase/i.test(e.detail), what: 'SkySlope stock purchase plan stored as equity' },
  { id: 'S7', jobId: 631, step: 'comp', test: e => /donation/i.test(e.detail), what: 'Anthropic donation matching stored as equity' },
  { id: 'S8', jobId: 729, step: 'reqs', test: e => /clickhouse/i.test(`${e.requirement} ${e.detail}`), what: 'Railway ClickHouse from a past project listed as a requirement' },
  { id: 'S9', jobId: 729, step: 'reqs', test: e => /nix/i.test(`${e.requirement} ${e.detail}`), what: 'Railway Nix packages from a past project listed as a requirement' },
  { id: 'S10', jobId: 704, step: 'reqs', test: e => /\bSQL\b/.test(`${e.requirement} ${e.detail}`), what: '1Password SQL judged partial or unknown against MySQL' },
  { id: 'S11', jobId: 419, step: 'reqs', test: e => /object-oriented|Kotlin/i.test(`${e.requirement} ${e.detail}`), what: 'Toast "Kotlin, Java or another object-oriented language" not have on PHP' },
  { id: 'S12', jobId: 453, step: 'reqs', test: e => /PostgreSQL \(or MySQL\)/i.test(`${e.requirement}`), what: 'Mitre "PostgreSQL (or MySQL)" partial on MySQL' },
  { id: 'S13', jobId: 452, step: 'match', test: e => /onboard/i.test(e.detail), what: 'Lemon.io "fast onboarding" matched (input said have)' },
  { id: 'S14', jobId: 444, step: 'gaps', test: e => /schema migrations/i.test(e.detail), what: 'Kit "schema migrations at scale" marked showable' },
  { id: 'S15', jobId: 642, step: 'gaps', test: e => e.code === 'G3' && /(reliable|scalable|production)/i.test(e.detail), what: 'Spotify "reliable, scalable ML systems" marked showable' },
  { id: 'S16', jobId: 690, step: 'gaps', test: e => /open to using AI/i.test(e.detail), what: 'Vanta "Open to using AI" listed as a gap' },
  { id: 'S17', jobId: 721, step: 'gaps', test: e => e.code === 'G2' && /GitHub/.test(e.detail), what: 'Linear "GitHub" listed as a gap' },
  { id: 'S18', jobId: 642, step: 'gaps', test: e => /large-scale datasets/i.test(e.detail), what: 'Spotify "large-scale datasets" listed as a gap or showable' },
  { id: 'S19', jobId: 454, step: 'gaps', test: e => e.code === 'G2' && /soft skill/i.test(e.detail), what: 'Lemon.io soft skills (English, reliability, adaptability) listed as gaps' },
  { id: 'S20', jobId: 739, step: 'gaps', test: e => /interest in or prior experience/i.test(e.detail), what: 'Cohere reused the pending "interest in or prior experience" security question' },
  { id: 'S21', jobId: 704, step: 'gaps', test: e => /4\+ years/i.test(e.detail), what: '1Password "4+ years in marketing" listed as a gap' },
]
console.log('\n== systematic groups: models with this error on this job and field')
for (const g of GROUPS) {
  const hit = models.filter(m => E.some(e => e.jobId === g.jobId && e.model === m && e.step === g.step && g.test(e)))
  console.log(`${g.id} ${hit.length}/4 ${g.what}: ${hit.map(short).join(', ')}`)
}
