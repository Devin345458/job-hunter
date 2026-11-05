<script setup lang="ts">
import type { SkillCatalogItem } from '~~/server/utils/skill-catalog'
import { countText } from '#shared/utils/pay-format'

// The skills employers ask about (the skill catalog), each with a Core switch. The flag belongs to
// the catalog skill, not to a knowledge base entry: most skills have no entry yet, and some
// entries (Laravel, Vue) come from the resume rather than from a question.

const props = defineProps<{ search?: string }>()

/** Rows shown before "Show all": core skills come first, then the most asked. */
const PAGE = 12

const items = ref<SkillCatalogItem[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)
const showAll = ref(false)
const saving = reactive<Record<string, boolean>>({})
const rowError = reactive<Record<string, string>>({})

async function load() {
  loading.value = true
  loadError.value = null
  try {
    items.value = await $fetch<SkillCatalogItem[]>('/api/knowledge/skills')
  }
  catch (e: any) {
    loadError.value = e?.data?.statusMessage || e?.message || 'The skills could not be loaded.'
  }
  finally {
    loading.value = false
  }
}

const matching = computed(() => {
  const q = (props.search ?? '').trim().toLowerCase()
  return q ? items.value.filter(s => s.name.toLowerCase().includes(q) || s.question.toLowerCase().includes(q)) : items.value
})
const visible = computed(() => (showAll.value || props.search?.trim() ? matching.value : matching.value.slice(0, PAGE)))
const coreCount = computed(() => items.value.filter(s => s.core).length)

async function toggle(skill: SkillCatalogItem, core: boolean | null) {
  const next = !!core
  const before = skill.core
  skill.core = next
  saving[skill.slug] = true
  delete rowError[skill.slug]
  try {
    await $fetch(`/api/knowledge/skills/${encodeURIComponent(skill.slug)}`, { method: 'PATCH', body: { core: next } })
  }
  catch (e: any) {
    skill.core = before
    rowError[skill.slug] = e?.data?.statusMessage || 'Not saved. Try again.'
    setTimeout(() => delete rowError[skill.slug], 6000)
  }
  finally {
    saving[skill.slug] = false
  }
}

onMounted(load)
</script>

<template>
  <section class="skill-catalog" aria-labelledby="kb-skill-catalog">
    <div class="skill-catalog__head">
      <h2 id="kb-skill-catalog" class="skill-catalog__h">
        Skills employers ask about
        <span v-if="items.length" class="skill-catalog__n">{{ countText(items.length) }}, {{ countText(coreCount) }} core</span>
      </h2>
      <p class="skill-catalog__note">
        Drafts will give a core skill a full answer, and every other skill 2 or 3 sentences.
      </p>
    </div>

    <div v-if="loading" class="skill-catalog__rows" aria-busy="true">
      <v-skeleton-loader v-for="n in 3" :key="n" type="list-item-two-line" class="skill-catalog__skeleton" />
    </div>

    <v-alert v-else-if="loadError" type="error" variant="tonal" density="compact" class="skill-catalog__error">
      {{ loadError }}
      <template #append>
        <v-btn variant="text" size="small" @click="load">Try again</v-btn>
      </template>
    </v-alert>

    <p v-else-if="!items.length" class="skill-catalog__empty">
      No skills yet. The catalog is built from your questions at the next learning run.
    </p>

    <template v-else>
      <p v-if="!matching.length" class="skill-catalog__empty">No skill matches "{{ props.search }}".</p>
      <ul v-else class="skill-catalog__rows">
        <li v-for="s in visible" :key="s.slug" class="skill-row">
          <div class="skill-row__text">
            <span class="skill-row__name">{{ s.name }}</span>
            <span class="skill-row__question">{{ s.question }}</span>
            <span v-if="rowError[s.slug]" class="skill-row__error text-error" role="alert">{{ rowError[s.slug] }}</span>
          </div>
          <v-switch
            :model-value="s.core"
            color="success"
            hide-details
            inset
            density="compact"
            label="Core"
            class="skill-row__switch"
            :loading="saving[s.slug] ? 'success' : false"
            :disabled="!!saving[s.slug]"
            :aria-label="`${s.name} is a core skill`"
            @update:model-value="toggle(s, $event)"
          />
        </li>
      </ul>
      <v-btn
        v-if="!props.search?.trim() && matching.length > PAGE"
        variant="text"
        height="44"
        class="skill-catalog__more"
        @click="showAll = !showAll"
      >
        {{ showAll ? 'Show fewer' : `Show all ${countText(matching.length)} skills` }}
      </v-btn>
    </template>
  </section>
</template>

<style scoped lang="scss">
.skill-catalog {
  margin-bottom: 28px;

  &__head {
    margin-bottom: 8px;
  }

  &__h {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }

  &__n {
    margin-left: 6px;
    font-weight: 400;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__note {
    margin: 2px 0 0;
    font-size: 0.875rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__rows {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    border-radius: 16px;
    background: rgb(var(--v-theme-surface));
  }

  &__skeleton {
    background: transparent;
  }

  &__empty {
    margin: 0;
    padding: 14px 16px;
    border-radius: 16px;
    font-size: 0.875rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    background: rgb(var(--v-theme-surface));
  }

  &__more {
    margin-top: 4px;
  }
}

// One skill: its name over its generic question, the Core switch at the right.
.skill-row {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 56px;
  padding: 8px 16px;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

  &:first-child {
    border-top: 0;
  }

  &__text {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  &__name {
    font-size: 0.875rem;
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  &__question {
    font-size: 0.8125rem;
    line-height: 1.45;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__error {
    font-size: 0.8125rem;
  }

  // The switch keeps its size and its label stays one word on a phone; the text column shrinks instead.
  &__switch {
    flex: none;
    // Vuetify's input box measures narrower than the switch and its label; without this the
    // control spills past the card on a phone.
    min-width: max-content;
    min-height: 44px;

    :deep(.v-label) {
      white-space: nowrap;
      overflow-wrap: normal;
      word-break: normal;
    }
  }
}
</style>
