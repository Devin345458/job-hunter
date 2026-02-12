<script setup lang="ts">
const { state } = useSnackbar()

function onAction() {
  if (state.action?.handler) {
    state.action.handler()
  }
  state.show = false
}
</script>

<template>
  <v-snackbar
    v-model="state.show"
    :color="state.color"
    :timeout="state.timeout"
    location="bottom end"
    rounded="lg"
    class="app-snackbar"
  >
    <div class="d-flex align-center ga-3">
      <v-icon :icon="state.icon" size="20" />
      <span class="text-body-2">{{ state.message }}</span>
    </div>

    <template #actions>
      <v-btn
        v-if="state.action"
        variant="text"
        size="small"
        @click="onAction"
      >
        {{ state.action.text }}
      </v-btn>
      <v-btn
        variant="text"
        size="small"
        icon="mdi-close"
        @click="state.show = false"
      />
    </template>
  </v-snackbar>
</template>

<style scoped lang="scss">
.app-snackbar {
  :deep(.v-snackbar__wrapper) {
    backdrop-filter: blur(12px);
  }
}
</style>
