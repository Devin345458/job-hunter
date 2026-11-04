<script setup lang="ts">
// The header every Settings sub page opens with: its title and one gray line about its data (or
// nothing), from app/utils/settingsPages.ts. The sidebar's open Settings group names the section,
// so there is no label above the title.
const props = defineProps<{ slug: string }>()
const page = computed(() => SETTINGS_PAGES.find(p => p.slug === props.slug))
</script>

<template>
  <header v-if="page" class="page-header settings-head">
    <h1 class="text-h4 page-header__title">{{ page.title }}</h1>
    <p v-if="page.subtitle" class="page-header__subtitle">{{ page.subtitle }}</p>
  </header>
</template>

<style scoped lang="scss">
.settings-head {
  margin-bottom: 24px;
}
</style>
