<script setup lang="ts">
import { REJECT_REASONS, type RejectReasonCode } from '#shared/types/pipeline'

// Quick reason picker for reject. One tap picks the reason, one tap confirms. "Other" needs
// a note; every other reason takes an optional one. The reason trains the learning rules.
const props = defineProps<{
  modelValue: boolean
  title: string
  company: string
  busy: boolean
  error: string | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'confirm': [reasonCode: RejectReasonCode, reasonText: string | null]
}>()

const reason = ref<RejectReasonCode | null>(null)
const note = ref('')

watch(() => props.modelValue, (open) => {
  if (open) {
    reason.value = null
    note.value = ''
  }
})

const noteRequired = computed(() => reason.value === 'other')
const canConfirm = computed(() => !!reason.value && (!noteRequired.value || note.value.trim().length > 0) && !props.busy)

function confirm() {
  if (!canConfirm.value || !reason.value) return
  emit('confirm', reason.value, note.value.trim() || null)
}
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    max-width="540"
    scrollable
    @update:model-value="v => emit('update:modelValue', v)"
  >
    <v-card class="rj">
      <div class="rj__head">
        <div>
          <h2 class="rj__title">Reject this match</h2>
          <p class="rj__sub">{{ title }} at {{ company }}. Nothing is sent. The reason teaches future scores.</p>
        </div>
        <v-btn icon="mdi-close" variant="text" aria-label="Close" @click="emit('update:modelValue', false)" />
      </div>

      <v-card-text class="rj__body">
        <div class="rj__reasons" role="radiogroup" aria-label="Reason">
          <button
            v-for="r in REJECT_REASONS"
            :key="r.code"
            type="button"
            role="radio"
            class="rj__reason"
            :class="{ 'rj__reason--on': reason === r.code }"
            :aria-checked="reason === r.code"
            @click="reason = r.code"
          >
            <v-icon :icon="reason === r.code ? 'mdi-radiobox-marked' : 'mdi-radiobox-blank'" size="18" />
            <span>{{ r.label }}</span>
          </button>
        </div>

        <v-textarea
          v-model="note"
          :label="noteRequired ? 'What is the reason? (required)' : 'Note (optional)'"
          rows="2"
          auto-grow
          max-rows="5"
          maxlength="2000"
          :error="noteRequired && !note.trim() && !!reason"
          hide-details="auto"
          class="rj__note"
        />

        <p v-if="error" class="rj__error" role="alert">{{ error }}</p>
      </v-card-text>

      <div class="rj__actions">
        <v-btn variant="text" height="44" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="error" height="44" min-width="120" :disabled="!canConfirm" :loading="busy" @click="confirm">
          Reject
        </v-btn>
      </div>
    </v-card>
  </v-dialog>
</template>

<style scoped lang="scss">
.rj {
  &__head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    padding: 18px 12px 4px 20px;
  }

  &__title {
    font-size: 1.125rem;
    font-weight: 700;
    margin: 0;
  }

  &__sub {
    margin: 4px 0 0;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__body {
    padding: 12px 20px 8px !important;
  }

  &__reasons {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
    margin-bottom: 14px;
  }

  &__reason {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 8px 10px;
    border-radius: 6px;
    text-align: left;
    font-size: 0.875rem;
    line-height: 1.3;
    color: inherit;
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    transition: background-color 0.12s cubic-bezier(0.23, 1, 0.32, 1), border-color 0.12s cubic-bezier(0.23, 1, 0.32, 1);

    .v-icon {
      flex-shrink: 0;
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    }

    &:hover {
      background: rgba(var(--v-theme-on-surface), 0.04);
    }

    &--on {
      border-color: rgba(var(--v-theme-error), 0.6);
      background: rgba(var(--v-theme-error), 0.08);

      .v-icon { color: rgb(var(--v-theme-error)); }
    }
  }

  &__error {
    margin: 8px 0 0;
    font-size: 0.8125rem;
    color: rgb(var(--v-theme-error));
  }

  &__actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 8px 20px 18px;
  }
}

@media (max-width: 420px) {
  .rj__reasons {
    grid-template-columns: 1fr 1fr;
  }

  .rj__reason {
    font-size: 0.8125rem;
    padding: 8px;
  }
}
</style>
