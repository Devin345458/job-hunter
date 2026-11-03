import { decodeEntities } from './filters'

// A small RSS 2.0 reader for job feeds: every <item> as a map of its child elements' text.
// CDATA sections are unwrapped and entities decoded, so an HTML description comes back as HTML.

export type RssItem = Record<string, string>

function text(raw: string): string {
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)
  return cdata ? cdata[1]! : decodeEntities(raw)
}

export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = []
  for (const block of xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []) {
    const item: RssItem = {}
    for (const m of block.matchAll(/<([a-zA-Z][\w:.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      const key = m[1]!.toLowerCase()
      if (!(key in item)) item[key] = text(m[2]!).trim()
    }
    items.push(item)
  }
  return items
}
