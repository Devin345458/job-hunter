<script setup lang="ts">
// Settings > Claude usage: the subscription estimate against this app's limits, the limit fields,
// the API key budget, and where the spend went by stage.
definePageMeta({ layout: 'default' })
</script>

<template>
  <div class="fade-in">
    <SettingsPageHeader slug="claude-usage" />
    <SettingsClaudeUsage />
  </div>
</template>
