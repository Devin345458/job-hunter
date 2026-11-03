<script setup lang="ts">
import type { MemoryStatus } from '#shared/types/memory'

// Settings > Memory: whether the app can reach Devin's claude-self-reflect memory on his laptop
// (off, reachable, or not reachable) and when that was last checked. Check now opens and closes
// one session with the memory server; it never searches.

const status = ref<MemoryStatus | null>(null)
const error = ref<string | null>(null)
const checking = ref(false)

const LABEL: Record<MemoryStatus['state'], { text: string; color: string; icon: string }> = {
  off: { text: 'Off', color: 'default', icon: 'mdi-power' },
  reachable: { text: 'Reachable', color: 'success', icon: 'mdi-check-circle-outline' },
  busy: { text: 'Busy or asleep', color: 'default', icon: 'mdi-sleep' },
  unreachable: { text: 'Not reachable', color: 'warning', icon: 'mdi-lan-disconnect' },
  unknown: { text: 'Not checked yet', color: 'default', icon: 'mdi-help-circle-outline' },
}

function when(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  const time = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return t.toDateString() === new Date().toDateString() ? `today at ${time}` : `${t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${time}`
}

const label = computed(() => LABEL[status.value?.state ?? 'unknown'])

async function load() {
  try {
    status.value = await $fetch<MemoryStatus>('/api/memory/status')
    error.value = null
  }
  catch (e: any) {
    error.value = e?.data?.statusMessage || 'Could not read the memory status.'
  }
}

async function checkNow() {
  checking.value = true
  try {
    status.value = await $fetch<MemoryStatus>('/api/memory/check', { method: 'POST' })
    error.value = null
  }
  catch (e: any) {
    error.value = e?.data?.statusMessage || 'Could not check the memory server.'
  }
  finally {
    checking.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="memory-status">
    <div class="memory-status__line">
      <span class="memory-status__label text-body-2 font-weight-medium">Memory</span>
      <v-chip v-if="status" size="small" variant="tonal" :color="label.color" :prepend-icon="label.icon" label>{{ label.text }}</v-chip>
      <span v-if="status?.checkedAt" class="text-body-2 text-medium-emphasis">Last checked {{ when(status.checkedAt) }}</span>
      <v-spacer />
      <v-btn
        v-if="status && status.state !== 'off'"
        variant="tonal"
        height="44"
        prepend-icon="mdi-refresh"
        class="memory-status__check"
        :loading="checking"
        @click="checkNow"
      >
        Check now
      </v-btn>
    </div>
    <p v-if="error" class="text-body-2 text-error mt-2 mb-0" role="alert">{{ error }}</p>
    <p v-else-if="status?.state === 'off'" class="memory-status__text">
      Set NUXT_MEMORY_MCP_URL to your memory server's address to look up leads from your past Claude sessions on open questions.
    </p>
    <p v-else-if="status?.state === 'busy'" class="memory-status__text">
      Your laptop's memory server is busy or asleep. It did not answer in time, which happens while other Claude sessions use it or the laptop sleeps. Check now tries again. Leads already saved on questions still show, and the chat works without new ones.
    </p>
    <p v-else-if="status?.state === 'unreachable'" class="memory-status__text">
      {{ status.reason ? `${status.reason.charAt(0).toUpperCase()}${status.reason.slice(1)}.` : 'It did not answer.' }}
      Leads already saved on questions still show, and the chat works without new ones.
    </p>
    <p v-else-if="status" class="memory-status__text">
      Open questions show leads from your past Claude sessions, and the chat can use them when you ask for help writing. They are leads, not proof of work you did.
    </p>
    <p v-if="status?.lastLeadsRun" class="memory-status__text">
      Last lookup {{ when(status.lastLeadsRun.at) }}{{ status.lastLeadsRun.questionsWithLeads != null ? `: ${status.lastLeadsRun.questionsWithLeads} ${status.lastLeadsRun.questionsWithLeads === 1 ? 'question' : 'questions'} got leads` : '' }}.{{ status.lastLeadsRun.note ? ` ${status.lastLeadsRun.note}` : '' }}
    </p>
  </div>
</template>

<style scoped lang="scss">
.memory-status {
  &__line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    min-height: 44px;
  }

  &__check {
    text-transform: none;
    letter-spacing: normal;
  }

  &__text {
    margin: 8px 0 0;
    font-size: 0.875rem;
    line-height: 1.5;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    max-width: 720px;
    text-wrap: pretty;
  }
}
</style>
