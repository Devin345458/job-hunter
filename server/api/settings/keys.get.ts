// GET /api/settings/keys
// Which of the environment variables the Settings > API Keys card lists are set on the server.
// Booleans only: a value, or any part of one, never leaves the server.
const KEYS: Record<string, string> = {
  NUXT_ANTHROPIC_API_KEY: 'anthropicApiKey',
  NUXT_JSEARCH_API_KEY: 'jsearchApiKey',
  NUXT_ADZUNA_APP_ID: 'adzunaAppId',
  NUXT_ADZUNA_API_KEY: 'adzunaApiKey',
  NUXT_GITHUB_TOKEN: 'githubToken',
  NUXT_GITHUB_READ_TOKENS: 'githubReadTokens',
  NUXT_GITHUB_READ_TOKEN: 'githubReadToken',
}

export default defineEventHandler(() => {
  const config = useRuntimeConfig() as unknown as Record<string, unknown>
  const set: Record<string, boolean> = {}
  for (const [env, key] of Object.entries(KEYS)) set[env] = String(config[key] ?? '').trim().length > 0
  return { set }
})
