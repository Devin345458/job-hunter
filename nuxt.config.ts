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
      theme: {
        defaultTheme: 'dark',
        themes: {
          dark: {
            colors: {
              primary: '#6366f1',
              secondary: '#8b5cf6',
              accent: '#22d3ee',
              success: '#22c55e',
              warning: '#f59e0b',
              error: '#ef4444',
              surface: '#1e1e2e',
              background: '#11111b',
            },
          },
          light: {
            colors: {
              primary: '#4f46e5',
              secondary: '#7c3aed',
              accent: '#0891b2',
              success: '#16a34a',
              warning: '#d97706',
              error: '#dc2626',
            },
          },
        },
      },
      defaults: {
        VCard: { elevation: 0, rounded: 'lg' },
        VBtn: { rounded: 'lg' },
        VTextField: { variant: 'outlined', density: 'comfortable' },
        VTextarea: { variant: 'outlined', density: 'comfortable' },
        VSelect: { variant: 'outlined', density: 'comfortable' },
        VChip: { rounded: 'lg' },
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
      '0 6 * * *': ['pipeline:daily'],
    },
    externals: {
      // Playwright resolves its browser binaries and driver files at runtime; bundling breaks that.
      external: ['playwright', 'playwright-core'],
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
    // Token with push access to the demo and resume repos (used only on approve)
    githubToken: '',
    githubOwner: 'Devin345458',
    resumeRepo: 'Devin345458/resume',
  },

  app: {
    head: {
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
          href: 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,200..800;1,200..800&display=swap',
        },
      ],
    },
  },

  css: [
    '~/assets/scss/global.scss',
  ],
})
