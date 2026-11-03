<script setup lang="ts">
import { EXAMPLE_LONG_CHARS, EXAMPLE_MAX_CHARS } from '#shared/utils/limits'

// Under an example box ("Where did you do it?"): the count as "1,234 / 5,000", and past about
// 2,500 characters a note that most forms will shorten it. It only warns: the knowledge base keeps
// the whole example, and each form gets a copy shortened to its own limit.

const props = defineProps<{ text: string }>()

const n = computed(() => props.text.trim().length)
const long = computed(() => n.value > EXAMPLE_LONG_CHARS)
</script>

<template>
  <div class="example-count text-caption" :class="{ 'example-count--long': long }" aria-live="polite">
    <span v-if="long" class="example-count__warn">
      <v-icon icon="mdi-information-outline" size="14" />
      Most application forms take less than this, so they get a shortened copy. Your knowledge base keeps all of it.
    </span>
    <span class="example-count__n">{{ n.toLocaleString('en-US') }} / {{ EXAMPLE_MAX_CHARS.toLocaleString('en-US') }}</span>
  </div>
</template>

<style scoped lang="scss">
.example-count {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: flex-end;
  gap: 4px 12px;
  margin: 4px 0 8px;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));

  &__warn {
    flex: 1 1 240px;
    display: flex;
    align-items: flex-start;
    gap: 4px;
    color: rgb(var(--v-theme-warning));

    .v-icon {
      margin-top: 1px;
      flex: 0 0 auto;
    }
  }

  &__n {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
  }
}
</style>
