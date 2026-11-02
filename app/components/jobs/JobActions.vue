<script setup lang="ts">
// The job detail page's two actions. The page renders this twice: under the header on a phone,
// in the right column on desktop, so the buttons are never thousands of pixels down a phone page.
defineProps<{
  applicationId: number | null
  generating: boolean
  applied: boolean
  resumeError: string | null
}>()

const emit = defineEmits<{
  generate: []
  markReady: []
  dismissError: []
}>()
</script>

<template>
  <v-card variant="outlined">
    <v-card-item>
      <v-card-title class="text-subtitle-1 font-weight-medium">
        Actions
      </v-card-title>
    </v-card-item>
    <v-card-text class="d-flex flex-column ga-3">
      <div>
        <v-btn
          color="primary"
          block
          prepend-icon="mdi-file-document-edit-outline"
          :loading="generating"
          :disabled="!!applicationId"
          @click="emit('generate')"
        >
          {{ applicationId ? 'Resume Generated' : 'Generate Tailored Resume' }}
        </v-btn>
        <div class="text-caption text-medium-emphasis mt-1 px-1">
          Uses AI to customize your resume for this specific role based on your knowledge base.
        </div>
      </div>

      <v-btn
        color="success"
        variant="tonal"
        block
        prepend-icon="mdi-check-circle-outline"
        :disabled="applied"
        @click="emit('markReady')"
      >
        {{ applied ? 'Already Applied' : 'Mark Ready to Apply' }}
      </v-btn>

      <v-alert
        v-if="resumeError"
        type="error"
        variant="tonal"
        density="compact"
        closable
        class="mt-1"
        @click:close="emit('dismissError')"
      >
        <div class="text-caption">{{ resumeError }}</div>
        <div class="text-caption text-medium-emphasis mt-1">
          This usually means the AI response couldn't be parsed. Try again or check that your Anthropic API key is configured in Settings.
        </div>
      </v-alert>
    </v-card-text>
  </v-card>
</template>
