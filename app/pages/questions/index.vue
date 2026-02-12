<script setup lang="ts">
definePageMeta({
  layout: 'default',
})

const snackbar = useSnackbar()

interface Question {
  id: number
  question: string
  context: string | null
  category: string | null
  status: string
  answer: string | null
  askedAt: string
  answeredAt: string | null
}

const pendingQuestions = ref<Question[]>([])
const answeredQuestions = ref<Question[]>([])
const loading = ref(false)
const answers = ref<Record<number, string>>({})
const showAnswered = ref(false)

async function fetchQuestions() {
  loading.value = true
  try {
    const data = await $fetch<{ questions: Question[] }>('/api/questions')
    const all = data.questions || []
    pendingQuestions.value = all.filter(q => q.status === 'pending')
    answeredQuestions.value = all.filter(q => q.status === 'answered')
  }
  catch {
    pendingQuestions.value = []
    answeredQuestions.value = []
  }
  finally {
    loading.value = false
  }
}

async function saveAnswer(question: Question) {
  const answer = answers.value[question.id]
  if (!answer?.trim()) return

  try {
    await $fetch(`/api/questions/${question.id}`, {
      method: 'PATCH',
      body: { answer, status: 'answered' },
    })

    pendingQuestions.value = pendingQuestions.value.filter(q => q.id !== question.id)
    answeredQuestions.value.unshift({
      ...question,
      answer,
      status: 'answered',
      answeredAt: new Date().toISOString(),
    })
    delete answers.value[question.id]
    snackbar.success('Answer saved and added to your knowledge base')
  }
  catch {
    snackbar.error('Failed to save answer. Please try again.')
  }
}

async function skipQuestion(question: Question) {
  try {
    await $fetch(`/api/questions/${question.id}`, {
      method: 'PATCH',
      body: { status: 'skipped' },
    })

    pendingQuestions.value = pendingQuestions.value.filter(q => q.id !== question.id)
    snackbar.info('Question skipped')
  }
  catch {
    snackbar.error('Failed to skip question')
  }
}

onMounted(() => {
  fetchQuestions()
})
</script>

<template>
  <div class="fade-in">
    <!-- Page Header -->
    <div class="d-flex align-center justify-space-between mb-8">
      <div class="page-header">
        <h1 class="text-h4 page-header__title">Daily Questions</h1>
        <p class="text-body-2 page-header__subtitle">
          The AI generates questions to fill gaps in your professional profile. Your answers are stored in the Knowledge Base and improve job matching and resume tailoring accuracy.
        </p>
      </div>
      <v-chip v-if="pendingQuestions.length" variant="tonal" color="warning">
        {{ pendingQuestions.length }} pending
      </v-chip>
    </div>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

    <!-- Pending Questions -->
    <template v-if="pendingQuestions.length">
      <v-card
        v-for="question in pendingQuestions"
        :key="question.id"
        variant="outlined"
        class="mb-4"
      >
        <v-card-item>
          <template #prepend>
            <v-avatar color="warning" variant="tonal" size="40">
              <v-icon icon="mdi-chat-processing-outline" size="20" />
            </v-avatar>
          </template>
          <v-card-title class="text-subtitle-1 font-weight-medium">
            {{ question.question }}
          </v-card-title>
          <v-card-subtitle v-if="question.context" class="text-caption">
            {{ question.context }}
          </v-card-subtitle>
        </v-card-item>

        <v-card-text>
          <v-chip
            v-if="question.category"
            size="small"
            variant="tonal"
            color="secondary"
            class="mb-3"
          >
            {{ question.category }}
          </v-chip>

          <v-textarea
            v-model="answers[question.id]"
            label="Your answer"
            placeholder="Type your answer here..."
            rows="3"
            auto-grow
            hide-details
          />
          <div class="text-caption text-medium-emphasis mt-1 px-1">
            Your answer will be saved to the Knowledge Base and used by the AI for future job matching and resume generation.
          </div>
        </v-card-text>

        <v-card-actions class="px-4 pb-4">
          <v-spacer />
          <v-btn
            variant="text"
            size="small"
            prepend-icon="mdi-skip-next"
            @click="skipQuestion(question)"
          >
            Skip
          </v-btn>
          <v-btn
            color="primary"
            prepend-icon="mdi-check"
            :disabled="!answers[question.id]?.trim()"
            @click="saveAnswer(question)"
          >
            Save Answer
          </v-btn>
        </v-card-actions>
      </v-card>
    </template>

    <!-- Empty State -->
    <v-card
      v-else-if="!loading"
      variant="outlined"
      class="text-center pa-12 mb-6"
    >
      <v-icon icon="mdi-check-circle-outline" size="64" color="success" class="mb-4" style="opacity: 0.6;" />
      <h3 class="text-h6 mb-2">All Caught Up</h3>
      <p class="text-body-2 text-medium-emphasis mb-1" style="max-width: 400px; margin: 0 auto;">
        No pending questions right now.
      </p>
      <p class="text-caption text-medium-emphasis" style="max-width: 400px; margin: 0 auto;">
        New questions are generated when the AI identifies gaps in your profile during job matching. The more jobs you review, the more targeted questions you'll receive.
      </p>
    </v-card>

    <!-- Answered Questions -->
    <template v-if="answeredQuestions.length">
      <v-divider class="my-6" />

      <div
        class="d-flex align-center ga-2 mb-4 cursor-pointer"
        @click="showAnswered = !showAnswered"
      >
        <v-icon
          :icon="showAnswered ? 'mdi-chevron-down' : 'mdi-chevron-right'"
          size="small"
        />
        <span class="text-subtitle-2 text-medium-emphasis">
          Previously Answered ({{ answeredQuestions.length }})
        </span>
      </div>

      <v-expand-transition>
        <div v-show="showAnswered">
          <v-card
            v-for="question in answeredQuestions"
            :key="question.id"
            variant="outlined"
            class="mb-3"
          >
            <v-card-item>
              <template #prepend>
                <v-avatar color="success" variant="tonal" size="32">
                  <v-icon icon="mdi-check" size="16" />
                </v-avatar>
              </template>
              <v-card-title class="text-body-2 font-weight-medium">
                {{ question.question }}
              </v-card-title>
            </v-card-item>
            <v-card-text class="pt-0">
              <div class="text-body-2 bg-surface-variant pa-3 rounded-lg">
                {{ question.answer }}
              </div>
            </v-card-text>
          </v-card>
        </div>
      </v-expand-transition>
    </template>
  </div>
</template>

<style scoped lang="scss">
.cursor-pointer {
  cursor: pointer;
}
</style>
