import type { PullContext, PullResult, RawListing, SearchParams } from './types'
import { sanitizeHtml } from './filters'
import { fetchFeed } from './http'
import { aggregator, scoped, toIso, windowStart } from './paging'
import { parseRss } from './rss'

// We Work Remotely RSS feeds for its programming and DevOps categories (all remote jobs). Terms
// (weworkremotely.com/remote-job-rss-feed): "Anyone can use the feed, all we ask is that you
// attribute the links back to We Work Remotely", so each job links to its WWR page. Feeds have no
// paging and a 60-minute ttl, so this pulls at most once an hour. Titles read "Company: Role";
// region says who can apply ("USA Only", "North America Only", "Anywhere in the World").

const FEEDS = [
  'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss',
]

export const weworkremotelyAdapter = aggregator({
  name: 'weworkremotely',
  minIntervalMinutes: 60,
  overlapHours: 2,
  async pull(_params: SearchParams, ctx: PullContext): Promise<PullResult> {
    return scoped('', async () => {
      const start = windowStart(ctx, '').getTime()
      const byId = new Map<string, RawListing>()
      let requests = 0
      for (const feed of FEEDS) {
        const xml = await fetchFeed(feed, { cache: true, minIntervalMs: 1000 })
        requests++
        for (const item of parseRss(xml)) {
          const link = item.link || item.guid
          if (!link || !item.title) continue
          const id = link.replace(/\/+$/, '').split('/').pop()!
          const postedAt = toIso(item.pubdate ? Date.parse(item.pubdate) : null)
          if (postedAt && Date.parse(postedAt) < start) continue
          const colon = item.title.indexOf(': ')
          const company = colon > 0 ? item.title.slice(0, colon).trim() : 'Unknown'
          const title = colon > 0 ? item.title.slice(colon + 2).trim() : item.title.trim()
          const region = [item.region, item.country, item.state].filter(Boolean).join(', ')
          byId.set(id, {
            job: {
              source: 'weworkremotely',
              sourceId: id,
              title,
              company,
              location: region || 'Remote',
              remoteType: 'remote',
              description: sanitizeHtml(item.description ?? ''),
              url: link,
              tags: [item.category, ...(item.skills ?? '').split(/,\s*|\s+and\s+/)].filter((t): t is string => !!t && t.length < 40),
              expiresAt: item.expires_at ? toIso(Date.parse(item.expires_at)) ?? undefined : undefined,
            },
            postedAt,
            locations: region ? [region] : [],
            remote: true,
            fullTime: !/part|contract|freelance|intern/i.test(item.type ?? ''),
          })
        }
      }
      const listings = [...byId.values()]
      return { listings, result: { scope: '', ok: true, found: listings.length, requests, complete: true } }
    })
  },
})
