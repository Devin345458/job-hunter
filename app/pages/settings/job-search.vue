<script setup lang="ts">
// Settings > Job search: what the scheduled searches look for (Search Configurations), then each
// source's last pull and Pull everything again (Job sources).
definePageMeta({ layout: 'default' })
</script>

<template>
  <div class="fade-in">
    <SettingsPageHeader slug="job-search" />
    <SettingsSearchConfigs class="mb-6" />
    <SettingsJobSources />
  </div>
</template>
