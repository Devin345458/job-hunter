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
    // No scheduledTasks: server/plugins/queue.ts adds pipeline:daily (PIPELINE_CRON in
    // shared/utils/schedule.ts) and the 15 minute heartbeat to the job queue, in the roles that
    // keep the schedule. Tasks stay enabled because the queue worker runs them with runTask.
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
    // Per-step models (NUXT_AI_STEP_MODELS): comma separated purpose=model pairs, for example
    // 'enrich=claude-sonnet-5-5,match=claude-haiku-5-5'. A purpose not listed uses aiModel; the
    // fallback model still applies. Chosen from the 2026-11-03 evaluation in scripts/eval.
    aiStepModels: '',
    // Devin's personal Claude subscription (NUXT_CLAUDE_CODE_OAUTH_TOKEN, from `claude setup-token`).
    // When set, every step runs through the Claude Agent SDK on it (server/utils/agent-backend.ts);
    // the token reaches only the Claude Code child process, as CLAUDE_CODE_OAUTH_TOKEN in its
    // environment. Never logged, never in argv, never returned by an API.
    claudeCodeOauthToken: '',
    // Per-step backend overrides (NUXT_AI_STEP_BACKENDS): comma separated purpose=api pairs. A step
    // mapped to api uses NUXT_ANTHROPIC_API_KEY, and only while that key is set; everything else
    // runs on the subscription while the token is set, and on the key while it is not.
    aiStepBackends: '',
    // Claude Code processes this server runs at once (NUXT_AGENT_CONCURRENCY, 1 to 8). Each is a
    // separate process of about 190 MB that idles near 0% CPU while Claude answers
    // (scripts/agent-sdk/measure.ts); 3 keeps the peak near 600 MB on the shared Mac Mini.
    agentConcurrency: '3',
    // Thinking on the subscription (NUXT_AGENT_THINKING): off (default), "on" for every step, or a
    // comma separated list of purposes ("tailor,cover_letter"). The 5.x models think adaptively
    // either way, exactly as on the API key; it changes only claude-haiku-4-5 (agentThinking()).
    agentThinking: 'off',
    // Path to the Claude Code binary the Agent SDK starts. Empty finds the platform package in
    // node_modules; the Docker image sets /opt/claude-code/claude.
    claudeCodePath: '',
    // uid of the unprivileged user Claude Code runs as in the container (its own user, so neither
    // demo builds nor git can read the subscription token from its environment)
    agentUid: '10003',
    // Hard stop for Claude spend billed to the API key per local day, in dollars (calls on the
    // subscription never count)
    dailyAiBudgetUsd: '10',
    // Background work (scheduled steps, per-job read and score items) stops at this share of the
    // daily budget, leaving the rest for what Devin starts by hand.
    backgroundBudgetShare: '0.7',
    // uid of the unprivileged user that runs demo build commands in the container
    demoUid: '10001',
    // Safety switch for real employer submits. 'false' lets the approve path submit only to the
    // sandbox form; flip to 'true' in production once the pipeline is verified.
    realSubmitEnabled: 'false',
    // 'false' turns off the cron schedule (Orca worktrees set it), so a laptop copy never runs the
    // pipeline on its own; manual runs still work. Production leaves it unset.
    schedulerEnabled: 'true',
    // Which parts this process runs (NUXT_ROLE, server/utils/role.ts): all (default: web, schedule,
    // and worker), web (serves the app and adds work to the queue), worker (schedule and worker;
    // answers only /api/health). One image; a web and a worker container share the data volume.
    role: 'all',
    // Queue items the worker runs at once (NUXT_WORKER_CONCURRENCY, 1 to 4). Demo builds and form
    // fills never run two at a time whatever this says.
    workerConcurrency: '1',
    // Per-job items (read one posting, score one job) the worker runs at once, in their own lane
    // (NUXT_BULK_CONCURRENCY, 1 to 8).
    bulkConcurrency: '4',
    // Test overrides for the schedule (NUXT_PIPELINE_CRON, NUXT_HEARTBEAT_CRON). Empty uses
    // PIPELINE_CRON and every 15 minutes. Production leaves them unset.
    pipelineCron: '',
    heartbeatCron: '',
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
