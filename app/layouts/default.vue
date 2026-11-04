<script setup lang="ts">
import { PIPELINE_SCHEDULE_TEXT, nextPipelineRunText } from '#shared/utils/schedule'

// Recomputed each minute so the sidebar's next run stays right on a page left open.
const nextRun = ref(nextPipelineRunText())
let nextRunTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => { nextRunTimer = setInterval(() => { nextRun.value = nextPipelineRunText() }, 60_000) })
onBeforeUnmount(() => { if (nextRunTimer) clearInterval(nextRunTimer) })
interface NavItem {
  title: string
  /** Label under the bottom navigation icon; must fit 78px at a 390px viewport. */
  short: string
  icon: string
  to: string
  /** Extra path prefixes that count as this item, e.g. /review/12 for the queue. */
  also?: string[]
  inBottomNav?: boolean
}

const navItems: NavItem[] = [
  { title: 'Review', short: 'Review', icon: 'mdi-inbox-arrow-down-outline', to: '/', also: ['/review'], inBottomNav: true },
  { title: 'Jobs', short: 'Jobs', icon: 'mdi-briefcase-search-outline', to: '/jobs', inBottomNav: true },
  // One name everywhere: the bottom bar used to say "Applied" for the page called Applications.
  { title: 'Applications', short: 'Applications', icon: 'mdi-file-document-check-outline', to: '/applications', inBottomNav: true },
  { title: 'Demo projects', short: 'Demos', icon: 'mdi-flask-outline', to: '/demos' },
  { title: 'Questions', short: 'Questions', icon: 'mdi-comment-question-outline', to: '/questions', inBottomNav: true },
  { title: 'Learning', short: 'Learning', icon: 'mdi-chart-timeline-variant', to: '/learning' },
  { title: 'Knowledge base', short: 'Knowledge', icon: 'mdi-book-account-outline', to: '/knowledge' },
  { title: 'Settings', short: 'Settings', icon: 'mdi-tune-variant', to: '/settings', inBottomNav: true },
]

const route = useRoute()
const health = usePipelineHealth()

function isActiveRoute(item: NavItem) {
  if (item.to === '/') return route.path === '/' || (item.also ?? []).some(p => route.path.startsWith(p))
  return route.path.startsWith(item.to)
}

// Settings is a group of sub pages (app/utils/settingsPages.ts): the drawer lists them under it,
// and the app bar and tab title name the sub page ("Claude usage · Settings · Job Hunter").
const settingsPage = computed(() => settingsPageFor(route.path))
const inSettings = computed(() => route.path === '/settings' || route.path.startsWith('/settings/'))

const activePageTitle = computed(() => settingsPage.value?.title || navItems.find(isActiveRoute)?.title || 'Job Hunter')

// Every page gets a tab title: the section name here, which a page's own useHead replaces
// (a page's head entry is registered after the layout's, so it wins).
useHead({
  title: () => {
    if (settingsPage.value) return `${settingsPage.value.title} · Settings · Job Hunter`
    return activePageTitle.value === 'Job Hunter' ? 'Job Hunter' : `${activePageTitle.value} · Job Hunter`
  },
})

// The group opens when a Settings route is entered and closes when one is left; a click on its
// header opens or closes it in between. A ref, so that click is not overridden until the route
// crosses into or out of Settings.
const openedGroups = ref<string[]>(inSettings.value ? ['settings'] : [])
watch(inSettings, (now) => {
  openedGroups.value = now ? ['settings'] : openedGroups.value.filter(g => g !== 'settings')
})

/** Claude calls are stopped (Anthropic's pause or this app's limit): Claude usage says so in the nav. */
const claudePaused = computed(() => {
  const sub = health.runs.value?.subscription
  return !!(sub?.pause || sub?.stop)
})

// First paint guess from the request, so a phone does not render the desktop drawer and then
// jump. The media query below corrects it once the page is interactive.
const ua = import.meta.server ? useRequestHeaders(['user-agent', 'sec-ch-ua-mobile']) : {}
const isDesktop = useState('shell-is-desktop', () => {
  if (ua['sec-ch-ua-mobile'] === '?1') return false
  return !/Mobi|iPhone|iPod|Android/i.test(ua['user-agent'] || '')
})
const drawer = ref(isDesktop.value)
const hydrated = ref(false)

watch(isDesktop, (desktop) => {
  drawer.value = desktop
})

let media: MediaQueryList | null = null
function updateViewportMode() {
  if (media) isDesktop.value = media.matches
}

onMounted(() => {
  media = window.matchMedia('(min-width: 960px)')
  updateViewportMode()
  media.addEventListener('change', updateViewportMode)
  hydrated.value = true
  health.refresh()
})

onBeforeUnmount(() => {
  media?.removeEventListener('change', updateViewportMode)
})

const loggingOut = ref(false)
const logoutError = ref<string | null>(null)
async function logout() {
  loggingOut.value = true
  logoutError.value = null
  try {
    await $fetch('/api/auth/logout', { method: 'POST' })
    await navigateTo('/login', { external: true })
  }
  catch (e: any) {
    logoutError.value = e?.data?.statusMessage || e?.message || 'Sign out failed'
    loggingOut.value = false
  }
}

// A count appears only on a queue that needs action. Questions counts the ones that block an
// approval (amber); the rest wait without holding anything up.
function badgeFor(item: NavItem): number {
  if (item.to === '/') return (health.stats.value?.review.toDecide ?? 0) + (health.stats.value?.review.toSend ?? 0)
  if (item.to === '/questions') return health.stats.value?.questions.blocking ?? 0
  return 0
}

function badgeLabel(item: NavItem): string {
  const n = badgeFor(item).toLocaleString('en-US')
  return item.to === '/questions' ? `${n} blocking an approval` : `${n} waiting`
}
</script>

<template>
  <v-app :class="['shell', { 'shell--prehydrate': !hydrated }]">
    <!-- model-value keeps the bar out of Vuetify's layout on desktop. A class alone hides it
         but still reserves its 56px. -->
    <v-app-bar
      class="shell__bar d-md-none"
      :model-value="!isDesktop"
      color="background"
      flat
      height="56"
    >
      <!-- A Settings sub page goes back to the Settings list; every other page opens the drawer. -->
      <v-btn
        v-if="settingsPage"
        icon="mdi-arrow-left"
        variant="text"
        to="/settings"
        aria-label="Back to Settings"
        class="shell__back"
      />
      <v-app-bar-nav-icon v-else aria-label="Open navigation" @click="drawer = !drawer" />
      <v-app-bar-title class="shell__bar-title">
        {{ activePageTitle }}
      </v-app-bar-title>
    </v-app-bar>

    <v-navigation-drawer
      v-model="drawer"
      :permanent="isDesktop"
      :temporary="!isDesktop"
      color="background"
      width="232"
      class="shell__drawer"
      @update:model-value="(val: boolean) => { if (!isDesktop) drawer = val }"
    >
      <div class="shell__brand">
        <!-- The mark is the match score's ring, nearly full, in the score's hue. -->
        <svg class="shell__mark" viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="12" class="shell__mark-track" />
          <circle cx="16" cy="16" r="12" class="shell__mark-arc" pathLength="100" stroke-dasharray="92 100" transform="rotate(-90 16 16)" />
        </svg>
        <div>
          <div class="shell__name">Job Hunter</div>
          <div class="shell__owner">Devin's pipeline</div>
        </div>
      </div>

      <v-list v-model:opened="openedGroups" nav density="compact" class="shell__nav" aria-label="Main">
        <template v-for="item in navItems" :key="item.to">
          <!-- Settings: an expandable group of its sub pages. The header only opens and closes it. -->
          <v-list-group v-if="item.to === '/settings'" value="settings" class="shell__group">
            <template #activator="{ props: groupProps, isOpen }">
              <v-list-item
                v-bind="groupProps"
                :active="false"
                role="button"
                tabindex="0"
                :aria-expanded="isOpen"
                rounded="lg"
                min-height="44"
                class="shell__nav-item"
                :class="{ 'shell__nav-item--within': inSettings && !isOpen }"
              >
                <template #prepend>
                  <v-icon :icon="item.icon" size="20" />
                </template>
                <v-list-item-title>{{ item.title }}</v-list-item-title>
                <template #append>
                  <span v-if="!isOpen && claudePaused" class="shell__attn" role="img" aria-label="Claude usage is paused" />
                  <v-icon :icon="isOpen ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="18" class="shell__chev" />
                </template>
              </v-list-item>
            </template>
            <v-list-item
              v-for="p in SETTINGS_PAGES"
              :key="p.slug"
              :to="settingsPath(p.slug)"
              :active="settingsPage?.slug === p.slug"
              rounded="lg"
              color="primary"
              :min-height="isDesktop ? 32 : 44"
              class="shell__sub-item"
            >
              <v-list-item-title>{{ p.title }}</v-list-item-title>
              <template v-if="p.slug === 'claude-usage' && claudePaused" #append>
                <span class="shell__tag shell__tag--warning">Paused</span>
              </template>
            </v-list-item>
          </v-list-group>
          <v-list-item
            v-else
            :to="item.to"
            :active="isActiveRoute(item)"
            rounded="lg"
            color="primary"
            min-height="44"
            class="shell__nav-item"
          >
            <template #prepend>
              <v-icon :icon="item.icon" size="20" />
            </template>
            <v-list-item-title>{{ item.title }}</v-list-item-title>
            <template v-if="badgeFor(item) > 0" #append>
              <span
                class="shell__count tabular"
                :class="{ 'shell__count--blocking': item.to === '/questions' }"
                :aria-label="badgeLabel(item)"
              >{{ badgeFor(item).toLocaleString('en-US') }}</span>
            </template>
          </v-list-item>
        </template>
      </v-list>

      <template #append>
        <div class="shell__foot">
          <div class="shell__schedule">
            <v-icon icon="mdi-clock-outline" size="14" />
            <span>Pipeline runs {{ PIPELINE_SCHEDULE_TEXT }}. Next: {{ nextRun }}</span>
          </div>
          <v-btn
            variant="text"
            block
            class="shell__logout"
            height="44"
            prepend-icon="mdi-logout-variant"
            :loading="loggingOut"
            @click="logout"
          >
            Sign out
          </v-btn>
          <div v-if="logoutError" class="shell__error" role="alert">{{ logoutError }}</div>
        </div>
      </template>
    </v-navigation-drawer>

    <v-main class="shell__main">
      <v-container fluid class="shell__container">
        <slot />
      </v-container>
    </v-main>

    <v-layout-item
      class="d-md-none"
      :model-value="!isDesktop"
      position="bottom"
      size="0"
    >
      <v-bottom-navigation
        color="primary"
        grow
        height="56"
        bg-color="background"
        class="shell__bottom"
        :active="!isDesktop"
      >
        <!-- base-color: Vuetify colors a link button only on its own exact path, so Settings sub pages
             and /review/12 left their button gray while it was the active one. -->
        <v-btn
          v-for="item in navItems.filter(i => i.inBottomNav)"
          :key="item.to"
          :to="item.to"
          :value="item.to"
          :active="isActiveRoute(item)"
          :base-color="isActiveRoute(item) ? 'primary' : undefined"
          :aria-label="item.title"
        >
          <!-- Not floating: a floating badge sat above the icon and straddled the nav's top edge. -->
          <v-badge
            :model-value="badgeFor(item) > 0"
            :content="badgeFor(item).toLocaleString('en-US')"
            :color="item.to === '/questions' ? 'warning' : 'primary'"
            offset-y="3"
            class="shell__badge"
          >
            <v-icon :icon="item.icon" />
          </v-badge>
          <span class="shell__bottom-label">{{ item.short }}</span>
        </v-btn>
      </v-bottom-navigation>
    </v-layout-item>

    <AppSnackbar />
  </v-app>
</template>

<style scoped lang="scss">
.shell {
  &__bar {
    border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)) !important;
  }

  &__bar-title {
    font-weight: 600;
    font-size: 1.0625rem;
    letter-spacing: -0.01em;
  }

  &__drawer {
    border-right: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)) !important;
  }

  &__brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 16px 12px;
  }

  &__mark {
    width: 28px;
    height: 28px;
    flex: none;
    fill: none;
    stroke-width: 4;
  }

  &__mark-track {
    stroke: rgb(var(--v-theme-surface-light));
  }

  &__mark-arc {
    stroke: rgb(var(--v-theme-primary));
    stroke-linecap: round;
  }

  &__name {
    font-weight: 600;
    font-size: 0.9375rem;
    letter-spacing: -0.01em;
    line-height: 1.2;
  }

  &__owner {
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__nav {
    padding: 4px 8px;
  }

  &__nav-item {
    margin-bottom: 1px;

    :deep(.v-list-item__prepend) {
      width: 32px;
    }

    :deep(.v-list-item-title) {
      font-size: 0.875rem;
      font-weight: 500;
    }

    :deep(.v-list-item__spacer) {
      width: 0;
    }

    // On dark the active item is marked by brightness alone: the label and icon go from the
    // secondary gray to white. No pill, no tint, no bar.
    &:not(.v-list-item--active) {
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    }

    &.v-list-item--active {
      color: rgb(var(--v-theme-on-surface));

      :deep(.v-list-item__overlay) {
        opacity: 0;
      }

      :deep(.v-list-item-title) {
        font-weight: 600;
      }
    }
  }

  // While a Settings page is open and the group is folded, its header keeps a quiet mark.
  &__nav-item--within {
    color: rgb(var(--v-theme-primary));
  }

  &__chev {
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  // Sub pages: text only, lined up under the group title (8px row padding plus the 32px icon slot).
  // The vertical rule on the left ties them to Settings without a second icon column.
  &__group :deep(.v-list-group__items) {
    position: relative;
    margin: 0 0 2px;

    &::before {
      content: '';
      position: absolute;
      top: 2px;
      bottom: 2px;
      left: 17px;
      width: 1px;
      background: rgba(var(--v-border-color), var(--v-border-opacity));
    }
  }

  &__group :deep(.v-list-group__items .v-list-item.shell__sub-item) {
    padding-inline-start: 40px !important;
    margin-bottom: 0;
  }

  &__sub-item {
    :deep(.v-list-item-title) {
      font-size: 0.8125rem;
      font-weight: 500;
    }

    :deep(.v-list-item__spacer) {
      width: 0;
    }

    &:not(.v-list-item--active) :deep(.v-list-item-title) {
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    }

    &.v-list-item--active {
      :deep(.v-list-item__overlay) {
        opacity: 0;
      }

      :deep(.v-list-item-title) {
        color: rgb(var(--v-theme-on-surface));
        font-weight: 600;
      }
    }
  }

  &__attn {
    width: 8px;
    height: 8px;
    margin-right: 6px;
    border-radius: 2px;
    background: rgb(var(--v-theme-warning));
  }

  // Status tag from the design system: 12px/600, 2px 8px, 6px corners, color at 12% fill.
  &__tag {
    font-size: 0.6875rem;
    font-weight: 600;
    line-height: 1.4;
    padding: 1px 6px;
    border-radius: 6px;

    &--warning {
      color: rgb(var(--v-theme-warning));
      background: rgba(var(--v-theme-warning), 0.12);
    }
  }

  &__count {
    min-width: 22px;
    height: 20px;
    padding: 0 6px;
    border-radius: 4px;
    display: inline-grid;
    place-items: center;
    font-size: 0.75rem;
    font-weight: 600;
    background: rgb(var(--v-theme-surface-bright));
    color: rgb(var(--v-theme-on-surface));

    // Questions that block an approval: the one place the nav carries amber.
    &--blocking {
      background: rgba(var(--v-theme-warning), 0.16);
      color: rgb(var(--v-theme-warning));
    }
  }

  &__foot {
    padding: 8px 8px 12px;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__schedule {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px 8px;
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__logout {
    justify-content: flex-start;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__error {
    padding: 6px 8px 0;
    font-size: 0.75rem;
    color: rgb(var(--v-theme-error));
  }

  &__main {
    background: rgb(var(--v-theme-background));
  }

  &__container {
    max-width: 1440px;
    padding: 24px 16px;

    @media (min-width: 960px) {
      padding: 28px 32px;
    }
  }

  // A 4px inset keeps the end labels ("Settings") on the 16px phone margin.
  &__bottom {
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    padding-inline: 4px;
  }

  &__bottom-label {
    font-size: 0.75rem;
    font-weight: 500;
    margin-top: 2px;
    white-space: nowrap;
  }
}

// Before the page is interactive the drawer's mode comes from the user agent. On a narrow
// screen that guessed wrong, keep the desktop drawer from painting over the content.
@media (max-width: 959.98px) {
  .shell--prehydrate :deep(.v-navigation-drawer--active:not(.v-navigation-drawer--temporary)) {
    display: none;
  }

  .shell--prehydrate :deep(.v-main) {
    padding-left: 0 !important;
  }
}
</style>
