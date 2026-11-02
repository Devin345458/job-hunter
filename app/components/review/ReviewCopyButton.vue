<script setup lang="ts">
// One Copy button: copies the text exactly (line breaks kept), then says "Copied" for a moment.
// Used for each form answer, the whole set of answers, and the cover letter, so a by-hand submit
// on the employer's site is paste, not retype. Falls back to a hidden textarea when the browser
// refuses the async clipboard (an http origin, or a permission it never granted).
const props = withDefaults(defineProps<{
  /** The text to copy, or a function that builds it at click time. */
  text: string | (() => string)
  label?: string
  /** Spoken name, e.g. "Copy Full Name". Defaults to the label. */
  ariaLabel?: string
  variant?: 'text' | 'tonal' | 'outlined'
}>(), {
  label: 'Copy',
  ariaLabel: undefined,
  variant: 'text',
})

const state = ref<'idle' | 'copied' | 'failed'>('idle')
let timer: ReturnType<typeof setTimeout> | null = null

function fallbackCopy(value: string): boolean {
  const area = document.createElement('textarea')
  area.value = value
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  area.style.pointerEvents = 'none'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  }
  catch {
    ok = false
  }
  area.remove()
  return ok
}

async function copy() {
  const value = typeof props.text === 'function' ? props.text() : props.text
  let ok = false
  try {
    await navigator.clipboard.writeText(value)
    ok = true
  }
  catch {
    ok = fallbackCopy(value)
  }
  state.value = ok ? 'copied' : 'failed'
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { state.value = 'idle' }, ok ? 1600 : 4000)
}

onBeforeUnmount(() => { if (timer) clearTimeout(timer) })

const shown = computed(() => (state.value === 'copied' ? 'Copied' : state.value === 'failed' ? 'Copy blocked: select the text instead' : props.label))
</script>

<template>
  <v-btn
    class="copy-btn"
    :variant="variant"
    height="44"
    :color="state === 'failed' ? 'error' : undefined"
    :prepend-icon="state === 'copied' ? 'mdi-check' : state === 'failed' ? 'mdi-alert-outline' : 'mdi-content-copy'"
    :aria-label="state === 'idle' ? (ariaLabel || label) : undefined"
    @click="copy"
  >
    <span aria-live="polite">{{ shown }}</span>
  </v-btn>
</template>

<style scoped lang="scss">
.copy-btn {
  font-size: 0.8125rem;
}
</style>
