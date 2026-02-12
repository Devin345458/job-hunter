<script setup lang="ts">
const drawer = ref(true)
const hydrated = ref(false)
const { mdAndUp } = useDisplay()

interface NavItem {
  title: string
  icon: string
  to: string
  description: string
}

const navItems: NavItem[] = [
  { title: 'Dashboard', icon: 'mdi-view-dashboard-outline', to: '/', description: 'Overview & quick actions' },
  { title: 'Jobs', icon: 'mdi-briefcase-search-outline', to: '/jobs', description: 'Browse & filter job listings' },
  { title: 'Applications', icon: 'mdi-file-document-edit-outline', to: '/applications', description: 'Track your applications' },
  { title: 'Knowledge Base', icon: 'mdi-lightbulb-outline', to: '/knowledge', description: 'Your professional profile' },
  { title: 'Questions', icon: 'mdi-chat-processing-outline', to: '/questions', description: 'Fill profile gaps' },
  { title: 'Settings', icon: 'mdi-tune-variant', to: '/settings', description: 'Search configs & API keys' },
]

const route = useRoute()

const isActiveRoute = (to: string) => {
  if (to === '/') return route.path === '/'
  return route.path.startsWith(to)
}

const activePageTitle = computed(() => {
  const item = navItems.find(n => isActiveRoute(n.to))
  return item?.title || 'Job Hunter'
})

const isDesktop = computed(() => (hydrated.value ? mdAndUp.value : true))
const showMobileChrome = computed(() => hydrated.value && !mdAndUp.value)

watch(
  isDesktop,
  (desktop) => {
    drawer.value = desktop
  },
  { immediate: true },
)

onMounted(() => {
  hydrated.value = true
})
</script>

<template>
  <v-app>
    <!-- Mobile App Bar -->
    <v-app-bar
      v-if="showMobileChrome"
      color="surface"
      flat
    >
      <v-app-bar-nav-icon @click="drawer = !drawer" />
      <v-app-bar-title class="font-weight-bold">
        {{ activePageTitle }}
      </v-app-bar-title>
    </v-app-bar>

    <!-- Sidebar Navigation -->
    <v-navigation-drawer
      v-model="drawer"
      :permanent="isDesktop"
      :temporary="!isDesktop"
      color="surface"
      width="260"
      @update:model-value="(val: boolean) => { if (!isDesktop) drawer = val }"
    >
      <!-- Brand -->
      <div class="sidebar-brand pa-5 pb-4">
        <div class="d-flex align-center ga-3">
          <div class="sidebar-brand__logo">
            <v-icon icon="mdi-target" color="primary" size="26" />
          </div>
          <div>
            <div class="text-subtitle-1 font-weight-bold" style="letter-spacing: -0.02em; line-height: 1.2;">
              Job Hunter
            </div>
            <div class="text-caption" style="opacity: 0.4;">
              AI-Powered Job Search
            </div>
          </div>
        </div>
      </div>

      <v-divider class="mx-4 mb-2" />

      <!-- Navigation -->
      <v-list nav density="comfortable" class="px-3">
        <v-list-item
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          :active="isActiveRoute(item.to)"
          rounded="lg"
          class="mb-1 nav-item"
          color="primary"
          min-height="44"
        >
          <template #prepend>
            <v-icon :icon="item.icon" size="20" class="mr-3" />
          </template>
          <v-list-item-title class="text-body-2 font-weight-medium">
            {{ item.title }}
          </v-list-item-title>
        </v-list-item>
      </v-list>

      <template #append>
        <v-divider class="mx-4" />
        <div class="pa-4">
          <div class="info-banner">
            <div class="d-flex align-start ga-2">
              <v-icon icon="mdi-information-outline" size="16" class="mt-1 info-banner__icon" />
              <div class="info-banner__text">
                Jobs are searched daily at <strong>6 AM</strong> and scored at <strong>7 AM</strong>.
                Use Settings to configure.
              </div>
            </div>
          </div>
        </div>
      </template>
    </v-navigation-drawer>

    <!-- Main Content -->
    <v-main>
      <v-container fluid class="pa-5 pa-md-8" style="max-width: 1400px;">
        <slot />
      </v-container>
    </v-main>

    <!-- Mobile Bottom Navigation -->
    <v-layout-item
      v-if="showMobileChrome"
      model-value
      position="bottom"
      size="0"
    >
      <v-bottom-navigation color="primary" grow>
        <v-btn
          v-for="item in navItems.slice(0, 5)"
          :key="item.to"
          :to="item.to"
          :value="item.to"
        >
          <v-icon :icon="item.icon" />
          <span class="text-caption">{{ item.title }}</span>
        </v-btn>
      </v-bottom-navigation>
    </v-layout-item>

    <AppSnackbar />
  </v-app>
</template>

<style scoped lang="scss">
.v-navigation-drawer {
  border-right: 1px solid rgba(var(--v-border-color), 0.06) !important;
}

.sidebar-brand {
  &__logo {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    background: rgba(99, 102, 241, 0.1);
    display: flex;
    align-items: center;
    justify-content: center;
  }
}

.nav-item {
  transition: background-color 0.15s ease;

  &:not(.v-list-item--active):hover {
    background: rgba(255, 255, 255, 0.03);
  }
}
</style>
