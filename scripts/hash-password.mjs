#!/usr/bin/env node
// Prints a NUXT_AUTH_PASSWORD_HASH value for the password typed on stdin.
// Usage: node scripts/hash-password.mjs   (then type the password and press Enter)
import { randomBytes, scryptSync } from 'node:crypto'
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
rl.question('Password: ', (password) => {
  rl.close()
  if (!password || password.length < 12) {
    console.error('Use at least 12 characters.')
    process.exit(1)
  }
  const N = 2 ** 15, r = 8, p = 1
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64, { N, r, p, maxmem: 128 * N * r * 2 })
  console.log(['scrypt', N, r, p, salt.toString('base64'), hash.toString('base64')].join(':'))
})
