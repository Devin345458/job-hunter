<script setup lang="ts">
import { REJECT_REASONS, type RejectReasonCode, type RejectSkillOption, type RejectSkillsMode } from '#shared/types/pipeline'

// Quick reason picker for reject. One tap picks the reason, one tap confirms. "Other" needs
// a note; every other reason takes an optional one. The reason trains the learning rules.
// "Wrong tech stack" can also name the skills at fault: then only those skills are learned
// from, and "I don't have these" saves each one to the knowledge base as a No.
const props = withDefaults(defineProps<{
  modelValue: boolean
  title: string
  company: string
  busy: boolean
  error: string | null
  skillOptions?: RejectSkillOption[]
  /** Sandbox cards only make sandbox rules; the knowledge base is never changed from them. */
  isSandbox?: boolean
}>(), { skillOptions: () => [], isSandbox: false })

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'confirm': [reasonCode: RejectReasonCode, reasonText: string | null, skills: string[], skillsMode: RejectSkillsMode]
}>()

const reason = ref<RejectReasonCode | null>(null)
const note = ref('')
const skills = ref<string[]>([])
const skillsMode = ref<RejectSkillsMode>('lack')
/** A mode picked by hand stays; until then the mode follows the picked chips. */
const modeTouched = ref(false)

watch(() => props.modelValue, (open) => {
  if (open) {
    reason.value = null
    note.value = ''
    skills.value = []
    skillsMode.value = 'lack'
    modeTouched.value = false
  }
})

/**
 * Picked chips that are all under "In your knowledge base" default to "I have them but don't
 * want to work with them"; any other pick keeps "I don't have these".
 */
watch(skills, (picked) => {
  if (modeTouched.value || picked.length === 0) return
  const allHave = picked.every(label => props.skillOptions.find(o => o.label === label)?.status === 'have')
  skillsMode.value = allHave ? 'avoid' : 'lack'
})

function pickMode(mode: RejectSkillsMode) {
  skillsMode.value = mode
  modeTouched.value = true
}

const SKILL_GROUPS = [
  { key: 'missing', label: 'Not in your knowledge base', statuses: ['lack', 'unknown'] },
  { key: 'partial', label: 'Partly in your knowledge base', statuses: ['partial'] },
  { key: 'have', label: 'In your knowledge base', statuses: ['have'] },
] as const

const skillGroups = computed(() => SKILL_GROUPS
  .map(g => ({ ...g, options: props.skillOptions.filter(o => (g.statuses as readonly string[]).includes(o.status)) }))
  .filter(g => g.options.length > 0))

const MODES: Array<{ value: RejectSkillsMode; label: string }> = [
  { value: 'lack', label: 'I don\'t have these' },
  { value: 'avoid', label: 'I have them but don\'t want to work with them' },
]

const showSkills = computed(() => reason.value === 'wrong_stack' && props.skillOptions.length > 0)
const pickedSkills = computed(() => showSkills.value ? skills.value : [])

/** Picked skills the knowledge base says Devin has: a No for them changes what gets claimed. */
const pickedHave = computed(() => skillsMode.value === 'lack'
  ? props.skillOptions.filter(o => o.status === 'have' && pickedSkills.value.includes(o.label)).map(o => o.label)
  : [])

function listText(xs: string[]) {
  if (xs.length <= 1) return xs.join('')
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`
  return `${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}`
}

function toggleSkill(label: string) {
  skills.value = skills.value.includes(label) ? skills.value.filter(s => s !== label) : [...skills.value, label]
}

const noteRequired = computed(() => reason.value === 'other')
const canConfirm = computed(() => !!reason.value && (!noteRequired.value || note.value.trim().length > 0) && !props.busy)

function confirm() {
  if (!canConfirm.value || !reason.value) return
  emit('confirm', reason.value, note.value.trim() || null, [...pickedSkills.value], skillsMode.value)
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

        <section v-if="showSkills" class="rj__skills" aria-labelledby="rj-skills-title">
          <h3 id="rj-skills-title" class="rj__skills-title">Which skills are the problem?</h3>
          <p class="rj__hint">
            Optional. With none picked, the rejection counts a little against every skill this job asks for that you lack.
          </p>

          <div v-for="g in skillGroups" :key="g.key" class="rj__group">
            <p :id="`rj-group-${g.key}`" class="rj__group-label">{{ g.label }}</p>
            <div class="rj__chips" role="group" :aria-labelledby="`rj-group-${g.key}`">
              <button
                v-for="o in g.options"
                :key="o.label"
                type="button"
                class="rj__chip"
                :class="{ 'rj__chip--on': skills.includes(o.label) }"
                :aria-pressed="skills.includes(o.label)"
                :title="o.requirement"
                @click="toggleSkill(o.label)"
              >
                <v-icon :icon="skills.includes(o.label) ? 'mdi-checkbox-marked' : 'mdi-checkbox-blank-outline'" size="18" />
                <span>{{ o.label }}</span>
              </button>
            </div>
          </div>

          <template v-if="skills.length > 0">
            <div class="rj__modes" role="radiogroup" aria-label="About these skills">
              <button
                v-for="m in MODES"
                :key="m.value"
                type="button"
                role="radio"
                class="rj__reason"
                :class="{ 'rj__reason--on': skillsMode === m.value }"
                :aria-checked="skillsMode === m.value"
                @click="pickMode(m.value)"
              >
                <v-icon :icon="skillsMode === m.value ? 'mdi-radiobox-marked' : 'mdi-radiobox-blank'" size="18" />
                <span>{{ m.label }}</span>
              </button>
            </div>
            <p class="rj__hint">
              <template v-if="isSandbox">
                Sandbox card: this only makes sandbox rules. Your knowledge base is not changed.
              </template>
              <template v-else-if="skillsMode === 'lack'">
                Each one not already on your record is saved to your knowledge base as a No, so no resume, letter, or form claims it. Jobs that ask for them score lower.
              </template>
              <template v-else>
                Your knowledge base stays as it is. Jobs that ask for them score lower.
              </template>
            </p>
            <p v-if="pickedHave.length && !isSandbox" class="rj__warn" role="status">
              <v-icon icon="mdi-information-outline" size="16" />
              <span>{{ listText(pickedHave) }} {{ pickedHave.length === 1 ? 'is' : 'are' }} on your record, so {{ pickedHave.length === 1 ? 'it stays' : 'they stay' }}. This only lowers jobs that ask for {{ pickedHave.length === 1 ? 'it' : 'them' }}. To remove a skill, edit it on the Knowledge base page.</span>
            </p>
          </template>
        </section>

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

  &__skills {
    margin: -2px 0 16px;
    padding: 14px 14px 12px;
    border-radius: 8px;
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    background: rgb(var(--v-theme-background));
  }

  &__skills-title {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
  }

  &__hint {
    margin: 4px 0 0;
    font-size: 0.8125rem;
    line-height: 1.4;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__group {
    margin-top: 12px;
  }

  &__group-label {
    margin: 0 0 6px;
    font-size: 0.75rem;
    font-weight: 600;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  &__chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    min-height: 44px;
    padding: 6px 12px 6px 10px;
    border-radius: 6px;
    text-align: left;
    font-size: 0.875rem;
    line-height: 1.3;
    color: inherit;
    overflow-wrap: anywhere;
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

  &__modes {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
    margin-top: 14px;
  }

  &__warn {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 8px 0 0;
    font-size: 0.8125rem;
    line-height: 1.4;
    color: rgb(var(--v-theme-warning));

    .v-icon {
      flex-shrink: 0;
      margin-top: 1px;
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

  .rj__skills {
    padding: 12px 10px 10px;
  }

  .rj__modes {
    grid-template-columns: 1fr;
  }
}
</style>
