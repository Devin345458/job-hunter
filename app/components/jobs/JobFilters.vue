<script setup lang="ts">
import type { JobStatus, RemoteType } from '~/composables/useJobs'

export interface JobFilterValues {
  search: string
  status: JobStatus[]
  remoteType: RemoteType | null
  minScore: number
  maxScore: number
}

const emit = defineEmits<{
  'update:filters': [filters: JobFilterValues]
}>()

const statusOptions: { title: string; value: JobStatus }[] = [
  { title: 'New', value: 'new' },
  { title: 'Reviewed', value: 'reviewed' },
  { title: 'Applied', value: 'applied' },
  { title: 'Rejected', value: 'rejected' },
  { title: 'Expired', value: 'expired' },
]

const remoteOptions: { title: string; value: RemoteType }[] = [
  { title: 'Remote', value: 'remote' },
  { title: 'Hybrid', value: 'hybrid' },
  { title: 'On-site', value: 'onsite' },
]

const search = ref('')
const status = ref<JobStatus[]>([])
const remoteType = ref<RemoteType | null>(null)
const scoreRange = ref<[number, number]>([0, 100])

let debounceTimer: ReturnType<typeof setTimeout> | null = null

function emitFilters() {
  emit('update:filters', {
    search: search.value,
    status: status.value,
    remoteType: remoteType.value,
    minScore: scoreRange.value[0],
    maxScore: scoreRange.value[1],
  })
}

function onSearchInput() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    emitFilters()
  }, 350)
}

function clearFilters() {
  search.value = ''
  status.value = []
  remoteType.value = null
  scoreRange.value = [0, 100]
  emitFilters()
}

watch([status, remoteType, scoreRange], emitFilters, { deep: true })
</script>

<template>
  <v-card variant="outlined">
    <v-card-text>
      <v-row align="center">
        <v-col cols="12" sm="6" md="3">
          <v-text-field
            v-model="search"
            label="Search jobs"
            prepend-inner-icon="mdi-magnify"
            clearable
            hide-details
            @input="onSearchInput"
            @click:clear="search = ''; emitFilters()"
          />
        </v-col>

        <v-col cols="12" sm="6" md="3">
          <v-select
            v-model="status"
            :items="statusOptions"
            label="Status"
            multiple
            clearable
            hide-details
            chips
            closable-chips
          />
        </v-col>

        <v-col cols="12" sm="6" md="2">
          <v-select
            v-model="remoteType"
            :items="remoteOptions"
            label="Work type"
            clearable
            hide-details
          />
        </v-col>

        <v-col cols="12" sm="6" md="3">
          <div class="text-caption text-medium-emphasis mb-1">
            Match score: {{ scoreRange[0] }} - {{ scoreRange[1] }}
          </div>
          <v-range-slider
            v-model="scoreRange"
            :min="0"
            :max="100"
            :step="5"
            hide-details
            thumb-label
            color="primary"
          />
        </v-col>

        <v-col cols="12" sm="auto" class="d-flex align-center">
          <v-btn
            variant="text"
            prepend-icon="mdi-filter-remove"
            @click="clearFilters"
          >
            Clear
          </v-btn>
        </v-col>
      </v-row>
    </v-card-text>
  </v-card>
</template>
