import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReverieConfig } from '@openreverie/core'
import { ensureMemoryTree, memoryPaths, newId, writeDocumentAtomic } from '@openreverie/memory'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mainWith } from './index.js'
import { type MigrateDeps, runMigrate } from './migrate.js'

function testConfig(memoryDir: string): ReverieConfig {
  return {
    memoryDir,
    provider: { name: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    models: { chat: 'fake-chat', reflection: 'fake-reflect', embeddings: 'fake-embed' },
    safety: { mode: 'companion', resources: [] },
    style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
  }
}

function fakeDeps(
  memoryDir: string,
  output: string[],
  configPath = '/tmp/config.toml',
): MigrateDeps {
  return {
    loadConfig: async () => testConfig(memoryDir),
    configPath,
    write: (text: string) => output.push(text),
  }
}

describe('runMigrate', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-migrate-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('lists pending migrations with --list', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await rm(paths.profile, { force: true })

    const output: string[] = []
    const exitCode = await runMigrate(['--list'], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    const joined = output.join('')
    expect(joined).toContain('pending')
    expect(joined).toContain('profile-seed')
    expect(joined).toContain('utc-to-local-rollups')
  })

  it('applies pending migrations and reports what it did', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await rm(paths.profile, { force: true })
    await writeDocumentAtomic({
      path: join(paths.rollupsDailyDir, '2026-08-15.md'),
      meta: { id: newId('doc'), date: '2026-08-15' },
      body: 'A rollup.\n',
    })

    const output: string[] = []
    const exitCode = await runMigrate([], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    const joined = output.join('')
    expect(joined).toContain('wrote profile.md')
    expect(joined).toContain('deleted 1 daily and 0 weekly rollup files')
    await expect(readFile(paths.profile, 'utf8')).resolves.toBeDefined()
    await expect(readFile(join(paths.rollupsDailyDir, '2026-08-15.md'), 'utf8')).rejects.toThrow()
  })

  it('reports a missing memory folder and exits non-zero', async () => {
    const missingDir = join(dir, 'never-created')

    const output: string[] = []
    const exitCode = await runMigrate([], fakeDeps(missingDir, output))

    expect(exitCode).not.toBe(0)
    expect(output.join('')).toContain('No memory folder found')
  })

  it('prints the config error and exits non-zero when loadConfig throws', async () => {
    const output: string[] = []
    const deps: MigrateDeps = {
      loadConfig: async () => {
        throw new Error('No config found. Run: reverie setup')
      },
      configPath: '/tmp/config.toml',
      write: (text: string) => output.push(text),
    }
    const exitCode = await runMigrate([], deps)

    expect(exitCode).toBe(1)
    expect(output.join('')).toContain('No config found. Run: reverie setup')
  })
})

describe('mainWith migrate dispatch', () => {
  it('dispatches migrate before normal chat setup', async () => {
    const runMigrateMock = vi.fn(async () => 0)
    const openCliContext = vi.fn()
    const deps = {
      runMigrate: runMigrateMock,
      openCliContext,
      loadConfig: vi.fn(),
      configPath: '/tmp/config.toml',
      write: () => {},
      colorEnabled: () => false,
    }

    await mainWith(['migrate'], deps as never)

    expect(runMigrateMock).toHaveBeenCalledOnce()
    expect(openCliContext).not.toHaveBeenCalled()
  })
})
