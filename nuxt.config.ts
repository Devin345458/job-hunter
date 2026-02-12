// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  modules: [
    'vuetify-nuxt-module',
  ],

  vuetify: {
    moduleOptions: {
      styles: {
        configFile: 'assets/scss/vuetify-settings.scss',
      },
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
    scheduledTasks: {
      // Daily job search at 6 AM
      '0 6 * * *': ['jobs:search'],
      // Score new jobs at 7 AM (after search completes)
      '0 7 * * *': ['jobs:match'],
    },
  },

  runtimeConfig: {
    anthropicApiKey: '',
    jsearchApiKey: '',
    adzunaAppId: '',
    adzunaApiKey: '',
    databasePath: './data/job-hunter.db',
  },

  css: [
    '@mdi/font/css/materialdesignicons.css',
  ],
})
