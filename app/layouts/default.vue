<script setup lang="ts">
const drawer = ref(true)
const mobile = ref(false)

interface NavItem {
  title: string
  icon: string
  to: string
}

const navItems: NavItem[] = [
  { title: 'Dashboard', icon: 'mdi-view-dashboard', to: '/' },
  { title: 'Jobs', icon: 'mdi-briefcase-search', to: '/jobs' },
  { title: 'Applications', icon: 'mdi-file-document-edit', to: '/applications' },
  { title: 'Knowledge Base', icon: 'mdi-brain', to: '/knowledge' },
  { title: 'Questions', icon: 'mdi-chat-question', to: '/questions' },
  { title: 'Settings', icon: 'mdi-cog', to: '/settings' },
]

const route = useRoute()

const isActiveRoute = (to: string) => {
  if (to === '/') return route.path === '/'
  return route.path.startsWith(to)
}
</script>

<template>
  <v-app>
    <v-app-bar
      class="d-md-none"
      color="surface"
      flat
    >
      <v-app-bar-nav-icon @click="drawer = !drawer" />
      <v-app-bar-title>
        <v-icon icon="mdi-target" color="primary" class="mr-2" />
        Job Hunter
      </v-app-bar-title>
    </v-app-bar>

    <v-navigation-drawer
      v-model="drawer"
      :permanent="!mobile"
      :temporary="mobile"
      color="surface"
      width="260"
      @update:model-value="(val: boolean) => { if (mobile) drawer = val }"
    >
      <div class="pa-4 d-flex align-center ga-3">
        <v-icon icon="mdi-target" color="primary" size="32" />
        <span class="text-h6 font-weight-bold">Job Hunter</span>
      </div>

      <v-divider class="mb-2" />

      <v-list nav density="comfortable">
        <v-list-item
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          :prepend-icon="item.icon"
          :title="item.title"
          :active="isActiveRoute(item.to)"
          rounded="lg"
          class="mb-1"
          color="primary"
        />
      </v-list>
    </v-navigation-drawer>

    <v-main>
      <v-container fluid class="pa-4 pa-md-6">
        <slot />
      </v-container>
    </v-main>

    <v-layout-item
      model-value
      position="bottom"
      class="d-md-none"
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
  </v-app>
</template>

<style scoped lang="scss">
.v-navigation-drawer {
  border-right: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
</style>
