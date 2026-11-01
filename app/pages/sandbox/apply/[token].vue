<script setup lang="ts">
// Throwaway employer application form. Plain HTML and a native multipart POST, shaped like
// a typical ATS form, so the form engine meets the same kinds of controls it meets on real
// employer sites. Nothing here reaches a real company.
definePageMeta({ layout: false })

const route = useRoute()
const token = String(route.params.token || '')
const { data: job, error } = await useFetch('/api/sandbox/job', { query: { token } })
if (error.value) throw createError({ statusCode: 404, statusMessage: 'Not found', fatal: true })

const submitted = computed(() => route.query.submitted)
const missing = computed(() => String(route.query.error || '').split(',').filter(Boolean))

useHead({ title: job.value ? `Apply: ${job.value.title}` : 'Apply' })
</script>

<template>
  <div class="sbx">
    <header class="sbx__header">
      <div class="sbx__company">{{ job?.company }}</div>
      <h1 class="sbx__title">{{ job?.title }}</h1>
      <div class="sbx__meta">{{ job?.location }}</div>
    </header>

    <main class="sbx__main">
      <div v-if="submitted" class="sbx__confirm" data-testid="confirmation">
        <h2>Thank you for applying</h2>
        <p>Your application was received. Reference number {{ submitted }}.</p>
      </div>

      <form
        v-else
        id="application_form"
        class="sbx__form"
        :action="`/api/sandbox/submit/${token}`"
        method="post"
        enctype="multipart/form-data"
      >
        <div v-if="missing.length" class="sbx__error" role="alert">
          Please complete the required fields: {{ missing.join(', ') }}
        </div>

        <fieldset>
          <legend>Personal information</legend>
          <div class="sbx__row">
            <label for="first_name">First Name <span class="sbx__req">*</span></label>
            <input id="first_name" name="first_name" type="text" autocomplete="given-name" required>
          </div>
          <div class="sbx__row">
            <label for="last_name">Last Name <span class="sbx__req">*</span></label>
            <input id="last_name" name="last_name" type="text" autocomplete="family-name" required>
          </div>
          <div class="sbx__row">
            <label for="email">Email <span class="sbx__req">*</span></label>
            <input id="email" name="email" type="email" autocomplete="email" required>
          </div>
          <div class="sbx__row">
            <label for="phone">Phone <span class="sbx__req">*</span></label>
            <input id="phone" name="phone" type="tel" autocomplete="tel" required>
          </div>
          <div class="sbx__row">
            <label for="location">Location (City)</label>
            <input id="location" name="location" type="text">
          </div>
          <div class="sbx__row">
            <label for="resume">Resume/CV <span class="sbx__req">*</span></label>
            <input id="resume" name="resume" type="file" accept=".pdf,.doc,.docx,.txt,.rtf" required>
          </div>
          <div class="sbx__row">
            <label for="cover_letter_text">Cover Letter</label>
            <textarea id="cover_letter_text" name="cover_letter_text" rows="8" />
          </div>
        </fieldset>

        <fieldset>
          <legend>Links</legend>
          <div class="sbx__row">
            <label for="linkedin">LinkedIn Profile</label>
            <input id="linkedin" name="linkedin" type="url">
          </div>
          <div class="sbx__row">
            <label for="website">Website or GitHub</label>
            <input id="website" name="website" type="url">
          </div>
        </fieldset>

        <fieldset>
          <legend>Application questions</legend>
          <div class="sbx__row">
            <label for="work_authorized">Are you legally authorized to work in the United States? <span class="sbx__req">*</span></label>
            <select id="work_authorized" name="work_authorized" required>
              <option value="">Select...</option>
              <option>Yes</option>
              <option>No</option>
            </select>
          </div>
          <div class="sbx__row">
            <label for="needs_sponsorship">Will you now or in the future require sponsorship for employment visa status? <span class="sbx__req">*</span></label>
            <select id="needs_sponsorship" name="needs_sponsorship" required>
              <option value="">Select...</option>
              <option>Yes</option>
              <option>No</option>
            </select>
          </div>
          <div class="sbx__row">
            <label for="years_php">How many years of professional experience do you have with PHP?</label>
            <input id="years_php" name="years_php" type="number" min="0" max="50">
          </div>
          <div class="sbx__row">
            <label for="salary_expectation">What are your salary expectations?</label>
            <input id="salary_expectation" name="salary_expectation" type="text">
          </div>
          <div class="sbx__row">
            <label for="why_us">Why do you want to work at Sandbox Test Co? <span class="sbx__req">*</span></label>
            <textarea id="why_us" name="why_us" rows="5" maxlength="2000" required />
          </div>
          <div class="sbx__row">
            <span class="sbx__label" id="go_label">Have you run a Go service in production?</span>
            <div role="radiogroup" aria-labelledby="go_label" class="sbx__choices">
              <label><input type="radio" name="go_production" value="Yes"> Yes</label>
              <label><input type="radio" name="go_production" value="No"> No</label>
            </div>
          </div>
          <div class="sbx__row">
            <label for="source">How did you hear about this job?</label>
            <select id="source" name="source">
              <option value="">Select...</option>
              <option>Job board</option>
              <option>Company website</option>
              <option>Referral</option>
              <option>Other</option>
            </select>
          </div>
        </fieldset>

        <fieldset>
          <legend>Voluntary self-identification</legend>
          <p class="sbx__note">Answering is voluntary and does not affect your application.</p>
          <div class="sbx__row">
            <label for="gender">Gender</label>
            <select id="gender" name="gender">
              <option value="">Select...</option>
              <option>Male</option>
              <option>Female</option>
              <option>Non-binary</option>
              <option>Decline to self-identify</option>
            </select>
          </div>
          <div class="sbx__row">
            <label for="race">Race / Ethnicity</label>
            <select id="race" name="race">
              <option value="">Select...</option>
              <option>Hispanic or Latino</option>
              <option>White</option>
              <option>Black or African American</option>
              <option>Asian</option>
              <option>Two or more races</option>
              <option>Decline to self-identify</option>
            </select>
          </div>
          <div class="sbx__row">
            <label for="veteran">Veteran Status</label>
            <select id="veteran" name="veteran">
              <option value="">Select...</option>
              <option>I am a protected veteran</option>
              <option>I am not a protected veteran</option>
              <option>I don't wish to answer</option>
            </select>
          </div>
        </fieldset>

        <div class="sbx__row sbx__row--inline">
          <input id="consent" name="consent" type="checkbox" value="yes" required>
          <label for="consent">I confirm the information in this application is accurate. <span class="sbx__req">*</span></label>
        </div>

        <button id="submit_app" type="submit" class="sbx__submit">Submit Application</button>
      </form>
    </main>
  </div>
</template>

<style scoped lang="scss">
.sbx {
  min-height: 100vh;
  background: #ffffff;
  color: #1d2733;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;

  &__header { background: #1d2733; color: #fff; padding: 32px 20px; }
  &__company { font-size: 14px; opacity: 0.75; }
  &__title { font-size: 26px; margin: 6px 0; }
  &__meta { font-size: 14px; opacity: 0.75; }
  &__main { max-width: 720px; margin: 0 auto; padding: 24px 16px 64px; }
  &__form fieldset { border: 1px solid #d5dbe1; background: #fff; border-radius: 6px; margin: 0 0 20px; padding: 16px 20px; }
  &__form legend { font-weight: 600; padding: 0 6px; }
  &__row { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
  &__row--inline { flex-direction: row; align-items: center; gap: 10px; }
  &__row input[type='text'], &__row input[type='email'], &__row input[type='tel'], &__row input[type='url'], &__row input[type='number'], &__row select, &__row textarea {
    border: 1px solid #b9c2cc; border-radius: 4px; padding: 9px 10px; font: inherit; background: #fff; color: inherit;
  }
  &__choices { display: flex; gap: 18px; }
  &__label { font-size: 15px; }
  &__req { color: #c0392b; }
  &__note { font-size: 13px; color: #5b6772; margin: 0; }
  &__error { background: #fdecea; border: 1px solid #f5c2bd; color: #8a1f14; padding: 10px 12px; border-radius: 4px; margin-bottom: 16px; }
  &__submit { background: #0b6bcb; color: #fff; border: 0; border-radius: 4px; padding: 12px 22px; font-size: 16px; cursor: pointer; }
  &__confirm { background: #fff; border: 1px solid #c8e6c9; border-radius: 6px; padding: 24px; }
}
</style>
