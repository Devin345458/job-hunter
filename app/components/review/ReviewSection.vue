<script setup lang="ts">
// One collapsible block of a review card. Long documents stay closed until opened; the
// summary line says what is inside so a closed section still informs the decision.
const props = withDefaults(defineProps<{
  title: string
  summary?: string | null
  icon?: string
  defaultOpen?: boolean
  /** Colors the summary line when it carries a warning or an error. */
  tone?: 'default' | 'warning' | 'error' | 'success'
}>(), {
  summary: null,
  icon: undefined,
  defaultOpen: false,
  tone: 'default',
})

const open = ref(props.defaultOpen)
const id = useId()
const el = ref<HTMLElement | null>(null)

/** Opens the section and scrolls its heading to the top of the nearest scrolling box. */
function show() {
  open.value = true
  nextTick(() => el.value?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
}
defineExpose({ show })
</script>

<template>
  <section ref="el" class="rsec" :class="{ 'rsec--open': open }">
    <button
      type="button"
      class="rsec__head"
      :aria-expanded="open"
      :aria-controls="id"
      @click="open = !open"
    >
      <v-icon v-if="icon" :icon="icon" size="18" class="rsec__icon" />
      <span class="rsec__title">{{ title }}</span>
      <span v-if="summary" class="rsec__summary" :class="`rsec__summary--${tone}`">{{ summary }}</span>
      <v-icon icon="mdi-chevron-down" size="20" class="rsec__chevron" />
    </button>
    <v-expand-transition>
      <div v-show="open" :id="id" class="rsec__body">
        <slot />
      </div>
    </v-expand-transition>
  </section>
</template>

<style scoped lang="scss">
.rsec {
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

  &__head {
    width: 100%;
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 0;
    text-align: left;
    color: inherit;
    cursor: pointer;
    border-radius: 6px;

    &:hover .rsec__title {
      color: rgb(var(--v-theme-primary));
    }
  }

  &__icon {
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    flex-shrink: 0;
  }

  &__title {
    font-weight: 600;
    font-size: 0.9375rem;
    flex-shrink: 0;
    transition: color 0.15s cubic-bezier(0.23, 1, 0.32, 1);
  }

  &__summary {
    flex: 1;
    min-width: 0;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;

    &--warning { color: rgb(var(--v-theme-warning)); }
    &--error { color: rgb(var(--v-theme-error)); }
    &--success { color: rgb(var(--v-theme-success)); }
  }

  &__chevron {
    margin-left: auto;
    flex-shrink: 0;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    transition: transform 0.2s cubic-bezier(0.23, 1, 0.32, 1);
  }

  &--open &__chevron {
    transform: rotate(180deg);
  }

  &__body {
    padding: 0 0 20px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rsec__chevron { transition: none; }
}
</style>
