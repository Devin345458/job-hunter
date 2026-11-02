<script setup lang="ts">
// A file path that wraps at its slashes first, so "src/components/NoteEditor.test.tsx" breaks
// as "src/components/" and "NoteEditor.test.tsx", never mid-word. Each folder and the file
// name is its own inline block; only a name wider than the whole line breaks again, before a
// dot or after a hyphen or underscore. The full path shows on hover.
const props = defineProps<{ path: string }>()

const segments = computed(() => {
  const names = props.path.split('/')
  return names.map((name, i) => {
    const text = i < names.length - 1 ? `${name}/` : name
    return text.split(/(?<=[_-])|(?=\.)/).filter(Boolean)
  })
})
</script>

<template>
  <span class="demo-path" :title="path"><template v-for="(parts, i) in segments" :key="i"><wbr v-if="i > 0"><span class="demo-path__segment"><template v-for="(part, j) in parts" :key="j"><wbr v-if="j > 0">{{ part }}</template></span></template></span>
</template>

<style scoped lang="scss">
.demo-path {
  word-break: normal;

  &__segment {
    display: inline-block;
    max-width: 100%;
    // Break inside a piece only when that piece alone is wider than the line.
    overflow-wrap: break-word;
  }
}
</style>
