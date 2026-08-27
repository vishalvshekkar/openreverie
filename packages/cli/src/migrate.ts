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
import {
  listMigrations,
  type MigrationContext,
  memoryPaths,
  nodeStores,
  runMigrations,
  systemTimeZone,
} from '@openreverie/memory'

export interface MigrateDeps {
  // reverie migrate must run on exactly the installs loadConfig now refuses,
  // so it reads the memory folder out of the raw TOML instead of validating
  // the whole file first.
  readMemoryDir: () => Promise<string>
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

  let memoryDir: string
  try {
    memoryDir = await deps.readMemoryDir()
  } catch (err) {
    deps.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  const paths = memoryPaths(memoryDir, nodeStores())
  if (!(await pathIsDirectory(paths.root))) {
    deps.write(`No memory folder found at ${paths.root}. Run: reverie setup\n`)
    return 1
  }

  // `reverie migrate` genuinely runs on the person's own machine, so the
  // system zone is an honest default here, the same reasoning that keeps
  // cli/src/doctor.ts's own systemTimeZone() call. Only a migration that
  // seeds a brand-new profile.md (profile-seed) or reads an existing one
  // under it (style-to-profile) ever uses this value; see
  // docs/superpowers/specs/2026-08-27-hostable-engine-design.md, P0-3.
  const ctx: MigrationContext = { paths, configPath: deps.configPath, timezone: systemTimeZone() }

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
