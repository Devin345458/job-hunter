<script setup lang="ts">
import type { OutcomeEntry, OutcomeStatus } from '#shared/types/pipeline'
import { OUTCOMES, SENT_STATUSES, formatDay, localToday, outcomeLabel } from '#shared/utils/outcomes'

// What happened after an application went out. A submitted application takes an employer outcome
// (heard back, interviewing, rejected by employer, offer, no response), each with a day and an
// optional note; one waiting for a submit by hand takes "I submitted it". The full control sits on
// the application page with the history under it; the compact one is a menu on a list card.
const props = withDefaults(defineProps<{
  applicationId: number
  status: string
  isSandbox?: boolean
  /** Company and role, named in the dialog so a list card's menu says which application it records. */
  title?: string | null
  /** Newest line first, from GET /api/applications/:id. Full control only. */
  history?: OutcomeEntry[]
  compact?: boolean
}>(), { isSandbox: false, title: null, history: () => [], compact: false })

const emit = defineEmits<{ saved: [OutcomeEntry['status']] }>()
const snackbar = useSnackbar()

const sent = computed(() => SENT_STATUSES.includes(props.status as any))
/**
 * Yours to submit by hand: approved and handed back, or marked by hand at preparation (account
 * required, no application link, preparation failed). "approved" itself is still in flight, so it
 * does not get the button although PATCH accepts it.
 */
const handSubmit = computed(() => props.status === 'needs_manual')
const current = computed(() => props.history.find(h => h.status === props.status) ?? null)

const open = ref(false)
const target = ref<OutcomeStatus | 'submitted' | null>(null)
const day = ref(localToday())
const note = ref('')
const saving = ref(false)
const today = computed(() => localToday())

function pick(status: OutcomeStatus | 'submitted') {
  target.value = status
  day.value = localToday()
  note.value = ''
  open.value = true
}

const dialogTitle = computed(() => (target.value === 'submitted' ? 'I submitted it' : target.value ? outcomeLabel(target.value) : ''))

async function save() {
  if (!target.value || saving.value) return
  saving.value = true
  try {
    await $fetch(`/api/applications/${props.applicationId}`, {
      method: 'PATCH',
      body: { status: target.value, date: day.value || null, note: note.value.trim() || null },
    })
    snackbar.success(target.value === 'submitted' ? 'Marked submitted by hand' : `Recorded: ${outcomeLabel(target.value)}`)
    open.value = false
    emit('saved', target.value)
  }
  catch (e: any) {
    snackbar.notify(e?.data?.statusMessage || e?.message || 'Could not record that', 'error', { timeout: -1 })
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="sent || handSubmit || history.length" class="oc" :class="{ 'oc--compact': compact }">
    <!-- Compact: one button on a list card -->
    <template v-if="compact">
      <v-btn
        v-if="handSubmit"
        variant="outlined"
        size="small"
        height="36"
        prepend-icon="mdi-check"
        @click="pick('submitted')"
      >
        I submitted it
      </v-btn>
      <v-menu v-else-if="sent" location="bottom end">
        <template #activator="{ props: menu }">
          <v-btn v-bind="menu" variant="outlined" size="small" height="36" append-icon="mdi-menu-down" :aria-label="`Record what the employer did${title ? ` for ${title}` : ''}`">
            Record outcome
          </v-btn>
        </template>
        <v-list density="compact" nav>
          <v-list-item
            v-for="o in OUTCOMES"
            :key="o.status"
            :prepend-icon="o.icon"
            :title="o.label"
            :active="o.status === status"
            @click="pick(o.status)"
          />
        </v-list>
      </v-menu>
    </template>

    <!-- Full: the application page -->
    <template v-else>
      <div v-if="handSubmit" class="oc__hand">
        <p class="oc__text">
          This one is yours to submit by hand on the employer's site. Once you have, record it so it counts as
          sent and can take what the employer does next.
        </p>
        <v-btn color="primary" height="44" prepend-icon="mdi-check" @click="pick('submitted')">I submitted it</v-btn>
      </div>

      <template v-else-if="sent">
        <div class="oc__current">
          <span class="oc__label">Now</span>
          <ApplicationsStatusTag :status="status" />
          <span v-if="status === 'submitted'" class="oc__since">waiting to hear back</span>
          <span v-else-if="current" class="oc__since">since {{ formatDay(current.date) }}</span>
        </div>
        <div class="oc__label oc__label--block">What did the employer do?</div>
        <div class="oc__options" role="group" aria-label="Record what the employer did">
          <v-btn
            v-for="o in OUTCOMES"
            :key="o.status"
            :prepend-icon="o.icon"
            :color="o.status === status ? o.color : undefined"
            :variant="o.status === status ? 'tonal' : 'outlined'"
            height="44"
            @click="pick(o.status)"
          >
            {{ o.label }}
          </v-btn>
        </div>
      </template>

      <p v-if="isSandbox" class="oc__note">Sandbox application. Its outcomes are kept out of the Learning rates.</p>

      <div v-if="history.length" class="oc__history">
        <div class="oc__label oc__label--block">History</div>
        <ol class="oc__list">
          <li v-for="h in history" :key="h.id" class="oc__item">
            <span class="oc__day tabular">{{ formatDay(h.date) }}</span>
            <span class="oc__what">
              <strong>{{ outcomeLabel(h.status) }}</strong>
              <span v-if="h.note" class="oc__item-note">{{ h.note }}</span>
            </span>
          </li>
        </ol>
      </div>
    </template>

    <v-dialog v-model="open" max-width="460" :aria-labelledby="`oc-title-${applicationId}`">
      <v-card class="oc__dialog">
        <v-card-title :id="`oc-title-${applicationId}`" class="oc__dialog-title">{{ dialogTitle }}</v-card-title>
        <v-card-subtitle v-if="title" class="oc__dialog-sub">{{ title }}</v-card-subtitle>
        <v-card-text class="oc__dialog-body">
          <v-text-field
            v-model="day"
            type="date"
            label="Date"
            :max="today"
            :hint="target === 'submitted' ? 'The day you submitted it' : 'The day it happened'"
            persistent-hint
          />
          <v-textarea
            v-model="note"
            label="Note (optional)"
            :placeholder="target === 'submitted' ? 'Anything to remember about the submit' : 'Who wrote, what they said, the next step'"
            rows="2"
            auto-grow
            hide-details
            counter="2000"
          />
          <p v-if="isSandbox" class="oc__note">Sandbox application: recorded for testing, kept out of the Learning rates.</p>
        </v-card-text>
        <v-card-actions class="oc__dialog-actions">
          <v-btn variant="text" height="44" @click="open = false">Cancel</v-btn>
          <v-btn color="primary" variant="flat" height="44" :loading="saving" :disabled="!day" @click="save">Save</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped lang="scss">
.oc {
  display: grid;
  gap: 12px;

  &--compact { display: block; }

  &__hand { display: grid; gap: 10px; justify-items: start; }

  &__text {
    margin: 0;
    font-size: 0.875rem;
    max-width: 620px;
    color: rgba(var(--v-theme-on-surface), 0.86);
  }

  &__current { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }

  &__label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));

    &--block { margin-bottom: -4px; }
  }

  &__since { font-size: 0.875rem; color: rgba(var(--v-theme-on-surface), 0.86); }

  &__options { display: flex; flex-wrap: wrap; gap: 8px; }

  &__note {
    margin: 0;
    font-size: 0.8125rem;
    color: rgb(var(--v-theme-info));
  }

  &__history { display: grid; gap: 8px; }

  &__list {
    list-style: none;
    margin: 0;
    padding: 0;
    border-radius: 8px;
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__item {
    display: grid;
    grid-template-columns: 96px 1fr;
    gap: 12px;
    padding: 10px 12px;
    font-size: 0.875rem;

    & + & { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
  }

  &__day { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
  &__what { display: grid; gap: 2px; min-width: 0; }

  &__item-note {
    white-space: pre-line;
    overflow-wrap: anywhere;
    color: rgba(var(--v-theme-on-surface), 0.86);
  }

  &__dialog-title { padding: 20px 24px 0; font-size: 1.125rem; font-weight: 650; }
  &__dialog-sub { padding: 2px 24px 0; white-space: normal; }
  &__dialog-body { display: grid; gap: 16px; padding: 16px 24px 8px !important; }
  &__dialog-actions { padding: 8px 16px 16px; justify-content: flex-end; }
}
</style>
