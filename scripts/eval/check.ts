// Mechanical checks on the eval results, plus blinded packets for human-style judging.
//
//   npx tsx --tsconfig scripts/eval/tsconfig.json scripts/eval/check.ts <snapshotCopy.db> <tag> [outDir] [--no-packets]
//
// Reads data/eval/results/<tag>-<model>.json for every model present and writes:
// Output goes to outDir (default data/eval/judge):
// - <outDir>/mechanical.json: per model and job, the counts code can decide on its own
//   (format failures, evidence keys the app had to discard, quotes or figures the app dropped,
//   dashes and third person pronouns in text Devin reads), plus cost and latency per step.
// - <outDir>/packets/job-<id>.md: the posting, the knowledge base, the fixed input
//   requirements, and the four outputs under letters A to D in a random order per job.
// - <outDir>/key.json: which letter is which model. Judges never see it.
//
// Everything is written under data/, which is gitignored: packets hold posting text and the
// knowledge base.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { setupGlobals } from './globals'

const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
const [dbPath, tag = 'full', outDir = 'data/eval/judge'] = args
const writePackets = !process.argv.includes('--no-packets')
if (!dbPath) {
  console.error('usage: check.ts <snapshotCopy.db> [tag]')
  process.exit(2)
}

await setupGlobals({ databasePath: dbPath, anthropicApiKey: '', aiModel: 'none', aiFallbackModel: 'none', dailyAiBudgetUsd: '0', schedulerEnabled: 'false', demoToolPath: '' })
const { useDb } = await import('../../server/utils/db')
const { loadKnowledge } = await import('../../server/utils/knowledge')
const { knowledgeBlock } = await import('../../server/utils/enrich/extract')
const { jobs } = await import('../../server/db/schema')
const { inArray } = await import('drizzle-orm')

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-haiku-4-5']
const results: Record<string, any> = {}
for (const m of MODELS) {
  const p = `data/eval/results/${tag}-${m}.json`
  if (existsSync(p)) results[m] = JSON.parse(readFileSync(p, 'utf8'))
}
const models = Object.keys(results)
const jobIds = [...new Set(models.flatMap(m => Object.keys(results[m].enrich).map(Number)))]
const jobRows = useDb().select().from(jobs).where(inArray(jobs.id, jobIds)).all()
const jobById = new Map(jobRows.map(j => [j.id, j]))
const kb = knowledgeBlock(loadKnowledge())

const DASH = /[\u2013\u2014]/
const THIRD_PERSON = /\b(he|she|his|him|her|hers|himself|herself)\b/i
const STATUSES = ['have', 'partial', 'lack', 'unknown']

function median(xs: number[]) {
  const s = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b)
  if (!s.length) return null
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
}

function expectedMustHaves(reqs: any[]): number | null {
  const must = reqs.filter(r => r.mustHave)
  if (!must.length) return null
  const credit = must.reduce((s, r) => s + (r.status === 'have' ? 1 : r.status === 'partial' ? 0.5 : 0), 0)
  return Math.round(45 * credit / must.length)
}

const mechanical: any = { tag, models: {} }
for (const m of models) {
  const r = results[m]
  const perJob: any = {}
  const stepCost: Record<string, number[]> = { enrich: [], match: [], gaps: [] }
  const stepMs: Record<string, number[]> = { enrich: [], match: [], gaps: [] }
  const callErrors: string[] = []
  for (const id of jobIds) {
    const calls = r.calls.filter((c: any) => c.jobId === id)
    for (const step of ['enrich', 'match', 'gaps']) {
      const cs = calls.filter((c: any) => c.step === step)
      if (cs.length) {
        stepCost[step]!.push(cs.reduce((s: number, c: any) => s + c.costUsd, 0))
        stepMs[step]!.push(cs.reduce((s: number, c: any) => s + c.latencyMs, 0))
      }
    }
    for (const c of calls) {
      if (c.error || c.parsedNull || (c.stopReason && c.stopReason !== 'end_turn')) callErrors.push(`#${id} ${c.step}: ${c.error ?? `stop ${c.stopReason}${c.parsedNull ? ', no parsed output' : ''}`}`)
      if (c.servedModel && !c.servedModel.startsWith(m)) callErrors.push(`#${id} ${c.step}: served by ${c.servedModel}`)
    }

    const job = jobById.get(id)!
    const inputReqs = JSON.parse(job.requirementsJson ?? '[]')
    const e = r.enrich[id]
    const enrichCall = calls.find((c: any) => c.step === 'enrich' && c.parsed)
    const raw = enrichCall?.parsed?.requirements ?? []
    const validated = e?.requirements ?? []
    const discardedEvidence = raw.filter((q: any, i: number) => {
      const said = String(q.status).toLowerCase().trim()
      return said !== 'unknown' && STATUSES.includes(said) && validated[i]?.status === 'unknown'
    }).length
    const badStatus = raw.filter((q: any) => !STATUSES.includes(String(q.status).toLowerCase().trim())).length
    const dropped = (e?.comp?.notes ?? '').match(/Dropped [^.]*\./g) ?? []

    const mt = r.match[id]
    const skills = mt?.breakdown?.skills
    const gp = r.gaps[id]
    const gapCalls = calls.filter((c: any) => c.step === 'gaps')
    const candidates = gapCalls[0]?.parsed?.candidates ?? null
    const decisions = gapCalls[1]?.parsed?.decisions ?? null
    const gapText = [
      ...(gp?.gap?.items ?? []).map((i: any) => i.rationale),
      ...(candidates ?? []).map((c: any) => c.question),
      ...(gp?.gap?.items ?? []).flatMap((i: any) => i.demoIdea ? [i.demoIdea.title, i.demoIdea.summary] : []),
    ].join(' ')

    perJob[id] = {
      enrich: {
        ok: !!e?.ok,
        error: e?.ok ? null : e?.error ?? 'missing',
        requirements: validated.length,
        rawStatusCounts: Object.fromEntries(STATUSES.map(s => [s, raw.filter((q: any) => String(q.status).toLowerCase().trim() === s).length])),
        discardedEvidence,
        badStatus,
        compConfidence: e?.comp?.confidence ?? null,
        base: e?.comp ? [e.comp.baseMin, e.comp.baseMax, e.comp.basePeriod] : null,
        rawBenefits: e?.extraction?.benefits?.length ?? 0,
        keptBenefits: e?.comp?.benefits?.length ?? 0,
        dropped,
      },
      match: {
        ok: !!mt?.ok,
        error: mt?.ok ? null : JSON.stringify(mt?.stats?.errors ?? mt?.error ?? 'missing'),
        skills: skills?.score ?? null,
        parts: skills?.parts ?? null,
        expectedMustHaves: expectedMustHaves(inputReqs),
        final: mt?.breakdown?.final ?? null,
        dash: DASH.test(skills?.reasoning ?? ''),
        thirdPerson: THIRD_PERSON.test(skills?.reasoning ?? ''),
        reasoningWords: (skills?.reasoning ?? '').split(/\s+/).filter(Boolean).length,
      },
      gaps: {
        ok: !!gp?.ok,
        error: gp?.ok ? null : gp?.error ?? 'missing',
        candidates: candidates?.length ?? null,
        items: gp?.gap?.items?.length ?? null,
        decisions: (gp?.gap?.items ?? []).reduce((acc: any, i: any) => ({ ...acc, [i.decision]: (acc[i.decision] ?? 0) + 1 }), {}),
        decisionCall: decisions != null,
        demo: (gp?.gap?.items ?? []).find((i: any) => i.decision === 'demo')?.demoIdea?.title ?? null,
        questionsCreated: gp?.questionsCreated?.length ?? 0,
        dash: DASH.test(gapText),
        thirdPerson: THIRD_PERSON.test((gp?.gap?.items ?? []).map((i: any) => i.rationale).join(' ')),
      },
    }
  }
  mechanical.models[m] = {
    spentUsd: r.spentUsd,
    stoppedBy: r.stoppedBy,
    callErrors,
    perStep: Object.fromEntries(['enrich', 'match', 'gaps'].map(s => [s, {
      jobs: stepCost[s]!.length,
      costPerJob: stepCost[s]!.length ? stepCost[s]!.reduce((a, b) => a + b, 0) / stepCost[s]!.length : null,
      medianMs: median(stepMs[s]!),
    }])),
    perJob,
  }
}

mkdirSync(`${outDir}/packets`, { recursive: true })
writeFileSync(`${outDir}/mechanical.json`, JSON.stringify(mechanical, null, 2))

// ── Blinded packets ──
const letters = ['A', 'B', 'C', 'D']
const key: Record<number, Record<string, string>> = {}
function shuffle<T>(xs: T[]): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}
const fence = (obj: unknown) => '```json\n' + JSON.stringify(obj, null, 1) + '\n```'

for (const id of writePackets ? jobIds : []) {
  const job = jobById.get(id)!
  const order = shuffle(models)
  key[id] = Object.fromEntries(order.map((m, i) => [letters[i]!, m]))
  const inputReqs = JSON.parse(job.requirementsJson ?? '[]')
  const parts: string[] = []
  parts.push(`# Job ${id}: ${job.title} at ${job.company} (${job.source})`, '', `Location: ${job.location ?? 'not stated'}`, '')
  parts.push('## Posting text (exactly what every model read)', '', '```text', job.postingText ?? '', '```', '')
  parts.push('## Candidate knowledge base (the only evidence of what the candidate has)', '', '```text', kb, '```', '')
  parts.push('## Fixed input requirements (given to every model for MATCH and GAPS; produced earlier by production, not by A to D)', '', fence(inputReqs), '')
  parts.push(`Expected mustHaves from these statuses (45 x share of must-haves with have = 1, partial = 0.5): ${expectedMustHaves(inputReqs) ?? 'no must-haves'}`, '')
  for (const [i, m] of order.entries()) {
    const L = letters[i]!
    const r = results[m]
    const calls = r.calls.filter((c: any) => c.jobId === id)
    const e = r.enrich[id]
    const mt = r.match[id]
    const gp = r.gaps[id]
    const gapCalls = calls.filter((c: any) => c.step === 'gaps')
    parts.push(`---`, '', `# Output ${L}`, '')
    parts.push(`## ${L}: ENRICH`, '')
    if (!e?.ok) parts.push(`FAILED: ${e?.error ?? 'missing'}`, '')
    else {
      parts.push('Compensation as the model extracted it:', '', fence(e.extraction), '')
      parts.push('Compensation after the app checked quotes and figures (what Devin sees; items whose quote is not verbatim in the posting are dropped, see notes):', '', fence({ currency: e.comp.currency, baseMin: e.comp.baseMin, baseMax: e.comp.baseMax, basePeriod: e.comp.basePeriod, confidence: e.comp.confidence, bonus: e.comp.bonus, equity: e.comp.equity, benefits: e.comp.benefits.map((b: any) => `${b.name} [${b.category}]: ${b.detail}${b.estimatedAnnualValue != null ? ` (valued ${b.estimatedAnnualValue}/yr)` : ''}`), notes: e.comp.notes }), '')
      const raw = calls.find((c: any) => c.step === 'enrich' && c.parsed)?.parsed?.requirements ?? []
      parts.push('Requirements (status as the model said it, then as stored after the app discarded evidence keys that do not exist):', '')
      parts.push('| # | requirement | must | model status (evidence) | stored status |', '|---|---|---|---|---|')
      raw.forEach((q: any, k: number) => {
        const v = e.requirements[k]
        parts.push(`| ${k + 1} | ${q.text} | ${q.mustHave ? 'must' : 'nice'} | ${q.status}${q.evidence ? ` (${q.evidence})` : ''} | ${v ? v.status : 'cut (over 20)'} |`)
      })
      parts.push('')
    }
    parts.push(`## ${L}: MATCH (input: the fixed requirements above)`, '')
    if (!mt?.ok) parts.push(`FAILED: ${JSON.stringify(mt?.stats?.errors ?? mt?.error ?? 'missing')}`, '')
    else {
      const s = mt.breakdown.skills
      parts.push(fence({ parts: s.parts, skillsScore: s.score, reasoning: s.reasoning, matched: s.matched, missing: s.missing }), '')
    }
    parts.push(`## ${L}: GAP ANALYSIS (input: the fixed requirements above)`, '')
    if (!gp?.ok) parts.push(`FAILED: ${gp?.error ?? 'missing'}`, '')
    else {
      parts.push('Step 1, the model\'s gap candidates:', '', fence(gapCalls[0]?.parsed?.candidates ?? null), '')
      if (gapCalls[1]) parts.push('Step 3, the model\'s decisions for confirmed gaps (index refers to the confirmed list, in candidate order after code filtering):', '', fence(gapCalls[1]?.parsed?.decisions ?? null), '')
      else parts.push('Step 3 did not run: no confirmed partial or lack gaps a code project could show.', '')
      parts.push('Final result after code rules (what Devin sees):', '', fence({ summary: gp.gap.summary, items: gp.gap.items.map((x: any) => ({ requirement: x.requirement, mustHave: x.mustHave, decision: x.decision, rationale: x.rationale, demoIdea: x.demoIdea })) }), '')
      if (gp.questionsCreated?.length) parts.push('New questions it would ask Devin:', '', fence(gp.questionsCreated.map((q: any) => ({ kind: q.kind, subject: q.subject, question: q.question }))), '')
    }
  }
  writeFileSync(`${outDir}/packets/job-${id}.md`, parts.join('\n'))
}
if (writePackets) writeFileSync(`${outDir}/key.json`, JSON.stringify(key, null, 2))

for (const m of models) {
  const mm = mechanical.models[m]
  console.log(`${m}: spent $${mm.spentUsd?.toFixed(4)}${mm.stoppedBy ? ` STOPPED ${mm.stoppedBy}` : ''}, call errors ${mm.callErrors.length}`)
  for (const s of ['enrich', 'match', 'gaps']) {
    const p = mm.perStep[s]
    console.log(`  ${s}: ${p.jobs} jobs, $${p.costPerJob?.toFixed(4)} per job, median ${p.medianMs}ms`)
  }
  for (const e of mm.callErrors.slice(0, 10)) console.log(`  ! ${e}`)
}
console.log(writePackets ? `packets: ${jobIds.length} written to ${outDir}/packets` : 'packets skipped')
