<script setup lang="ts">
// Throwaway employer job posting that links to the sandbox application form.
definePageMeta({ layout: false })
const route = useRoute()
const token = String(route.params.token || '')
const { data: job, error } = await useFetch('/api/sandbox/job', { query: { token } })
if (error.value) throw createError({ statusCode: 404, statusMessage: 'Not found', fatal: true })
useHead({ title: job.value?.title || 'Job' })
</script>

<template>
  <div class="sbxjob">
    <h1>{{ job?.title }}</h1>
    <p class="sbxjob__meta">{{ job?.company }} · {{ job?.location }}</p>
    <pre class="sbxjob__body">{{ job?.description }}</pre>
    <a class="sbxjob__apply" :href="`/sandbox/apply/${token}`">Apply for this job</a>
  </div>
</template>

<style scoped lang="scss">
.sbxjob {
  max-width: 760px; margin: 0 auto; padding: 32px 16px; font-family: system-ui, sans-serif; color: #1d2733; background: #fff; min-height: 100vh;
  &__meta { color: #5b6772; }
  &__body { white-space: pre-wrap; font: inherit; line-height: 1.55; }
  &__apply { display: inline-block; background: #0b6bcb; color: #fff; padding: 12px 22px; border-radius: 4px; text-decoration: none; }
}
</style>
