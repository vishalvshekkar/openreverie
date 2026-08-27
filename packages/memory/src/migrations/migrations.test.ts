import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newId, writeDocumentAtomic } from '../documents.js'
import { nodeStores } from '../nodeStore.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from '../paths.js'
import { loadProfile } from '../profile.js'
import {
  appendMigrationLog,
  type MigrationContext,
  readAppliedMigrationIds,
  runMigrations,
} from './index.js'
import { profileSeedMigration } from './profileSeed.js'
import { utcToLocalRollupsMigration } from './utcToLocalRollups.js'

describe('migrations log and runner', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-migrations-'))
    paths = memoryPaths(dir, nodeStores())
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
})

describe('profile-seed migration', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-profile-seed-'))
    paths = memoryPaths(dir, nodeStores())
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is pending when profile.md is absent and not pending once it exists', async () => {
    await ensureMemoryTree(paths, 'UTC')
    await rm(paths.profile, { force: true })

    const ctx: MigrationContext = { paths, configPath: '/tmp/config.toml', timezone: 'UTC' }
    await expect(profileSeedMigration.isPending(ctx)).resolves.toBe(true)

    await profileSeedMigration.apply(ctx, { dryRun: false })
    await expect(profileSeedMigration.isPending(ctx)).resolves.toBe(false)
  })

  it('apply writes a system-default profile carrying the context zone, not a machine-read one', async () => {
    await ensureMemoryTree(paths, 'UTC')
    await rm(paths.profile, { force: true })
    // Pacific/Midway (UTC-11), deliberately not the test runner's own zone,
    // so this only passes if profileSeedMigration actually used ctx.timezone
    // rather than reading Intl's system zone.
    const ctx: MigrationContext = {
      paths,
      configPath: '/tmp/config.toml',
      timezone: 'Pacific/Midway',
    }

    const dry = await profileSeedMigration.apply(ctx, { dryRun: true })
    expect(dry.applied).toBe(false)
    expect(dry.summary).toContain('would write')
    await expect(readFile(paths.profile, 'utf8')).rejects.toThrow()

    const real = await profileSeedMigration.apply(ctx, { dryRun: false })
    expect(real.applied).toBe(true)
    expect(real.summary).toContain('wrote')
    const profile = await loadProfile(paths, 'UTC')
    expect(profile.meta.timezoneSource).toBe('system-default')
    expect(profile.meta.timezone).toBe('Pacific/Midway')
  })

  it('runMigrations applies it once and records it, and a second run does nothing', async () => {
    await ensureMemoryTree(paths, 'UTC')
    await rm(paths.profile, { force: true })
    const ctx: MigrationContext = { paths, configPath: '/tmp/config.toml', timezone: 'UTC' }

    const first = await runMigrations(ctx)
    expect(first.map((result) => result.id)).toEqual(['profile-seed'])

    const applied = await readAppliedMigrationIds(paths)
    expect(applied.has('profile-seed')).toBe(true)

    const second = await runMigrations(ctx)
    expect(second).toEqual([])
  })
})

describe('utc-to-local-rollups migration', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-utc-rollups-'))
    paths = memoryPaths(dir, nodeStores())
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is pending when rollups exist, and not pending when there are none', async () => {
    await ensureMemoryTree(paths, 'UTC')
    const ctx: MigrationContext = { paths, configPath: '/tmp/config.toml', timezone: 'UTC' }
    await expect(utcToLocalRollupsMigration.isPending(ctx)).resolves.toBe(false)

    await writeDocumentAtomic(paths.files, {
      path: join(paths.rollupsDailyDir, '2026-08-15.md'),
      meta: { id: newId('doc'), date: '2026-08-15' },
      body: 'A rollup.\n',
    })
    await expect(utcToLocalRollupsMigration.isPending(ctx)).resolves.toBe(true)
  })

  it('is not pending once recorded in the log, even when rollups exist again', async () => {
    await ensureMemoryTree(paths, 'UTC')
    const ctx: MigrationContext = { paths, configPath: '/tmp/config.toml', timezone: 'UTC' }
    await writeDocumentAtomic(paths.files, {
      path: join(paths.rollupsDailyDir, '2026-08-15.md'),
      meta: { id: newId('doc'), date: '2026-08-15' },
      body: 'A rollup.\n',
    })
    await appendMigrationLog(paths, {
      id: 'utc-to-local-rollups',
      appliedAt: '2026-08-17T00:00:00.000Z',
    })
    await expect(utcToLocalRollupsMigration.isPending(ctx)).resolves.toBe(false)
  })

  it('apply deletes every daily and weekly rollup, and a dry run deletes nothing', async () => {
    await ensureMemoryTree(paths, 'UTC')
    const ctx: MigrationContext = { paths, configPath: '/tmp/config.toml', timezone: 'UTC' }
    const dailyPath = join(paths.rollupsDailyDir, '2026-08-15.md')
    const weeklyPath = join(paths.rollupsWeeklyDir, '2026-W33.md')
    await writeDocumentAtomic(paths.files, {
      path: dailyPath,
      meta: { id: newId('doc'), date: '2026-08-15' },
      body: 'A rollup.\n',
    })
    await writeDocumentAtomic(paths.files, {
      path: weeklyPath,
      meta: { id: newId('doc'), week: '2026-W33' },
      body: 'A week.\n',
    })

    const dry = await utcToLocalRollupsMigration.apply(ctx, { dryRun: true })
    expect(dry.applied).toBe(false)
    expect(dry.details).toContain(dailyPath)
    expect(dry.details).toContain(weeklyPath)
    await expect(readFile(dailyPath, 'utf8')).resolves.toBeDefined()

    const real = await utcToLocalRollupsMigration.apply(ctx, { dryRun: false })
    expect(real.applied).toBe(true)
    await expect(readFile(dailyPath, 'utf8')).rejects.toThrow()
    await expect(readFile(weeklyPath, 'utf8')).rejects.toThrow()
  })

  it('runMigrations runs both migrations once and a second run is a no-op', async () => {
    await ensureMemoryTree(paths, 'UTC')
    await rm(paths.profile, { force: true })
    await writeDocumentAtomic(paths.files, {
      path: join(paths.rollupsDailyDir, '2026-08-15.md'),
      meta: { id: newId('doc'), date: '2026-08-15' },
      body: 'A rollup.\n',
    })
    const ctx: MigrationContext = { paths, configPath: '/tmp/config.toml', timezone: 'UTC' }

    const first = await runMigrations(ctx)
    expect(first.map((result) => result.id)).toEqual(['profile-seed', 'utc-to-local-rollups'])

    await expect(readFile(paths.profile, 'utf8')).resolves.toBeDefined()
    await expect(readFile(join(paths.rollupsDailyDir, '2026-08-15.md'), 'utf8')).rejects.toThrow()

    const second = await runMigrations(ctx)
    expect(second).toEqual([])
  })
})
