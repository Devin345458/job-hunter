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
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    // Only the item's inner XML, so the outer <item> element is not read as one big child.
    const block = match[1] ?? ''
    const item: RssItem = {}
    for (const m of block.matchAll(/<([a-zA-Z][\w:.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      const key = m[1]!.toLowerCase()
      if (!(key in item)) item[key] = text(m[2]!).trim()
    }
    items.push(item)
  }
  return items
}
