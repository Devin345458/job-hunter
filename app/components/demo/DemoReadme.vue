<script setup lang="ts">
// Renders a demo's README. The README is model-written, so the renderer escapes all HTML
// first and only then adds the handful of Markdown constructs a README uses: headings,
// fenced code, lists, bold, inline code, and http(s) links.
const props = defineProps<{ source: string }>()

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function inline(s: string) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
}

function render(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let para: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
  }
  const flushList = () => {
    if (list) out.push(`<${list.ordered ? 'ol' : 'ul'}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.ordered ? 'ol' : 'ul'}>`)
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = /^```(\S*)/.exec(line)
    if (fence) {
      flushPara()
      flushList()
      const code: string[] = []
      while (++i < lines.length && !/^```/.test(lines[i]!)) code.push(lines[i]!)
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushPara()
      flushList()
      const level = Math.min(6, heading[1]!.length + 1)
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`)
      continue
    }
    const item = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line)
    if (item) {
      flushPara()
      const ordered = /\d/.test(item[1]!)
      if (list && list.ordered !== ordered) flushList()
      if (!list) list = { ordered, items: [] }
      list.items.push(item[2]!)
      continue
    }
    if (!line.trim()) {
      flushPara()
      flushList()
      continue
    }
    if (list) {
      // Continuation of the previous list item.
      list.items[list.items.length - 1] += ` ${line.trim()}`
      continue
    }
    para.push(line.trim())
  }
  flushPara()
  flushList()
  return out.join('\n')
}

const html = computed(() => render(props.source || ''))
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="demo-readme" v-html="html" />
</template>

<style scoped lang="scss">
.demo-readme {
  line-height: 1.7;
  font-size: 0.9375rem;
  overflow-wrap: anywhere;

  :deep(h2),
  :deep(h3),
  :deep(h4) {
    font-weight: 700;
    letter-spacing: -0.01em;
    margin: 1.4em 0 0.5em;
  }

  :deep(h2) {
    font-size: 1.35rem;
    margin-top: 0;
  }

  :deep(h3) {
    font-size: 1.1rem;
  }

  :deep(h4) {
    font-size: 1rem;
  }

  :deep(p),
  :deep(ul),
  :deep(ol) {
    margin: 0 0 0.9em;
  }

  :deep(ul),
  :deep(ol) {
    padding-left: 1.4em;
  }

  :deep(code) {
    font-size: 0.85em;
    padding: 0.1em 0.35em;
    border-radius: 4px;
    background: rgba(var(--v-theme-on-surface), 0.08);
  }

  :deep(pre) {
    margin: 0 0 1em;
    padding: 12px 14px;
    border-radius: 8px;
    overflow-x: auto;
    background: rgba(var(--v-theme-on-surface), 0.05);
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

    code {
      padding: 0;
      background: none;
      font-size: 0.8125rem;
    }
  }

  :deep(a) {
    color: rgb(var(--v-theme-primary));
  }
}
</style>
