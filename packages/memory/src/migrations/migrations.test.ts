import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type MemoryPaths, memoryPaths } from '../paths.js'
import {
  appendMigrationLog,
  listMigrations,
  type MigrationContext,
  readAppliedMigrationIds,
  runMigrations,
} from './index.js'

describe('migrations log and runner', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-migrations-'))
    paths = memoryPaths(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('exposes migrations.jsonl as migrationsLog on MemoryPaths', () => {
    expect(paths.migrationsLog).toBe(join(dir, 'migrations.jsonl'))
  })

  it('round-trips applied ids through the log', async () => {
    await appendMigrationLog(paths, { id: 'profile-seed', appliedAt: '2026-08-17T00:00:00.000Z' })
    await appendMigrationLog(paths, {
      id: 'utc-to-local-rollups',
      appliedAt: '2026-08-17T00:00:01.000Z',
    })
    const ids = await readAppliedMigrationIds(paths)
    expect(ids).toEqual(new Set(['profile-seed', 'utc-to-local-rollups']))
  })

  it('treats a missing log as having no applied migrations', async () => {
    await expect(readAppliedMigrationIds(paths)).resolves.toEqual(new Set())
  })

  it('throws, naming the path and the line, when a log line is not valid JSON', async () => {
    await writeFile(paths.migrationsLog, 'not json\n', 'utf8')
    await expect(readAppliedMigrationIds(paths)).rejects.toThrow('line 1')
  })

  it('lists nothing and runs nothing against an empty registry', async () => {
    const ctx: MigrationContext = { paths, configPath: '/tmp/config.toml' }
    await expect(listMigrations(ctx)).resolves.toEqual([])
    await expect(runMigrations(ctx)).resolves.toEqual([])
  })
})
