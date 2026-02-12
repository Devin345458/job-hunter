<script setup lang="ts">
export interface ResumeSection {
  summary?: string
  experience?: {
    title: string
    company: string
    dates: string
    highlights: string[]
  }[]
  skills?: string[]
  education?: {
    degree: string
    school: string
    year: string
  }[]
  [key: string]: any
}

const props = defineProps<{
  resumeJson: ResumeSection | string | null
  jobDescription: string
}>()

const parsedResume = computed<ResumeSection | null>(() => {
  if (!props.resumeJson) return null
  if (typeof props.resumeJson === 'string') {
    try {
      return JSON.parse(props.resumeJson)
    }
    catch {
      return null
    }
  }
  return props.resumeJson
})

const keywords = computed(() => {
  if (!props.jobDescription) return []

  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'this', 'that', 'these',
    'those', 'we', 'you', 'they', 'it', 'its', 'our', 'your', 'their',
    'as', 'from', 'about', 'into', 'through', 'during', 'before', 'after',
    'above', 'below', 'between', 'all', 'each', 'every', 'both', 'few',
    'more', 'most', 'other', 'some', 'such', 'no', 'not', 'only', 'own',
    'same', 'than', 'too', 'very', 'just', 'also',
  ])

  const words = props.jobDescription
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))

  const freq = new Map<string, number>()
  for (const w of words) {
    freq.set(w, (freq.get(w) || 0) + 1)
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([word]) => word)
})

function highlightText(text: string): string {
  if (!keywords.value.length || !text) return text

  const escaped = keywords.value.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const regex = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi')
  return text.replace(regex, '<mark class="keyword-highlight">$1</mark>')
}
</script>

<template>
  <v-row v-if="parsedResume">
    <!-- Job Description Keywords -->
    <v-col cols="12" md="5">
      <v-card variant="outlined" class="h-100">
        <v-card-title class="text-subtitle-1">
          <v-icon icon="mdi-file-document-outline" class="mr-2" />
          Job Description Highlights
        </v-card-title>
        <v-card-text>
          <div v-if="keywords.length" class="mb-4">
            <div class="text-caption text-medium-emphasis mb-2">Key Terms</div>
            <div class="d-flex flex-wrap ga-1">
              <v-chip
                v-for="kw in keywords"
                :key="kw"
                size="small"
                variant="tonal"
                color="primary"
              >
                {{ kw }}
              </v-chip>
            </div>
          </div>

          <div class="job-description text-body-2" style="max-height: 500px; overflow-y: auto;">
            {{ jobDescription }}
          </div>
        </v-card-text>
      </v-card>
    </v-col>

    <!-- Tailored Resume -->
    <v-col cols="12" md="7">
      <v-card variant="outlined" class="h-100">
        <v-card-title class="text-subtitle-1">
          <v-icon icon="mdi-file-account-outline" class="mr-2" />
          Tailored Resume
        </v-card-title>
        <v-card-text>
          <!-- Summary -->
          <div v-if="parsedResume.summary" class="mb-4">
            <div class="text-overline text-medium-emphasis">Summary</div>
            <!-- eslint-disable-next-line vue/no-v-html -->
            <p class="text-body-2" v-html="highlightText(parsedResume.summary)" />
          </div>

          <!-- Experience -->
          <div v-if="parsedResume.experience?.length" class="mb-4">
            <div class="text-overline text-medium-emphasis">Experience</div>
            <div
              v-for="(exp, i) in parsedResume.experience"
              :key="i"
              class="mb-3"
            >
              <div class="font-weight-medium">{{ exp.title }}</div>
              <div class="text-caption text-medium-emphasis">
                {{ exp.company }} | {{ exp.dates }}
              </div>
              <ul class="text-body-2 mt-1 ml-4">
                <li
                  v-for="(highlight, j) in exp.highlights"
                  :key="j"
                  class="mb-1"
                >
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <span v-html="highlightText(highlight)" />
                </li>
              </ul>
            </div>
          </div>

          <!-- Skills -->
          <div v-if="parsedResume.skills?.length" class="mb-4">
            <div class="text-overline text-medium-emphasis">Skills</div>
            <div class="d-flex flex-wrap ga-1">
              <v-chip
                v-for="skill in parsedResume.skills"
                :key="skill"
                size="small"
                :variant="keywords.some(k => skill.toLowerCase().includes(k)) ? 'flat' : 'outlined'"
                :color="keywords.some(k => skill.toLowerCase().includes(k)) ? 'success' : undefined"
              >
                {{ skill }}
              </v-chip>
            </div>
          </div>

          <!-- Education -->
          <div v-if="parsedResume.education?.length">
            <div class="text-overline text-medium-emphasis">Education</div>
            <div
              v-for="(edu, i) in parsedResume.education"
              :key="i"
              class="mb-2"
            >
              <div class="font-weight-medium">{{ edu.degree }}</div>
              <div class="text-caption text-medium-emphasis">
                {{ edu.school }} | {{ edu.year }}
              </div>
            </div>
          </div>
        </v-card-text>
      </v-card>
    </v-col>
  </v-row>

  <v-alert
    v-else
    type="info"
    variant="tonal"
    icon="mdi-file-outline"
  >
    No tailored resume data available yet. Generate one from the application page.
  </v-alert>
</template>

<style scoped lang="scss">
:deep(.keyword-highlight) {
  background-color: rgba(var(--v-theme-primary), 0.2);
  padding: 1px 3px;
  border-radius: 3px;
  font-weight: 500;
}
</style>
