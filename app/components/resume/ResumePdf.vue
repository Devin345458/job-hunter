<script setup lang="ts">
const props = defineProps<{
  applicationId: number
}>()

const pdfUrl = computed(() => `/api/resume/pdf/${props.applicationId}`)
const loadError = ref(false)
const loading = ref(true)

function onIframeLoad() {
  loading.value = false
}

function onIframeError() {
  loading.value = false
  loadError.value = true
}

function downloadPdf() {
  const link = document.createElement('a')
  link.href = pdfUrl.value
  link.download = `resume-${props.applicationId}.pdf`
  link.click()
}

onMounted(async () => {
  try {
    const response = await $fetch.raw(pdfUrl.value, { method: 'HEAD' })
    if (!response.ok) {
      loadError.value = true
      loading.value = false
    }
  }
  catch {
    loadError.value = true
    loading.value = false
  }
})
</script>

<template>
  <v-card variant="outlined">
    <v-card-title class="d-flex align-center">
      <v-icon icon="mdi-file-pdf-box" class="mr-2" />
      Resume PDF

      <v-spacer />

      <v-btn
        v-if="!loadError"
        variant="tonal"
        color="primary"
        prepend-icon="mdi-download"
        size="small"
        @click="downloadPdf"
      >
        Download
      </v-btn>
    </v-card-title>

    <v-card-text>
      <div v-if="loading && !loadError" class="d-flex justify-center align-center py-8">
        <v-progress-circular indeterminate color="primary" />
      </div>

      <iframe
        v-if="!loadError"
        v-show="!loading"
        :src="pdfUrl"
        class="pdf-iframe"
        @load="onIframeLoad"
        @error="onIframeError"
      />

      <v-alert
        v-if="loadError"
        type="info"
        variant="tonal"
        icon="mdi-file-pdf-box"
      >
        No PDF available for this application yet. Generate a tailored resume first, then export to PDF.
      </v-alert>
    </v-card-text>
  </v-card>
</template>

<style scoped lang="scss">
.pdf-iframe {
  width: 100%;
  height: 700px;
  border: none;
  border-radius: 8px;
  background: rgb(var(--v-theme-surface));
}
</style>
