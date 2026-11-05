<script setup lang="ts">
// The employer form's own text for the field a form question came from (FormField.description):
// the instruction its label points at ("the sender address above"). Shown under the question on
// the Questions page and on the review card. An email address selects whole with one click, so it
// can be pasted into a safe sender list; a link opens in a new tab. Long legal text is cut to a few
// lines with Show all.

const props = defineProps<{ text: string }>()

interface Part { kind: 'text' | 'email' | 'url'; value: string }

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/
const LINK = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/
const TOKEN = new RegExp(`(${EMAIL.source})|(${LINK.source})`, 'g')

const parts = computed<Part[]>(() => {
  const out: Part[] = []
  let last = 0
  for (const m of props.text.matchAll(TOKEN)) {
    const at = m.index ?? 0
    if (at > last) out.push({ kind: 'text', value: props.text.slice(last, at) })
    out.push({ kind: m[1] ? 'email' : 'url', value: m[0] })
    last = at + m[0].length
  }
  if (last < props.text.length) out.push({ kind: 'text', value: props.text.slice(last) })
  return out
})

/** Text past this many characters starts cut to four lines. */
const LONG = 280
const long = computed(() => props.text.length > LONG)
const expanded = ref(false)
</script>

<template>
  <div class="form-field-text">
    <span class="form-field-text__label">On the form</span>
    <p class="form-field-text__body" :class="{ 'form-field-text__body--clamped': long && !expanded }">
      <template v-for="(p, i) in parts" :key="i">
        <span v-if="p.kind === 'email'" class="form-field-text__email">{{ p.value }}</span>
        <a v-else-if="p.kind === 'url'" :href="p.value" target="_blank" rel="noopener noreferrer" class="form-field-text__link">{{ p.value }}</a>
        <template v-else>{{ p.value }}</template>
      </template>
    </p>
    <button v-if="long" type="button" class="form-field-text__more" :aria-expanded="expanded" @click="expanded = !expanded">
      {{ expanded ? 'Show less' : 'Show all' }}
    </button>
  </div>
</template>

<style scoped lang="scss">
.form-field-text {
  margin: 6px 0 12px;
  padding: 8px 12px;
  max-width: 680px;
  border-left: 3px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-on-surface), 0.03);
  border-radius: 0 6px 6px 0;

  &__label {
    display: block;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    margin-bottom: 2px;
  }

  &__body {
    margin: 0;
    font-size: 0.875rem;
    line-height: 1.5;
    color: rgba(var(--v-theme-on-surface), var(--v-high-emphasis-opacity));
    text-wrap: pretty;
    overflow-wrap: anywhere;
    user-select: text;

    &--clamped {
      display: -webkit-box;
      -webkit-line-clamp: 4;
      line-clamp: 4;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
  }

  // One click selects the whole address, and it never breaks at its hyphen ("no-" / "reply@...").
  &__email {
    font-weight: 600;
    white-space: nowrap;
    user-select: all;
    cursor: text;
  }

  &__link {
    color: rgb(var(--v-theme-primary));
  }

  &__more {
    margin-top: 4px;
    min-height: 32px;
    padding: 0;
    font-size: 0.8125rem;
    font-weight: 500;
    color: rgb(var(--v-theme-primary));
    background: none;
    border: 0;
    cursor: pointer;

    &:hover,
    &:focus-visible {
      text-decoration: underline;
    }
  }
}
</style>
