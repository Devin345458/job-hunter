<script setup lang="ts">
// The confirm before a demo is discarded. Shared by the demo detail page and the demos list card,
// so both ask the same question and say the same thing about what happens.
defineProps<{ modelValue: boolean; loading?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [open: boolean]; 'confirm': [] }>()
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="440" @update:model-value="v => emit('update:modelValue', v)">
    <v-card>
      <v-card-title class="text-h6 pt-5 px-5">
        Discard this demo?
      </v-card-title>
      <v-card-text class="text-body-2 px-5">
        It comes off the tailored resume for this application and is never published. The files stay on the server.
      </v-card-text>
      <v-card-actions class="px-5 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">
          Keep it
        </v-btn>
        <v-btn color="error" variant="tonal" :loading="loading" @click="emit('confirm')">
          Discard
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
