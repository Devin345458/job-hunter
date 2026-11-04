<script setup lang="ts">
definePageMeta({ layout: false })
useHead({ title: 'Sign in · Job Hunter' })

const route = useRoute()
const password = ref('')
const error = ref<string | null>(null)
const busy = ref(false)
const show = ref(false)

async function submit() {
  if (!password.value || busy.value) return
  busy.value = true
  error.value = null
  try {
    await $fetch('/api/auth/login', { method: 'POST', body: { password: password.value } })
    const next = typeof route.query.next === 'string' && route.query.next.startsWith('/') && !route.query.next.startsWith('//')
      ? route.query.next
      : '/'
    await navigateTo(next, { external: true })
  }
  catch (e: any) {
    error.value = e?.data?.statusMessage || e?.statusMessage || 'Sign in failed'
    password.value = ''
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <v-app>
    <v-main>
      <div class="login">
      <div class="login__panel">
        <div class="login__brand">
          <!-- The app's mark: the match score's ring, nearly full, in the score hue. -->
          <svg class="login__mark" viewBox="0 0 32 32" aria-hidden="true">
            <circle cx="16" cy="16" r="12" class="login__mark-track" />
            <circle cx="16" cy="16" r="12" class="login__mark-arc" pathLength="100" stroke-dasharray="92 100" transform="rotate(-90 16 16)" />
          </svg>
          <span>Job Hunter</span>
        </div>
        <h1 class="login__title">Sign in</h1>
        <p class="login__sub">This app acts under your name. Only the owner password opens it.</p>
        <form @submit.prevent="submit">
          <label class="field-label" for="login-password">Password</label>
          <v-text-field
            id="login-password"
            v-model="password"
            :type="show ? 'text' : 'password'"
            autocomplete="current-password"
            autofocus
            :error-messages="error ? [error] : []"
          >
            <!-- A real button with its own name. Vuetify's append-inner-icon named it "Password appended action". -->
            <template #append-inner>
              <v-btn
                :icon="show ? 'mdi-eye-off-outline' : 'mdi-eye-outline'"
                :aria-label="show ? 'Hide password' : 'Show password'"
                :aria-pressed="show"
                variant="text"
                width="44"
                height="44"
                rounded="md"
                class="login__eye"
                @click="show = !show"
              />
            </template>
          </v-text-field>
          <v-btn type="submit" color="primary" size="large" block :loading="busy" :disabled="!password" :title="password ? undefined : 'Enter the password first'" rounded="md">
            Sign in
          </v-btn>
        </form>
      </div>
      </div>
    </v-main>
  </v-app>
</template>

<style scoped lang="scss">
.login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 16px;

  &__panel { width: 100%; max-width: 380px; padding: 32px 24px; }
  &__brand { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 17px; margin-bottom: 28px; }
  &__mark { width: 28px; height: 28px; fill: none; stroke-width: 4; }
  &__mark-track { stroke: rgb(var(--v-theme-surface-light)); }
  &__mark-arc { stroke: rgb(var(--v-theme-primary)); stroke-linecap: round; }
  &__title { font-size: 24px; font-weight: 600; letter-spacing: -0.015em; margin: 0 0 4px; }
  &__sub { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); font-size: 14px; margin: 0 0 24px; }
  &__eye { margin-inline-end: -4px; }
}
</style>
