<script setup lang="ts">
import { useDisplay } from 'vuetify'

const { state } = useSnackbar()
// Desktop: bottom left, over the navigation, clear of the review card's decision bar.
// Phone: over the 56px app bar (menu button and page name), which nothing needs for the few
// seconds a notice shows. Below the app bar the review page pins its count and Previous, Next,
// Queue, and the decision bar sits at the bottom; a notice in either place covered what comes
// next. Notices there keep to two lines so they stay inside the bar; errors show in full.
const { mdAndUp } = useDisplay()
const clamp = computed(() => !mdAndUp.value && state.color !== 'error')

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
    :class="{ 'app-snackbar--phone': !mdAndUp, 'app-snackbar--clamp': clamp }"
    :role="state.color === 'error' ? 'alert' : 'status'"
  >
    <div class="d-flex align-center ga-3">
      <v-icon :icon="state.icon" size="20" class="app-snackbar__icon" />
      <span class="text-body-2 app-snackbar__text" :title="clamp ? state.message : undefined">{{ state.message }}</span>
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
        aria-label="Dismiss"
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

  // Phone: sit in the app bar's band (top of the screen to 56px) instead of under it.
  &--phone {
    padding-top: env(safe-area-inset-top, 0px) !important;
    margin: 4px 8px !important;

    :deep(.v-snackbar__wrapper) {
      min-height: 48px;
    }

    :deep(.v-snackbar__content) {
      padding: 4px 4px 4px 12px;
    }

    :deep(.v-snackbar__actions) {
      margin-inline-end: 2px;
    }
  }

  &--clamp &__text {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    font-size: 0.8125rem !important;
    line-height: 1.3 !important;
  }
}
</style>
