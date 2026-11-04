<script setup lang="ts">
import type { MemoryStatus } from '#shared/types/memory'
import { outcomeOf } from '~/composables/review/format'

// /settings: the list of Settings sub pages, each with what is on it and, where it costs nothing
// extra, its status. A phone reaches it from the bottom bar's Settings; every sub page's back arrow
// returns here. On desktop the sidebar group already is this list, so the page moves on to the
// first sub page instead. Old links to the single Settings page (/settings#pipeline,
// #github-evidence, #job-sources, #memory) open their sub page. The hash never reaches the server,
// so both checks run in the browser.
definePageMeta({ layout: 'default' })

const route = useRoute()
const isDesktop = useState<boolean>('shell-is-desktop')
const health = usePipelineHealth()
const leaving = ref(false)

// The page mounts before the layout corrects its first guess from the user agent, so ask the
// browser itself here (the same 960px line the layout uses).
const desktopNow = () => (import.meta.client ? window.matchMedia('(min-width: 960px)').matches : isDesktop.value)

function moveOn() {
  const legacy = settingsPathForHash(route.hash)
  const target = legacy ?? (desktopNow() ? settingsPath(SETTINGS_PAGES[0]!.slug) : null)
  if (!target) return
  leaving.value = true
  return navigateTo(target, { replace: true })
}

onMounted(() => {
  void moveOn()
})
watch(isDesktop, (desktop) => {
  if (desktop) void moveOn()
})

// ── Statuses: only what is already loaded (the shell's pipeline health) or a stored row ──
type Tone = 'warning' | 'error' | 'info' | 'success' | 'neutral'
interface Status { text: string; tone: Tone }

const usd = (n: number) => `$${n.toFixed(2)}`

const pipelineStatus = computed<Status | null>(() => {
  const r = health.runs.value
  if (!r) return null
  const q = r.queue
  if (q?.runs.length) return { text: 'Full run under way', tone: 'info' }
  if (q?.running.length) return { text: 'Running', tone: 'info' }
  if (q?.waiting.length) return { text: `${q.waiting.length} waiting`, tone: 'neutral' }
  const last = r.lastDaily
  if (!last) return null
  const o = outcomeOf(last)
  if (o === 'failed') return { text: 'Last full run failed', tone: 'error' }
  if (o === 'partial') return { text: 'Last full run partly failed', tone: 'warning' }
  return null
})

const usageStatus = computed<Status | null>(() => {
  const r = health.runs.value
  if (!r) return null
  const sub = r.subscription
  if (sub?.pause || sub?.stop) return { text: 'Paused', tone: 'warning' }
  if (sub?.limits && sub.spent && (sub.on || sub.spent.week.calls > 0)) return { text: `est. ${usd(sub.spent.today.estUsd)} of ${usd(sub.limits.dailyUsd)} today`, tone: 'neutral' }
  return { text: `${usd(r.aiSpentToday)} of ${usd(r.aiBudget)} today`, tone: 'neutral' }
})

const activeSearches = ref<number | null>(null)
const memory = ref<MemoryStatus | null>(null)
const keysSet = ref<Record<string, boolean> | null>(null)

/** The variables the API keys page lists (the older single read token is left out). */
const LISTED_KEYS = ['NUXT_CLAUDE_CODE_OAUTH_TOKEN', 'NUXT_ANTHROPIC_API_KEY', 'NUXT_JSEARCH_API_KEY', 'NUXT_ADZUNA_APP_ID', 'NUXT_ADZUNA_API_KEY', 'NUXT_GITHUB_TOKEN', 'NUXT_GITHUB_READ_TOKENS']

const MEMORY: Record<MemoryStatus['state'], Status> = {
  off: { text: 'Off', tone: 'neutral' },
  reachable: { text: 'Reachable', tone: 'success' },
  busy: { text: 'Busy or asleep', tone: 'neutral' },
  unreachable: { text: 'Not reachable', tone: 'warning' },
  unknown: { text: 'Not checked yet', tone: 'neutral' },
}

const statuses = computed<Record<string, Status | null>>(() => ({
  'pipeline': pipelineStatus.value,
  'claude-usage': usageStatus.value,
  'job-search': activeSearches.value == null
    ? null
    : activeSearches.value
      ? { text: `${activeSearches.value} active ${activeSearches.value === 1 ? 'search' : 'searches'}`, tone: 'neutral' }
      : { text: 'No active search', tone: 'warning' },
  // No status: the repo list behind it reads GitHub when it is older than a day, too much for a list.
  'github-evidence': null,
  'memory': memory.value ? MEMORY[memory.value.state] : null,
  'api-keys': keysSet.value
    ? (!keysSet.value.NUXT_CLAUDE_CODE_OAUTH_TOKEN && !keysSet.value.NUXT_ANTHROPIC_API_KEY)
        ? { text: 'No Claude token or key', tone: 'warning' }
        : { text: `${LISTED_KEYS.filter(k => keysSet.value![k]).length} of ${LISTED_KEYS.length} set`, tone: 'neutral' }
    : null,
}))

onMounted(async () => {
  if (leaving.value) return
  // Each one is a stored row; a failure only leaves its status out.
  await Promise.allSettled([
    $fetch<Array<{ isActive: boolean | null }>>('/api/search-configs').then((rows) => { activeSearches.value = rows.filter(r => r.isActive).length }),
    $fetch<MemoryStatus>('/api/memory/status').then((m) => { memory.value = m }),
    $fetch<{ set: Record<string, boolean> }>('/api/settings/keys').then((k) => { keysSet.value = k.set }),
  ])
})
</script>

<template>
  <div class="fade-in">
    <!-- Desktop moves on to the first sub page; rendering the list there would only flash. -->
    <template v-if="!isDesktop && !leaving">
      <div class="page-header settings-hub__header">
        <h1 class="text-h4 page-header__title">Settings</h1>
      </div>

      <nav aria-label="Settings pages">
        <ul class="settings-hub">
          <li v-for="p in SETTINGS_PAGES" :key="p.slug">
            <NuxtLink :to="settingsPath(p.slug)" class="settings-hub__row">
              <v-icon :icon="p.icon" size="20" class="settings-hub__icon" />
              <span class="settings-hub__text">
                <span class="settings-hub__title-line">
                  <span class="settings-hub__title">{{ p.title }}</span>
                  <span
                    v-if="statuses[p.slug]"
                    class="settings-hub__status"
                    :class="`settings-hub__status--${statuses[p.slug]!.tone}`"
                  >{{ statuses[p.slug]!.text }}</span>
                </span>
                <span class="settings-hub__blurb">{{ p.blurb }}</span>
              </span>
              <v-icon icon="mdi-chevron-right" size="20" class="settings-hub__chev" />
            </NuxtLink>
          </li>
        </ul>
      </nav>
    </template>
    <v-progress-linear v-else indeterminate color="primary" class="settings-hub__moving" aria-label="Opening Settings" />
  </div>
</template>

<style scoped lang="scss">
.settings-hub {
  list-style: none;
  margin: 0;
  padding: 0;
  border-radius: 16px;
  background: rgb(var(--v-theme-surface));
  overflow: hidden;

  li + li {
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__header {
    margin-bottom: 20px;
  }

  &__row {
    display: flex;
    align-items: center;
    gap: 14px;
    min-height: 72px;
    padding: 12px 12px 12px 16px;
    color: inherit;
    text-decoration: none;
    transition: background-color 150ms cubic-bezier(0.23, 1, 0.32, 1);

    &:hover {
      background: rgba(var(--v-theme-on-surface), var(--v-hover-opacity));
    }

    &:active {
      background: rgba(var(--v-theme-on-surface), var(--v-activated-opacity));
    }

    &:focus-visible {
      outline-offset: -2px;
    }
  }

  &__icon {
    flex: none;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  &__title-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
  }

  &__title {
    font-size: 0.9375rem;
    font-weight: 600;
  }

  &__blurb {
    font-size: 0.8125rem;
    line-height: 1.45;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    text-wrap: pretty;
  }

  // Status tag from the design system: 12px/600, 2px 8px, 6px corners, color at 12% fill.
  &__status {
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1.4;
    padding: 1px 8px;
    border-radius: 6px;

    &--neutral {
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
      background: rgba(var(--v-theme-on-surface), 0.08);
    }

    &--warning {
      color: rgb(var(--v-theme-warning));
      background: rgba(var(--v-theme-warning), 0.12);
    }

    &--error {
      color: rgb(var(--v-theme-error));
      background: rgba(var(--v-theme-error), 0.12);
    }

    &--info {
      color: rgb(var(--v-theme-info));
      background: rgba(var(--v-theme-info), 0.12);
    }

    &--success {
      color: rgb(var(--v-theme-success));
      background: rgba(var(--v-theme-success), 0.12);
    }
  }

  &__chev {
    flex: none;
    color: rgba(var(--v-theme-on-surface), var(--v-disabled-opacity));
  }

  &__moving {
    max-width: 240px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .settings-hub__row {
    transition: none;
  }
}
</style>
