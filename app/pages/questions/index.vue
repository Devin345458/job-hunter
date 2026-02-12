<script setup lang="ts">
definePageMeta({
  layout: 'default',
})

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
    // Questions API may not be ready yet
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
  }
  catch {
    // Handle error silently for now
  }
}

async function skipQuestion(question: Question) {
  try {
    await $fetch(`/api/questions/${question.id}`, {
      method: 'PATCH',
      body: { status: 'skipped' },
    })

    pendingQuestions.value = pendingQuestions.value.filter(q => q.id !== question.id)
  }
  catch {
    // Handle error silently for now
  }
}

onMounted(() => {
  fetchQuestions()
})
</script>

<template>
  <div>
    <div class="d-flex align-center justify-space-between mb-6">
      <h1 class="text-h4 font-weight-bold">Daily Questions</h1>
      <v-chip variant="tonal" color="primary">
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
              <v-icon icon="mdi-chat-question" />
            </v-avatar>
          </template>
          <v-card-title class="text-subtitle-1">
            {{ question.question }}
          </v-card-title>
          <v-card-subtitle v-if="question.context">
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
            rows="3"
            auto-grow
            hide-details
          />
        </v-card-text>

        <v-card-actions class="px-4 pb-4">
          <v-spacer />
          <v-btn
            variant="text"
            color="error"
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
      <v-icon icon="mdi-check-circle-outline" size="64" color="success" class="mb-4" />
      <h3 class="text-h6 mb-2">No Pending Questions</h3>
      <p class="text-body-2 text-medium-emphasis">
        Questions will appear when the AI identifies gaps in your profile.
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
          Answered Questions ({{ answeredQuestions.length }})
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
                <v-avatar color="success" variant="tonal" size="36">
                  <v-icon icon="mdi-check" size="small" />
                </v-avatar>
              </template>
              <v-card-title class="text-body-1">
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
