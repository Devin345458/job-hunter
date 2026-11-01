<script setup lang="ts">
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
  { title: 'Applications', short: 'Applied', icon: 'mdi-file-document-check-outline', to: '/applications', inBottomNav: true },
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

const activePageTitle = computed(() => navItems.find(isActiveRoute)?.title || 'Job Hunter')

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

function badgeFor(item: NavItem): number {
  if (item.to === '/') return health.stats.value?.review.toDecide ?? 0
  if (item.to === '/questions') return health.stats.value?.questions.pending ?? 0
  return 0
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
      <v-app-bar-nav-icon aria-label="Open navigation" @click="drawer = !drawer" />
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
        <div class="shell__mark" aria-hidden="true">
          <v-icon icon="mdi-target" size="18" />
        </div>
        <div>
          <div class="shell__name">Job Hunter</div>
          <div class="shell__owner">Devin's pipeline</div>
        </div>
      </div>

      <v-list nav density="compact" class="shell__nav" aria-label="Main">
        <v-list-item
          v-for="item in navItems"
          :key="item.to"
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
            <span class="shell__count tabular" :aria-label="`${badgeFor(item)} waiting`">{{ badgeFor(item) }}</span>
          </template>
        </v-list-item>
      </v-list>

      <template #append>
        <div class="shell__foot">
          <div class="shell__schedule">
            <v-icon icon="mdi-clock-outline" size="14" />
            <span>Pipeline runs daily at 6:00 Central</span>
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
        <v-btn
          v-for="item in navItems.filter(i => i.inBottomNav)"
          :key="item.to"
          :to="item.to"
          :value="item.to"
          :active="isActiveRoute(item)"
          :aria-label="item.title"
        >
          <v-badge
            :model-value="badgeFor(item) > 0"
            :content="badgeFor(item)"
            color="primary"
            floating
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
    font-weight: 700;
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
    padding: 20px 16px 16px;
  }

  &__mark {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: grid;
    place-items: center;
    background: rgb(var(--v-theme-primary));
    color: rgb(var(--v-theme-on-primary));
  }

  &__name {
    font-weight: 700;
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
    margin-bottom: 2px;

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
    background: rgba(var(--v-theme-on-surface), 0.08);
    color: rgb(var(--v-theme-on-surface));
  }

  &__foot {
    padding: 12px 8px 16px;
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

  &__bottom {
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__bottom-label {
    font-size: 0.6875rem;
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
