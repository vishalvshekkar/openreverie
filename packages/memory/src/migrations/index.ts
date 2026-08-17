// The migration registry: a small, named, idempotent unit of work for a
// memory folder, applied explicitly by `reverie migrate` and never
// automatically on open. Nothing here runs during MemoryEngine.open.
//
// A migration takes a MigrationContext, not a bare MemoryPaths. config.toml
// is not in MemoryPaths: that interface holds only paths inside the memory
// folder, and the config file lives outside it, overridable per invocation
// with --config. A migration that needs to read or rewrite the config file
// cannot find it from MemoryPaths and must not guess the default path, so
// the path `reverie` actually loaded the config from rides in the context.
//
// Applied migrations are recorded, one line each, in an append-only log at
// <memoryDir>/migrations.jsonl ({ id, appliedAt }). runMigrations reads that
// log up front and skips any id already in it, so a second run of `reverie
// migrate` is a no-op by a cheap set-membership check instead of every
// migration re-inspecting the whole folder.

import { appendFile, readFile } from 'node:fs/promises'
import type { MemoryPaths } from '../paths.js'
import { profileSeedMigration } from './profileSeed.js'
import { utcToLocalRollupsMigration } from './utcToLocalRollups.js'

export interface MigrationContext {
  paths: MemoryPaths
  configPath: string
}

export interface MigrationResult {
  id: string
  // True when apply actually wrote to disk; false under a dry run.
  applied: boolean
  // One human-readable line describing what happened or what would happen.
  summary: string
  // Zero or more paths, printed one per line under the summary.
  details: string[]
}

export interface Migration {
  // Stable across releases, e.g. "profile-seed".
  id: string
  description: string
  isPending(ctx: MigrationContext): Promise<boolean>
  apply(ctx: MigrationContext, opts: { dryRun: boolean }): Promise<MigrationResult>
}

export interface MigrationLogEntry {
  id: string
  appliedAt: string
}

export interface MigrationStatus {
  id: string
  description: string
  applied: boolean
}

export interface RunMigrationsOptions {
  dryRun: boolean
}

// The ordered list of migrations `reverie migrate` iterates. Empty in this
// task; profile-seed and utc-to-local-rollups register themselves in the two
// tasks that add them. Order matters once there is more than one: a later
// migration may depend on a file an earlier one just wrote.
export const migrations: Migration[] = [profileSeedMigration, utcToLocalRollupsMigration]

export async function readAppliedMigrationIds(paths: MemoryPaths): Promise<Set<string>> {
  let raw: string
  try {
    raw = await readFile(paths.migrationsLog, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Set()
    }
    throw err
  }

  const ids = new Set<string>()
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined || line.trim() === '') {
      continue
    }
    let entry: MigrationLogEntry
    try {
      entry = JSON.parse(line) as MigrationLogEntry
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Migration log ${paths.migrationsLog} line ${i + 1} is not valid JSON: ${message}`,
      )
    }
    if (typeof entry.id === 'string' && entry.id.length > 0) {
      ids.add(entry.id)
    }
  }
  return ids
}

export async function appendMigrationLog(
  paths: MemoryPaths,
  entry: MigrationLogEntry,
): Promise<void> {
  await appendFile(paths.migrationsLog, `${JSON.stringify(entry)}\n`, 'utf8')
}

export async function listMigrations(ctx: MigrationContext): Promise<MigrationStatus[]> {
  const appliedIds = await readAppliedMigrationIds(ctx.paths)
  return migrations.map((migration) => ({
    id: migration.id,
    description: migration.description,
    applied: appliedIds.has(migration.id),
  }))
}

export async function runMigrations(
  ctx: MigrationContext,
  options: RunMigrationsOptions = { dryRun: false },
): Promise<MigrationResult[]> {
  const appliedIds = await readAppliedMigrationIds(ctx.paths)
  const results: MigrationResult[] = []
  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) {
      continue
    }
    if (!(await migration.isPending(ctx))) {
      continue
    }
    const result = await migration.apply(ctx, { dryRun: options.dryRun })
    if (!options.dryRun) {
      await appendMigrationLog(ctx.paths, {
        id: migration.id,
        appliedAt: new Date().toISOString(),
      })
      result.applied = true
    }
    results.push(result)
  }
  return results
}
