export default defineEventHandler(async (event) => {
  return { loggedIn: await isLoggedIn(event), configured: authConfigured() }
})
