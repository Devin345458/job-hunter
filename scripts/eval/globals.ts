// Runs the app's server code outside Nitro. Nitro auto-imports every export of server/utils and
// shared/ as a global, and the app calls useRuntimeConfig() for its settings. This file reads the
// generated declaration file (.nuxt/types/nitro-imports.d.ts, written by `nuxt prepare`), imports
// each app module it names, and assigns the exports to globalThis. Nitro runtime helpers are
// replaced by small stand-ins: useRuntimeConfig returns the object passed in, and runTask refuses.

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface EvalConfig extends Record<string, unknown> {
  databasePath: string
  anthropicApiKey: string
  aiModel: string
  aiFallbackModel: string
  dailyAiBudgetUsd: string
  schedulerEnabled: string
  demoToolPath: string
}

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../..')

export async function setupGlobals(config: EvalConfig): Promise<void> {
  const g = globalThis as any
  g.useRuntimeConfig = () => config
  g.runTask = async () => {
    throw new Error('runTask is not available in the eval harness')
  }

  const decl = readFileSync(resolve(ROOT, '.nuxt/types/nitro-imports.d.ts'), 'utf8')
  const wanted = new Map<string, Array<{ name: string; exported: string }>>()
  const line = /^\s+const (\w+): typeof import\('([^']+)'\)(?:\.(\w+)|\['(\w+)'\])/gm
  for (const m of decl.matchAll(line)) {
    const [, name, from, dotted, bracketed] = m
    const abs = from!.startsWith('/') ? from! : resolve(ROOT, '.nuxt/types', from!)
    // Only the app's own modules; Nitro and h3 internals are not needed by the steps under test.
    if (!abs.startsWith(resolve(ROOT, 'server')) && !abs.startsWith(resolve(ROOT, 'shared'))) continue
    const list = wanted.get(abs) ?? []
    list.push({ name: name!, exported: (dotted ?? bracketed)! })
    wanted.set(abs, list)
  }

  for (const [abs, names] of wanted) {
    const mod = await import(pathToFileURL(`${abs}.ts`).href)
    for (const { name, exported } of names) {
      if (exported in mod) g[name] = mod[exported]
    }
  }
}
