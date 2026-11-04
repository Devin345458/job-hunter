<script setup lang="ts">
// Settings > GitHub evidence: the Repos tab (find, index, switches) and the Identities and tokens tab.
definePageMeta({ layout: 'default' })
</script>

<template>
  <div class="fade-in">
    <SettingsPageHeader slug="github-evidence" />
    <SettingsGithubEvidence />
  </div>
</template>
