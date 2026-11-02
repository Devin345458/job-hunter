import type { GapAnalysis } from '#shared/types/pipeline'
import { fixPlurals } from '#shared/utils/plain-text'
import { loadKnowledge } from '../knowledge'

// Gap analyses stored by older runs, and the rationale Claude writes, carry internal text:
// "9 gap(s)", "waiting on Devin", "(kind: skill, nice to have)", and knowledge base references
// such as "skill/Laravel" or "experience/Applied Imagination". This turns them into plain words
// for the demo detail page. References are matched against the real knowledge base keys, so a
// key with spaces ("Mihlfeld and Associates") is replaced whole.

/** The word that follows the name: "your Laravel entry", "your Applied Imagination role". */
const NOUN: Record<string, string> = {
  skill: 'entry',
  experience: 'role',
  project: 'project',
  education: 'entry',
  profile: 'entry',
  preference: 'answer',
  personal: 'answer',
}
const CATEGORIES = Object.keys(NOUN).join('|')
/** A noun Claude already wrote after the reference, dropped so it is not said twice. */
const TRAILING_NOUN = '(?:\\s+(?:entry|role|project|answer)\\b)?'
/** "the skill/TypeScript entry" and "his skill/Vue.js" become "your TypeScript entry", not "the your". */
const LEADING_WORD = '(?<pre>\\b(?:the|his|her)\\s+)?'

interface Reference {
  category: string
  /** What Claude may have written after the slash. */
  name: string
  /** What the page says instead. */
  label: string
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Every knowledge key, plus the company part of "Company - Title" experience keys, longest first. */
function knowledgeReferences(): Reference[] {
  const refs: Reference[] = []
  for (const entry of loadKnowledge()) {
    const category = entry.category.toLowerCase()
    if (!NOUN[category]) continue
    const key = entry.key.trim()
    const short = key.split(/\s+-\s+/)[0]!.trim()
    for (const name of new Set([key, short])) refs.push({ category, name, label: short })
  }
  return refs.sort((a, b) => b.name.length - a.name.length)
}

/** "Your" at the start of a sentence or after a capitalized "The", "your" anywhere else. */
function your(pre: string | undefined, whole: string, offset: number): string {
  // A sentence can end inside a quote: 'over 1000%." skill/Node.js adds' starts a new one.
  const capital = pre ? /^[A-Z]/.test(pre) : offset === 0 || /[.!?]["')\]]*\s+$/.test(whole.slice(Math.max(0, offset - 8), offset))
  return capital ? 'Your' : 'your'
}

export function plainGapText(text: string, refs: Reference[]): string {
  if (!text) return text
  let out = text
  for (const r of refs) {
    const re = new RegExp(`${LEADING_WORD}\\b${r.category}s?/${escapeRegExp(r.name)}(?![A-Za-z0-9])${TRAILING_NOUN}`, 'gi')
    out = out.replace(re, (...args: any[]) => {
      const groups = args[args.length - 1] as { pre?: string }
      return `${your(groups.pre, args[args.length - 2], args[args.length - 3])} ${r.label} ${NOUN[r.category]}`
    })
  }
  // A key the knowledge base no longer has: take one word after the slash.
  out = out.replace(
    new RegExp(`${LEADING_WORD}\\b(?<cat>${CATEGORIES})s?/(?<key>[A-Za-z0-9+#](?:[A-Za-z0-9.+#_-]*[A-Za-z0-9+#])?)${TRAILING_NOUN}`, 'gi'),
    (...args: any[]) => {
      const groups = args[args.length - 1] as { pre?: string; cat: string; key: string }
      return `${your(groups.pre, args[args.length - 2], args[args.length - 3])} ${groups.key} ${NOUN[groups.cat.toLowerCase()]}`
    },
  )
  out = out
    .replace(/\s*\(kind: [^)]*\)/gi, '')
    .replace(/\bwaiting on Devin\b/g, 'waiting on you')
    .replace(/\bwhether Devin has\b/g, 'whether you have')
    .replace(/\bDevin answered\b/g, 'You answered')
  return fixPlurals(out)
}

/** The gap analysis with every displayed string in plain words. */
export function plainGap(gap: GapAnalysis): GapAnalysis {
  const refs = knowledgeReferences()
  const plain = (text: string) => plainGapText(text, refs)
  return {
    ...gap,
    summary: plain(gap.summary),
    items: gap.items.map(item => ({
      ...item,
      requirement: plain(item.requirement),
      rationale: plain(item.rationale),
      demoIdea: item.demoIdea ? { ...item.demoIdea, summary: plain(item.demoIdea.summary) } : item.demoIdea,
    })),
  }
}
