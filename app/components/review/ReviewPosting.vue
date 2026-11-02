<script setup lang="ts">
// A job posting's saved text, laid out the way the employer wrote it. Posting text arrives with
// one line per paragraph, heading, or bullet and no other markup, so each line becomes a block:
// short lines without closing punctuation are headings, "- " lines are list items, the rest are
// paragraphs. Rendered through the template (never v-html), so posting text cannot inject markup.
const props = defineProps<{ text: string }>()

type Block = { kind: 'h' | 'p'; text: string } | { kind: 'ul'; items: string[] }

const BULLET = /^\s*(?:[-*•●▪]|\d+[.)])\s+/

function isHeading(line: string, next: string | undefined) {
  if (!next || BULLET.test(line)) return false
  const words = line.split(/\s+/).length
  return line.length <= 70 && words <= 10 && !/[.!?,;]$/.test(line) && !/^https?:/i.test(line)
}

const blocks = computed<Block[]>(() => {
  const lines = props.text.replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean)
  const out: Block[] = []
  lines.forEach((line, i) => {
    if (BULLET.test(line)) {
      const item = line.replace(BULLET, '')
      const last = out[out.length - 1]
      if (last?.kind === 'ul') last.items.push(item)
      else out.push({ kind: 'ul', items: [item] })
      return
    }
    out.push({ kind: isHeading(line, lines[i + 1]) ? 'h' : 'p', text: line })
  })
  return out
})
</script>

<template>
  <div class="post">
    <template v-for="(b, i) in blocks" :key="i">
      <h3 v-if="b.kind === 'h'" class="post__h">{{ b.text }}</h3>
      <ul v-else-if="b.kind === 'ul'" class="post__list">
        <li v-for="(item, j) in b.items" :key="j">{{ item }}</li>
      </ul>
      <p v-else class="post__p">{{ b.text }}</p>
    </template>
  </div>
</template>

<style scoped lang="scss">
.post {
  font-size: 0.875rem;
  line-height: 1.65;
  overflow-wrap: anywhere;

  &__h {
    font-size: 0.9375rem;
    font-weight: 700;
    line-height: 1.35;
    margin: 20px 0 6px;

    &:first-child {
      margin-top: 0;
    }
  }

  &__p {
    margin: 0 0 10px;
  }

  &__list {
    margin: 0 0 12px;
    padding-left: 20px;

    li + li {
      margin-top: 4px;
    }
  }
}
</style>
