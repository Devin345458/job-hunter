<script setup lang="ts">
import type { KnowledgeEntry, KnowledgeCategory, KnowledgeSource, KnowledgeEntryInput } from '~/composables/useKnowledge'

const props = withDefaults(defineProps<{
  entry?: KnowledgeEntry | null
  dialog?: boolean
}>(), {
  entry: null,
  dialog: false,
})

const emit = defineEmits<{
  save: [data: KnowledgeEntryInput & { id?: number }]
  cancel: []
}>()

const categoryOptions: { title: string; value: KnowledgeCategory }[] = [
  { title: 'Profile', value: 'profile' },
  { title: 'Experience', value: 'experience' },
  { title: 'Skill', value: 'skill' },
  { title: 'Preference', value: 'preference' },
  { title: 'Project', value: 'project' },
  { title: 'Education', value: 'education' },
  { title: 'Personal', value: 'personal' },
]

const sourceOptions: { title: string; value: KnowledgeSource }[] = [
  { title: 'Resume', value: 'resume' },
  { title: 'User Answer', value: 'user_answer' },
  { title: 'Inferred', value: 'inferred' },
]

const form = reactive({
  category: (props.entry?.category as KnowledgeCategory) || 'skill',
  key: props.entry?.key || '',
  value: props.entry?.value || '',
  source: (props.entry?.source as KnowledgeSource) || 'user_answer',
})

const isEditing = computed(() => !!props.entry?.id)
const formTitle = computed(() => isEditing.value ? 'Edit Entry' : 'New Entry')

const isValid = computed(() =>
  form.category && form.key.trim() && form.value.trim() && form.source,
)

watch(() => props.entry, (newEntry) => {
  if (newEntry) {
    form.category = (newEntry.category as KnowledgeCategory) || 'skill'
    form.key = newEntry.key || ''
    form.value = newEntry.value || ''
    form.source = (newEntry.source as KnowledgeSource) || 'user_answer'
  }
  else {
    form.category = 'skill'
    form.key = ''
    form.value = ''
    form.source = 'user_answer'
  }
}, { immediate: true })

function handleSave() {
  if (!isValid.value) return

  emit('save', {
    ...(props.entry?.id ? { id: props.entry.id } : {}),
    category: form.category,
    key: form.key.trim(),
    value: form.value.trim(),
    source: form.source,
  })
}

function handleCancel() {
  emit('cancel')
}
</script>

<template>
  <v-dialog
    v-if="dialog"
    max-width="600"
    :model-value="true"
    persistent
    @update:model-value="handleCancel"
  >
    <v-card>
      <v-card-title>{{ formTitle }}</v-card-title>
      <v-card-text>
        <v-row>
          <v-col cols="12" sm="6">
            <v-select
              v-model="form.category"
              :items="categoryOptions"
              label="Category"
            />
          </v-col>
          <v-col cols="12" sm="6">
            <v-select
              v-model="form.source"
              :items="sourceOptions"
              label="Source"
            />
          </v-col>
          <v-col cols="12">
            <v-text-field
              v-model="form.key"
              label="Key"
              placeholder="e.g., Years of experience, Preferred stack"
            />
          </v-col>
          <v-col cols="12">
            <v-textarea
              v-model="form.value"
              label="Value"
              rows="4"
              placeholder="The knowledge value..."
            />
          </v-col>
        </v-row>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="handleCancel">
          Cancel
        </v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :disabled="!isValid"
          @click="handleSave"
        >
          Save
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-card v-else variant="outlined">
    <v-card-title>{{ formTitle }}</v-card-title>
    <v-card-text>
      <v-row>
        <v-col cols="12" sm="6">
          <v-select
            v-model="form.category"
            :items="categoryOptions"
            label="Category"
          />
        </v-col>
        <v-col cols="12" sm="6">
          <v-select
            v-model="form.source"
            :items="sourceOptions"
            label="Source"
          />
        </v-col>
        <v-col cols="12">
          <v-text-field
            v-model="form.key"
            label="Key"
            placeholder="e.g., Years of experience, Preferred stack"
          />
        </v-col>
        <v-col cols="12">
          <v-textarea
            v-model="form.value"
            label="Value"
            rows="4"
            placeholder="The knowledge value..."
          />
        </v-col>
      </v-row>
    </v-card-text>
    <v-card-actions>
      <v-spacer />
      <v-btn variant="text" @click="handleCancel">
        Cancel
      </v-btn>
      <v-btn
        color="primary"
        variant="flat"
        :disabled="!isValid"
        @click="handleSave"
      >
        Save
      </v-btn>
    </v-card-actions>
  </v-card>
</template>
