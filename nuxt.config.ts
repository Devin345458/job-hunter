import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const mdiCssCandidates = [
  resolve(process.cwd(), 'node_modules/@mdi/font/css/materialdesignicons.css'),
  resolve(process.cwd(), '../node_modules/@mdi/font/css/materialdesignicons.css'),
  resolve(process.cwd(), '../../node_modules/@mdi/font/css/materialdesignicons.css'),
]

const mdiCssPath = mdiCssCandidates.find(path => existsSync(path))
const mdiCssPathForVite = mdiCssPath?.replaceAll('\\', '/')
const mdiPackagePath = mdiCssPath ? dirname(dirname(mdiCssPath)) : undefined

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  ssr: true,
  // The review queue is the home page; /review is the name people type for it.
  routeRules: {
    '/review': { redirect: { to: '/', statusCode: 301 } },
  },
  devtools: { enabled: true },
  features: {
    inlineStyles: true,
  },

  modules: [
    'vuetify-nuxt-module',
  ],

  vuetify: {
    moduleOptions: {
      styles: {
        configFile: 'assets/scss/components.scss',
      },
      disableVuetifyStyles: true,
    },
    vuetifyOptions: {
      // Dispatch desk before dawn: slate surfaces a few points apart, one cobalt "ink" accent
      // for signing off, semantic colors only for status. Rationale in .claude/context/design-system.md.
      theme: {
        defaultTheme: 'dark',
        themes: {
          dark: {
            dark: true,
            colors: {
              'background': '#0f1318',
              'surface': '#151a21',
              'surface-bright': '#1c222b',
              'surface-light': '#222a34',
              'surface-variant': '#d9e0e8',
              'on-surface-variant': '#10151b',
              'on-background': '#e6ebf1',
              'on-surface': '#e6ebf1',
              'sunken': '#0b0e12',
              'primary': '#6b93ff',
              'on-primary': '#08101f',
              'secondary': '#9aa7b8',
              'on-secondary': '#0f1318',
              'accent': '#8fb0ff',
              'on-accent': '#08101f',
              'info': '#79b4f2',
              'on-info': '#06121f',
              'success': '#3fcf8e',
              'on-success': '#04140c',
              'warning': '#e9b04a',
              'on-warning': '#1d1404',
              'error': '#f2706f',
              'on-error': '#1f0707',
            },
            variables: {
              'border-color': '#d0dae6',
              'border-opacity': 0.11,
              'high-emphasis-opacity': 0.94,
              'medium-emphasis-opacity': 0.66,
              'disabled-opacity': 0.4,
              'hover-opacity': 0.05,
              'focus-opacity': 0.1,
              'activated-opacity': 0.1,
            },
          },
          // Not switched to anywhere today. Kept so a future toggle has white surfaces, never cream.
          light: {
            dark: false,
            colors: {
              'background': '#ffffff',
              'surface': '#ffffff',
              'sunken': '#eef1f5',
              'primary': '#2f5fe8',
              'secondary': '#526073',
              'accent': '#2f5fe8',
              'success': '#14804f',
              'warning': '#a86a00',
              'error': '#c8342f',
            },
          },
        },
      },
      // Borders carry depth (no shadows). Corners: 6px controls, 8px chips and list items, 12px cards.
      defaults: {
        VCard: { elevation: 0, rounded: 'xl' },
        VSheet: { elevation: 0 },
        VBtn: { elevation: 0 },
        VTextField: { variant: 'outlined', density: 'comfortable' },
        VTextarea: { variant: 'outlined', density: 'comfortable' },
        VSelect: { variant: 'outlined', density: 'comfortable' },
        VCombobox: { variant: 'outlined', density: 'comfortable' },
        VAutocomplete: { variant: 'outlined', density: 'comfortable' },
        VAlert: { rounded: 'lg', variant: 'tonal' },
        VDialog: { VCard: { rounded: 'xl' } },
        VMenu: { VList: { rounded: 'lg' } },
        VSnackbar: { rounded: 'lg' },
        VTooltip: { location: 'top' },
        VExpansionPanels: { rounded: 'lg' },
        VProgressLinear: { rounded: true },
      },
    },
  },

  nitro: {
    experimental: {
      tasks: true,
    },
    // Cron times are in the container's TZ (America/Chicago, set in the Dockerfile).
    // One daily chain runs every step in order: learn, search, enrich, match, prepare, demos.
    scheduledTasks: {
      // Keep in step with shared/utils/schedule.ts (PIPELINE_CRON), which the screens read.
      '0 6-21/3 * * *': ['pipeline:daily'],
      '*/15 * * * *': ['system:heartbeat'],
    },
    externals: {
      // Playwright resolves its browser binaries and driver files at runtime; bundling breaks that.
      external: ['playwright', 'playwright-core', 'pdfmake', 'pdfkit'],
      // pdfmake resolves its font files at runtime; list them so the trace copies them.
      traceInclude: [
        'node_modules/pdfmake/fonts/Roboto/Roboto-Regular.ttf',
        'node_modules/pdfmake/fonts/Roboto/Roboto-Medium.ttf',
        'node_modules/pdfmake/fonts/Roboto/Roboto-Italic.ttf',
        'node_modules/pdfmake/fonts/Roboto/Roboto-MediumItalic.ttf',
      ],
    },
  },

  runtimeConfig: {
    anthropicApiKey: '',
    jsearchApiKey: '',
    adzunaAppId: '',
    adzunaApiKey: '',
    databasePath: './data/job-hunter.db',
    // Login (NUXT_AUTH_PASSWORD_HASH from scripts/hash-password.mjs, NUXT_SESSION_PASSWORD 32+ random chars)
    authPasswordHash: '',
    sessionPassword: '',
    // Throwaway employer form at /sandbox/apply/<token> (NUXT_SANDBOX_TOKEN, 16+ chars)
    sandboxToken: '',
    // Absolute origin used in links the app generates, e.g. https://job-hunter.devinsmini.com
    publicBaseUrl: '',
    // Claude models. The fallback is used whenever the key cannot call the primary.
    aiModel: 'claude-opus-5-5',
    aiFallbackModel: 'claude-haiku-4-5',
    // Hard stop for Claude spend per local day, in dollars
    dailyAiBudgetUsd: '10',
    // uid of the unprivileged user that runs demo build commands in the container
    demoUid: '10001',
    // Safety switch for real employer submits. 'false' lets the approve path submit only to the
    // sandbox form; flip to 'true' in production once the pipeline is verified.
    realSubmitEnabled: 'false',
    // 'false' turns off the cron schedule (Orca worktrees set it), so a laptop copy never runs the
    // pipeline on its own; manual runs still work. Production leaves it unset.
    schedulerEnabled: 'true',
    // Devin's claude-self-reflect memory server (MCP over streamable HTTP, reached over Tailscale in
    // production). Empty turns the feature off: no leads on question cards, no memory in the chat.
    memoryMcpUrl: '',
    // Host header sent to it when the URL's host is not local: the daemon rejects any Host other
    // than localhost or 127.0.0.1 (DNS rebinding protection).
    memoryMcpHostHeader: '127.0.0.1:7391',
    // Token with push access to the demo and resume repos (used only on approve)
    githubToken: '',
    // Read-only tokens for GitHub evidence (server/utils/repos): Contents, Metadata, and Pull
    // requests read. A fine-grained token covers one owner, so NUXT_GITHUB_READ_TOKENS takes a
    // comma separated list (Devin's account, then each organization). NUXT_GITHUB_READ_TOKEN is a
    // single one. With neither set, the indexer falls back to githubToken. Never sent to the browser.
    githubReadTokens: '',
    githubReadToken: '',
    // uid of the unprivileged user that runs git for the repo cache in the container (its own user,
    // so demo build commands, which run as demoUid, cannot read the token or the cloned code)
    repoUid: '10002',
    githubOwner: 'Devin345458',
    resumeRepo: 'Devin345458/resume',
    // Demo project builder (server/utils/demo). Model to try first; empty uses aiModel, and
    // aiFallbackModel still applies when the key cannot call it.
    // 'false' switches demo builds and demo publishing off (server/utils/demo/enabled.ts)
    demosEnabled: 'true',
    demoModel: '',
    // Hard limits per demos:build run and per demo build
    demoMaxPerRun: '1',
    // Haiku 4.5 (the only model the production token reaches) needs more turns than Opus; the cost
    // and time caps still bound a build.
    demoMaxTurns: '80',
    demoMaxMinutes: '25',
    demoMaxCostUsd: '3',
    // Extra PATH entries for demo build commands, colon separated (e.g. a local Go toolchain)
    demoToolPath: '',
    // index.html (or a directory holding one) that seeds the sandbox copy of the resume repo.
    // Empty uses a built-in page with the same case-study markup.
    demoSandboxResumeSeed: '',
  },

  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      // Pages set their own title; the layout falls back to the section name.
      title: 'Job Hunter',
      link: [
        {
          rel: 'preconnect',
          href: 'https://fonts.googleapis.com',
        },
        {
          rel: 'preconnect',
          href: 'https://fonts.gstatic.com',
          crossorigin: '',
        },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400..800&display=swap',
        },
      ],
    },
  },

  css: [
    '~/assets/scss/global.scss',
  ],
})
