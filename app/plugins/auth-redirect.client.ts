// When a session expires mid-use, API calls start returning 401. Send the browser to the
// login page instead of leaving the page half broken.
export default defineNuxtPlugin(() => {
  const original = globalThis.$fetch
  globalThis.$fetch = original.create({
    onResponseError({ response }) {
      if (response.status === 401 && !window.location.pathname.startsWith('/login')) {
        const next = encodeURIComponent(window.location.pathname + window.location.search)
        window.location.href = `/login?next=${next}`
      }
    },
  }) as typeof original
})
