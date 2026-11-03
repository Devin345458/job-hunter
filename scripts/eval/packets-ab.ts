// Round two packets: each model's output before and after the prompt fixes, blinded together, so
// one judge scores both under the same rubric.
//
//   npx tsx --tsconfig scripts/eval/tsconfig.json scripts/eval/packets-ab.ts <snapshotCopy.db> <beforeTag> <afterTag> <outDir> <model,model,...>
//
// Writes <outDir>/packets/job-<id>.md and <outDir>/key.json. Each step has its own letters, in a
// random order per job and per step: enrich A B D E F H, match I J K L N O, gaps P Q S T U V
// (C, G, M, and R are skipped so letters never look like rubric codes). The key maps a letter to
// "<model>@<tag>". Unlike round one, the packet also prints the knowledge base exactly as the gap
// step reads it (every entry, profile and preferences included), because analyzeGaps() uses
// formatKnowledge(knowledgeMap(loadKnowledge())) while enrich and match use knowledgeBlock().

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { setupGlobals } from './globals'

const [dbPath, beforeTag, afterTag, outDir, modelsArg] = process.argv.slice(2)
if (!dbPath || !beforeTag || !afterTag || !outDir || !modelsArg) {
  console.error('usage: packets-ab.ts <db> <beforeTag> <afterTag> <outDir> <models>')
  process.exit(2)
}
await setupGlobals({ databasePath: dbPath, anthropicApiKey: '', aiModel: 'none', aiFallbackModel: 'none', dailyAiBudgetUsd: '0', schedulerEnabled: 'false', demoToolPath: '' })
const { useDb } = await import('../../server/utils/db')
const { loadKnowledge, knowledgeMap } = await import('../../server/utils/knowledge')
const { knowledgeBlock } = await import('../../server/utils/enrich/extract')
const { formatKnowledge } = await import('../../server/utils/ai')
const { jobs } = await import('../../server/db/schema')
const { inArray } = await import('drizzle-orm')

const models = modelsArg.split(',')
const sources: Array<{ label: string; r: any }> = []
for (const m of models) {
  for (const tag of [beforeTag, afterTag]) {
    sources.push({ label: `${m}@${tag}`, r: JSON.parse(readFileSync(`data/eval/results/${tag}-${m}.json`, 'utf8')) })
  }
}
const jobIds = [...new Set(sources.flatMap(s => Object.keys(s.r.enrich).map(Number)))].sort((a, b) => a - b)
const jobById = new Map(useDb().select().from(jobs).where(inArray(jobs.id, jobIds)).all().map(j => [j.id, j]))
const entries = loadKnowledge()
const kbEnrich = knowledgeBlock(entries)
// Contact details are blanked; nothing in the gap prompt depends on them for judging.
const kbGaps = formatKnowledge(knowledgeMap(entries)).replace(/^(\*\*profile\/(Email|Phone):\*\*) .*$/gim, '$1 [redacted]')

const LETTERS = { enrich: ['A', 'B', 'D', 'E', 'F', 'H'], match: ['I', 'J', 'K', 'L', 'N', 'O'], gaps: ['P', 'Q', 'S', 'T', 'U', 'V'] } as const
function shuffle<T>(xs: T[]): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}
const fence = (obj: unknown) => '```json\n' + JSON.stringify(obj, null, 1) + '\n```'
function expectedMustHaves(reqs: any[]): number | null {
  const must = reqs.filter(r => r.mustHave)
  if (!must.length) return null
  return Math.round(45 * must.reduce((s, r) => s + (r.status === 'have' ? 1 : r.status === 'partial' ? 0.5 : 0), 0) / must.length)
}

mkdirSync(`${outDir}/packets`, { recursive: true })
mkdirSync(`${outDir}/verdicts`, { recursive: true })
const key: Record<number, Record<string, Record<string, string>>> = {}
for (const id of jobIds) {
  const job = jobById.get(id)!
  const inputReqs = JSON.parse(job.requirementsJson ?? '[]')
  key[id] = {}
  const parts: string[] = []
  parts.push(`# Job ${id}: ${job.title} at ${job.company} (${job.source})`, '', `Location: ${job.location ?? 'not stated'}`, '')
  parts.push('## Posting text (exactly what every model read)', '', '```text', job.postingText ?? '', '```', '')
  parts.push('## Knowledge base the ENRICH and MATCH steps read', '', '```text', kbEnrich, '```', '')
  parts.push('## Knowledge base the GAP step read (every entry, including profile and preferences; judge G codes against this one)', '', '```text', kbGaps, '```', '')
  parts.push('## Fixed input requirements (given to every MATCH and GAP output below; produced earlier by production, not by any output here)', '', fence(inputReqs), '')
  parts.push(`Expected mustHaves from these statuses (45 x share of must-haves with have = 1, partial = 0.5): ${expectedMustHaves(inputReqs) ?? 'no must-haves'}`, '')

  // ── Enrich ──
  const enrichOrder = shuffle(sources)
  key[id].enrich = Object.fromEntries(enrichOrder.map((s, i) => [LETTERS.enrich[i]!, s.label]))
  parts.push('---', '', '# ENRICH outputs', '')
  enrichOrder.forEach((s, i) => {
    const L = LETTERS.enrich[i]!
    const e = s.r.enrich[id]
    parts.push(`## Enrich ${L}`, '')
    if (!e?.ok) {
      parts.push(`FAILED: ${e?.error ?? 'missing'}`, '')
      return
    }
    parts.push('Compensation as the model extracted it:', '', fence(e.extraction), '')
    parts.push('Compensation after the app checked quotes and figures (what Devin sees; items whose quote is not verbatim in the posting are dropped, see notes):', '', fence({ currency: e.comp.currency, baseMin: e.comp.baseMin, baseMax: e.comp.baseMax, basePeriod: e.comp.basePeriod, confidence: e.comp.confidence, bonus: e.comp.bonus, equity: e.comp.equity, benefits: e.comp.benefits.map((b: any) => `${b.name} [${b.category}]: ${b.detail}${b.estimatedAnnualValue != null ? ` (valued ${b.estimatedAnnualValue}/yr)` : ''}`), notes: e.comp.notes }), '')
    const raw = s.r.calls.find((c: any) => c.jobId === id && c.step === 'enrich' && c.parsed)?.parsed?.requirements ?? []
    parts.push('Requirements (status as the model said it, then as stored after the app discarded evidence keys that do not exist):', '')
    parts.push('| # | requirement | must | model status (evidence) | stored status |', '|---|---|---|---|---|')
    raw.forEach((q: any, k: number) => {
      const v = e.requirements[k]
      parts.push(`| ${k + 1} | ${q.text} | ${q.mustHave ? 'must' : 'nice'} | ${q.status}${q.evidence ? ` (${q.evidence})` : ''} | ${v ? v.status : 'cut (over 20)'} |`)
    })
    parts.push('')
  })

  // ── Match ──
  const matchOrder = shuffle(sources)
  key[id].match = Object.fromEntries(matchOrder.map((s, i) => [LETTERS.match[i]!, s.label]))
  parts.push('---', '', '# MATCH outputs (input: the fixed requirements above)', '')
  matchOrder.forEach((s, i) => {
    const L = LETTERS.match[i]!
    const mt = s.r.match[id]
    parts.push(`## Match ${L}`, '')
    if (!mt?.ok) parts.push(`FAILED: ${JSON.stringify(mt?.stats?.errors ?? mt?.error ?? 'missing')}`, '')
    else {
      const k = mt.breakdown.skills
      parts.push(fence({ parts: k.parts, skillsScore: k.score, reasoning: k.reasoning, matched: k.matched, missing: k.missing }), '')
    }
  })

  // ── Gaps ──
  const gapOrder = shuffle(sources)
  key[id].gaps = Object.fromEntries(gapOrder.map((s, i) => [LETTERS.gaps[i]!, s.label]))
  parts.push('---', '', '# GAP ANALYSIS outputs (input: the fixed requirements above; judge against the GAP knowledge base)', '')
  gapOrder.forEach((s, i) => {
    const L = LETTERS.gaps[i]!
    const gp = s.r.gaps[id]
    const gapCalls = s.r.calls.filter((c: any) => c.jobId === id && c.step === 'gaps')
    parts.push(`## Gaps ${L}`, '')
    if (!gp?.ok) {
      parts.push(`FAILED: ${gp?.error ?? 'missing'}`, '')
      return
    }
    parts.push('Step 1, the model\'s gap candidates:', '', fence(gapCalls[0]?.parsed?.candidates ?? null), '')
    if (gapCalls[1]) parts.push('Step 3, the model\'s decisions for confirmed gaps (index refers to the confirmed list, in candidate order after code filtering):', '', fence(gapCalls[1]?.parsed?.decisions ?? null), '')
    else parts.push('Step 3 did not run: no confirmed partial or lack gaps a code project could show.', '')
    parts.push('Final result after code rules (what Devin sees):', '', fence({ summary: gp.gap.summary, items: gp.gap.items.map((x: any) => ({ requirement: x.requirement, mustHave: x.mustHave, decision: x.decision, rationale: x.rationale, demoIdea: x.demoIdea })) }), '')
    if (gp.questionsCreated?.length) parts.push('New questions it would ask Devin:', '', fence(gp.questionsCreated.map((q: any) => ({ kind: q.kind, subject: q.subject, question: q.question }))), '')
  })
  writeFileSync(`${outDir}/packets/job-${id}.md`, parts.join('\n'))
}
writeFileSync(`${outDir}/key.json`, JSON.stringify(key, null, 2))
console.log(`${jobIds.length} packets written to ${outDir}/packets for ${sources.length} outputs per step`)
