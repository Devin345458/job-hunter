<script setup lang="ts">
import type { InferSelectModel } from 'drizzle-orm'
import type { questions } from '~~/server/db/schema'

type Question = InferSelectModel<typeof questions>

const props = defineProps<{
  question: Question
}>()

const emit = defineEmits<{
  answer: [payload: { id: number; answer: string }]
  skip: [id: number]
}>()

const answerText = ref(props.question.answer || '')
const saving = ref(false)

watch(() => props.question, (q) => {
  answerText.value = q.answer || ''
}, { immediate: true })

function handleAnswer() {
  if (!answerText.value.trim()) return
  saving.value = true
  emit('answer', { id: props.question.id, answer: answerText.value.trim() })
}

function handleSkip() {
  emit('skip', props.question.id)
}

const isAnswered = computed(() => props.question.status === 'answered')
const isSkipped = computed(() => props.question.status === 'skipped')
</script>

<template>
  <v-card variant="outlined" :class="{ 'border-opacity-50': isSkipped }">
    <v-card-item>
      <v-card-title class="text-body-1 font-weight-medium">
        {{ question.question }}
      </v-card-title>

      <template #append>
        <v-chip
          v-if="question.category"
          size="x-small"
          variant="tonal"
          color="secondary"
        >
          {{ question.category }}
        </v-chip>
      </template>
    </v-card-item>

    <v-card-text>
      <p
        v-if="question.context"
        class="text-caption text-medium-emphasis mb-3"
      >
        {{ question.context }}
      </p>

      <v-textarea
        v-model="answerText"
        label="Your answer"
        rows="3"
        :disabled="isAnswered || isSkipped"
        hide-details
      />
    </v-card-text>

    <v-card-actions>
      <v-chip
        v-if="isAnswered"
        color="success"
        size="small"
        variant="tonal"
        prepend-icon="mdi-check"
      >
        Answered
      </v-chip>
      <v-chip
        v-else-if="isSkipped"
        color="grey"
        size="small"
        variant="tonal"
        prepend-icon="mdi-skip-next"
      >
        Skipped
      </v-chip>

      <v-spacer />

      <template v-if="!isAnswered && !isSkipped">
        <v-btn
          variant="text"
          @click="handleSkip"
        >
          Skip
        </v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :disabled="!answerText.trim()"
          :loading="saving"
          @click="handleAnswer"
        >
          Save Answer
        </v-btn>
      </template>
    </v-card-actions>
  </v-card>
</template>
