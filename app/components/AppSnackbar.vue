<script setup lang="ts">
import { useDisplay } from 'vuetify'

const { state } = useSnackbar()
// Desktop: bottom left, over the navigation, clear of the review card's decision bar.
// Phone: just under the 56px app bar, so the menu button and the page name stay visible and the
// bottom navigation and the card's Reject and Approve stay free. On the review page it covers the
// Previous, Next, and Queue row for the few seconds it shows; the queue moves on by itself after a
// decision, and the close button dismisses it. Notices keep to two lines; errors show in full.
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
        :size="mdAndUp ? 'small' : 'default'"
        class="app-snackbar__btn"
        @click="onAction"
      >
        {{ state.action.text }}
      </v-btn>
      <v-btn
        variant="text"
        :size="mdAndUp ? 'small' : 'default'"
        icon="mdi-close"
        class="app-snackbar__btn"
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

  // Phone: just under the app bar, across the width with a small gutter. Vuetify already pads
  // the snackbar's overlay by the app bar's height (--v-layout-top), so the margin is the gap only.
  &--phone {
    margin: 6px 8px 0 !important;

    :deep(.v-snackbar__wrapper) {
      min-height: 52px;
    }

    :deep(.v-snackbar__content) {
      padding: 4px 4px 4px 12px;
    }

    :deep(.v-snackbar__actions) {
      margin-inline-end: 2px;
    }

    // Tap targets on a phone: 44px, corners still 8px from the global button settings.
    .app-snackbar__btn {
      min-width: 44px;
      min-height: 44px;
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
