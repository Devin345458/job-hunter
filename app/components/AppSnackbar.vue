<script setup lang="ts">
import { useDisplay } from 'vuetify'

const { state } = useSnackbar()
// Desktop: bottom left, over the navigation, clear of the review card's decision bar.
// Phone: top, clear of the decision bar and the bottom navigation.
const { mdAndUp } = useDisplay()

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
    :location="mdAndUp ? 'bottom start' : 'top'"
    :min-width="mdAndUp ? 280 : undefined"
    :max-width="mdAndUp ? 340 : undefined"
    rounded="lg"
    class="app-snackbar"
    :role="state.color === 'error' ? 'alert' : 'status'"
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
