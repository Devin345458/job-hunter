<script setup lang="ts">
// Settings > Pipeline: Full run and every step with Run, the job queue with Cancel, and the run log.
definePageMeta({ layout: 'default' })
</script>

<template>
  <div class="fade-in">
    <SettingsPageHeader slug="pipeline" />
    <v-card variant="outlined">
      <v-card-text class="settings-pipeline">
        <ReviewPipelinePanel />
      </v-card-text>
    </v-card>
  </div>
</template>

<style scoped lang="scss">
.settings-pipeline {
  padding: 20px 24px;

  @media (max-width: 599.98px) {
    padding: 16px;
  }
}
</style>
