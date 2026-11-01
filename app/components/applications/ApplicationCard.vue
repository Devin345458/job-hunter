<script setup lang="ts">
import type { ApplicationWithJob } from '~/composables/useApplications'
import { timeAgo } from '~/composables/review/format'

// One application as a list row: company and role, the status tag with the one-line detail of
// what is happening, the match score, and when it last moved. The whole row is the link.
const props = defineProps<{ application: ApplicationWithJob }>()

const when = computed(() => timeAgo(props.application.submittedAt || props.application.updatedAt || props.application.createdAt))
</script>

<template>
  <NuxtLink :to="`/applications/${application.id}`" class="arow">
    <div class="arow__main">
      <div class="arow__company">
        {{ application.job?.company || 'Unknown company' }}
        <span v-if="application.isSandbox" class="arow__sandbox">Sandbox</span>
      </div>
      <div class="arow__title">{{ application.job?.title || 'Unknown role' }}</div>
      <div class="arow__status">
        <ApplicationsStatusTag :status="application.status" />
        <span v-if="application.statusDetail" class="arow__detail">{{ application.statusDetail }}</span>
      </div>
    </div>
    <div class="arow__side">
      <span v-if="application.job?.matchScore != null" class="arow__score tabular" :aria-label="`Match score ${application.job.matchScore}`">{{ application.job.matchScore }}</span>
      <span class="arow__when">{{ when }}</span>
    </div>
  </NuxtLink>
</template>

<style scoped lang="scss">
.arow {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  min-height: 56px;
  padding: 14px 16px;
  color: inherit;
  text-decoration: none;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  transition: background-color 150ms cubic-bezier(0.23, 1, 0.32, 1);

  &:hover { background: rgb(var(--v-theme-surface-bright)); }
  &:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: -2px; }

  &__main { flex: 1; min-width: 0; }

  &__company {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.8125rem;
    font-weight: 600;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__sandbox {
    font-size: 0.6875rem;
    font-weight: 600;
    padding: 0 6px;
    border-radius: 6px;
    color: rgb(var(--v-theme-info));
    border: 1px dashed rgba(var(--v-theme-info), 0.6);
  }

  &__title {
    font-size: 0.9375rem;
    font-weight: 600;
    line-height: 1.35;
    margin: 2px 0 8px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }

  &__status {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  &__detail {
    min-width: 0;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__side {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    flex-shrink: 0;
  }

  &__score {
    font-size: 1.0625rem;
    font-weight: 700;
    min-width: 30px;
    text-align: right;
  }

  &__when {
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    white-space: nowrap;
  }
}

@media (max-width: 599px) {
  .arow__status { flex-wrap: wrap; }
  .arow__detail { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
}

@media (prefers-reduced-motion: reduce) {
  .arow { transition: none; }
}
</style>
