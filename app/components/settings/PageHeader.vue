<script setup lang="ts">
// The header every Settings sub page opens with: "Settings" above the sub page's title and its one
// sentence, all from app/utils/settingsPages.ts. On a phone the app bar's back arrow returns to
// the Settings list; on desktop the sidebar group shows where the page sits.
const props = defineProps<{ slug: string }>()
const page = computed(() => SETTINGS_PAGES.find(p => p.slug === props.slug))
</script>

<template>
  <header v-if="page" class="page-header settings-head">
    <div class="settings-head__eyebrow">Settings</div>
    <h1 class="text-h4 page-header__title">{{ page.title }}</h1>
    <p class="text-body-2 page-header__subtitle">{{ page.subtitle }}</p>
  </header>
</template>

<style scoped lang="scss">
.settings-head {
  margin-bottom: 24px;

  &__eyebrow {
    margin-bottom: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }
}
</style>
