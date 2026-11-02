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
          <v-icon icon="mdi-target" color="primary" size="28" />
          <span>Job Hunter</span>
        </div>
        <h1 class="login__title">Sign in</h1>
        <p class="login__sub">This app acts under your name. Only the owner password opens it.</p>
        <form @submit.prevent="submit">
          <v-text-field
            v-model="password"
            label="Password"
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
          <v-btn type="submit" color="primary" size="large" block :loading="busy" :disabled="!password" rounded="md">
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
  &__brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 18px; margin-bottom: 28px; }
  &__title { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 6px; }
  &__sub { opacity: 0.6; font-size: 14px; margin: 0 0 24px; }
  &__eye { margin-inline-end: -4px; }
}
</style>
