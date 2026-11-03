import { drizzle } from 'drizzle-orm/better-sqlite3'
import Database from 'better-sqlite3'
import * as schema from '../db/schema'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { chmodSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { dirname, join } from 'path'

/**
 * In the container (running as root) keep the database and private files away from the
 * unprivileged user that runs demo builds: the data directory can be traversed but not
 * listed, and the database, backups, resumes, screenshots, and sandbox uploads are root-only.
 */
function lockDownDataDir(dbPath: string) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return
  try {
    const dir = dirname(dbPath)
    chmodSync(dir, 0o711)
    for (const name of readdirSync(dir)) {
      if (name.startsWith('job-hunter.db') || ['backups', 'resumes', 'cover-letters', 'screenshots', 'sandbox', 'sandbox-remotes'].includes(name)) {
        chmodSync(join(dir, name), name.includes('.') ? 0o600 : 0o700)
      }
    }
  }
  catch (e) {
    console.warn('[db] could not tighten data directory permissions', e)
  }
}

let _db: ReturnType<typeof drizzle> | null = null

export function useDb() {
  if (_db) return _db

  const config = useRuntimeConfig()
  const dbPath = config.databasePath || './data/job-hunter.db'

  // Ensure the data directory exists
  const dir = dirname(dbPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  lockDownDataDir(dbPath)
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  // A web and a worker process can share this file (NUXT_ROLE); a write waits up to 5 seconds for the other.
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('foreign_keys = ON')

  _db = drizzle(sqlite, { schema })

  // Run migrations on first connection
  try {
    migrate(_db, { migrationsFolder: './server/db/migrations' })
  } catch (e) {
    console.warn('Migration warning:', e)
  }

  return _db
}
