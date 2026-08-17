// `reverie migrate`: apply pending memory-folder migrations, deliberately
// and explicitly, never automatically on open. Built the same way read.ts
// is: loadConfig to learn the memory folder, memoryPaths to address it, and
// the migration registry from @openreverie/memory. No engine, no provider,
// no network: migrations touch only prose files and rollups, and this
// command must work with the provider offline or unconfigured.
//
// configPath is threaded through because the migration context needs the
// real path the config was loaded from, not the default. A migration that
// reads or rewrites config.toml must not guess, since --config can point
// anywhere.

import { stat } from 'node:fs/promises'
import type { ReverieConfig } from '@openreverie/core'
import {
  listMigrations,
  type MigrationContext,
  memoryPaths,
  runMigrations,
} from '@openreverie/memory'

export interface MigrateDeps {
  loadConfig: () => Promise<ReverieConfig>
  configPath: string
  write: (text: string) => void
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

export async function runMigrate(args: string[], deps: MigrateDeps): Promise<number> {
  const dryRun = args.includes('--dry-run')
  const list = args.includes('--list')

  let config: ReverieConfig
  try {
    config = await deps.loadConfig()
  } catch (err) {
    deps.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  const paths = memoryPaths(config.memoryDir)
  if (!(await pathIsDirectory(paths.root))) {
    deps.write(`No memory folder found at ${paths.root}. Run: reverie setup\n`)
    return 1
  }

  const ctx: MigrationContext = { paths, configPath: deps.configPath }

  if (list) {
    const statuses = await listMigrations(ctx)
    for (const status of statuses) {
      deps.write(`${status.applied ? 'applied' : 'pending'}  ${status.id}: ${status.description}\n`)
    }
    return 0
  }

  const results = await runMigrations(ctx, { dryRun })
  if (results.length === 0) {
    deps.write('Nothing to migrate: every migration is already applied.\n')
    return 0
  }
  for (const result of results) {
    deps.write(`${result.summary}\n`)
    for (const detail of result.details) {
      deps.write(`  ${detail}\n`)
    }
  }
  return 0
}
