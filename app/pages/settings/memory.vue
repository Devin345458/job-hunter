<script setup lang="ts">
// Settings > Memory: whether the app can reach the memory server on Devin's laptop, and Check now.
definePageMeta({ layout: 'default' })
</script>

<template>
  <div class="fade-in">
    <SettingsPageHeader slug="memory" />
    <v-card variant="outlined">
      <v-card-text class="pa-5">
        <SettingsMemoryStatus />
      </v-card-text>
    </v-card>
  </div>
</template>
