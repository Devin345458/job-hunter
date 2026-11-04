<script setup lang="ts">
// Settings > API keys: the environment variables the app reads, what each is for, and whether the
// server has it (GET /api/settings/keys answers booleans only, never a value).
definePageMeta({ layout: 'default' })

/** The environment variables this page lists, with what each one is for. */
const API_KEYS = [
  { names: ['NUXT_CLAUDE_CODE_OAUTH_TOKEN'], text: 'Your personal Claude subscription token (from claude setup-token). Every AI step runs on it through the Claude Agent SDK. Required for the core features.' },
  { names: ['NUXT_ANTHROPIC_API_KEY'], text: 'Anthropic Console API key, billed per use. Optional: used only without the subscription token, or for a step NUXT_AI_STEP_BACKENDS sends to the API.' },
  { names: ['NUXT_JSEARCH_API_KEY'], text: 'RapidAPI key for the JSearch source. Optional: other sources work without keys.' },
  { names: ['NUXT_ADZUNA_APP_ID', 'NUXT_ADZUNA_API_KEY'], text: 'Adzuna credentials. Optional: free keys at adzuna.com.' },
  { names: ['NUXT_GITHUB_TOKEN'], text: 'Publishes demo repos and the resume site when you approve an application. Optional: without it nothing is published.' },
  { names: ['NUXT_GITHUB_READ_TOKENS'], text: 'Read-only GitHub tokens for GitHub evidence (Contents, Metadata, Pull requests read), comma separated, one per owner. Optional: without them GitHub evidence reads with NUXT_GITHUB_TOKEN. NUXT_GITHUB_READ_TOKEN (one token) is the older single-token form.' },
]

/** Which of those variables the server has. Null until loaded, or when the check failed. */
const keysSet = ref<Record<string, boolean> | null>(null)
const keysError = ref(false)

onMounted(async () => {
  try {
    keysSet.value = (await $fetch<{ set: Record<string, boolean> }>('/api/settings/keys')).set
  }
  catch {
    keysSet.value = null
    keysError.value = true
  }
})
</script>

<template>
  <div class="fade-in">
    <SettingsPageHeader slug="api-keys" />
    <v-card variant="outlined">
      <v-card-text class="api-keys">
        <div class="text-body-2 font-weight-medium mb-3">
          Environment variables, and whether each is set on this server:
        </div>
        <p v-if="keysError" class="api-keys__error" role="alert">Could not read which variables are set.</p>
        <!-- A stacked list, not a table: at 390 a table left the description column one word wide. -->
        <dl class="api-keys__list">
          <div v-for="k in API_KEYS" :key="k.names.join()" class="api-keys__row">
            <dt class="api-keys__names">
              <span v-for="n in k.names" :key="n" class="api-keys__name">
                <code>{{ n }}</code>
                <span
                  v-if="keysSet"
                  class="api-keys__status"
                  :class="keysSet[n] ? 'api-keys__status--set' : 'api-keys__status--unset'"
                >{{ keysSet[n] ? 'Set' : 'Not set' }}</span>
              </span>
            </dt>
            <dd class="api-keys__text">{{ k.text }}</dd>
          </div>
        </dl>
        <div class="api-keys__foot">
          Set these in your <code>.env</code> file or Coolify environment settings. Free sources (Remotive, RemoteOK, Himalayas, Jobicy, Arbeitnow, Hacker News, We Work Remotely, Working Nomads, Workable Jobs, and the employer boards) work without any API keys.
        </div>
      </v-card-text>
    </v-card>
  </div>
</template>

<style scoped lang="scss">
.api-keys {
  padding: 20px 24px;

  @media (max-width: 599.98px) {
    padding: 16px;
  }

  &__error {
    margin: 0 0 8px;
    font-size: 0.8125rem;
    color: rgb(var(--v-theme-error));
  }

  &__list {
    margin: 0;
  }

  &__row {
    padding: 12px 0;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

    &:first-child {
      border-top: 0;
      padding-top: 0;
    }
  }

  &__names {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    font-size: 0.8125rem;
    font-weight: 700;

    code {
      overflow-wrap: anywhere;
    }
  }

  &__name {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 8px;
    min-width: 0;
  }

  &__status {
    font-weight: 600;
    font-size: 0.75rem;
    padding: 1px 8px;
    border-radius: 6px;

    &--set {
      color: rgb(var(--v-theme-success));
      background: rgba(var(--v-theme-success), 0.12);
    }

    &--unset {
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
      background: rgba(var(--v-theme-on-surface), 0.08);
    }
  }

  &__text {
    margin: 4px 0 0;
    max-width: 80ch;
    font-size: 0.8125rem;
    line-height: 1.5;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__foot {
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    font-size: 0.75rem;
    line-height: 1.5;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }
}
</style>
