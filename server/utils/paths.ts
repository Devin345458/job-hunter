import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * Root for everything the app writes besides the database: resumes, screenshots,
 * demo project repos, sandbox uploads. It sits next to the database so that on the
 * server it lands on the persistent /data volume, not inside the container's /app.
 */
export function dataDir(): string {
  const config = useRuntimeConfig()
  const dbPath = config.databasePath || './data/job-hunter.db'
  return resolve(dirname(dbPath))
}

/** Absolute path under the data directory. Creates the parent directory. */
export function dataPath(...parts: string[]): string {
  const full = join(dataDir(), ...parts)
  mkdirSync(dirname(full), { recursive: true })
  return full
}

/** Resolve a stored path (absolute, or relative to the process cwd as older rows store them). */
export function resolveStoredPath(stored: string): string {
  return isAbsolute(stored) ? stored : resolve(stored)
}
