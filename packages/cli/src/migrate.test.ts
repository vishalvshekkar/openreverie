import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureMemoryTree,
  memoryPaths,
  newId,
  SessionStore,
  writeDocumentAtomic,
} from '@openreverie/memory'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mainWith } from './index.js'
import { type MigrateDeps, runMigrate } from './migrate.js'

// configPath defaults to a file inside the memory folder's parent, never a
// shared path like /tmp/config.toml: styleToProfile now writes to
// ctx.configPath when it finds a [style] table there, and a fake config
// path must not be able to collide with anything real on the machine
// running the suite.
function fakeDeps(
  memoryDir: string,
  output: string[],
  configPath = join(memoryDir, '..', 'config.toml'),
): MigrateDeps {
  return {
    readMemoryDir: async () => memoryDir,
    configPath,
    write: (text: string) => output.push(text),
  }
}

// Hashes every file under `root` recursively, in sorted path order, with
// each entry's name folded in so renames register too. Excludes index.db
// (a derived artifact) and any *.tmp-* file (an in-flight atomic write), the
// two entries the seeded .gitignore already names.
async function hashFolder(root: string): Promise<string> {
  const hash = createHash('sha256')
  const entries = await readdir(root, { withFileTypes: true })
  const sorted = entries
    .filter((entry) => entry.name !== 'index.db' && !entry.name.includes('.tmp-'))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
  for (const entry of sorted) {
    const full = join(root, entry.name)
    hash.update(entry.name)
    if (entry.isDirectory()) {
      hash.update(await hashFolder(full))
    } else {
      hash.update(await readFile(full))
    }
  }
  return hash.digest('hex')
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

  it('prints the config error and exits non-zero when readMemoryDir throws', async () => {
    const output: string[] = []
    const deps: MigrateDeps = {
      readMemoryDir: async () => {
        throw new Error('No config found. Run: reverie setup')
      },
      configPath: join(dir, 'config.toml'),
      write: (text: string) => output.push(text),
    }
    const exitCode = await runMigrate([], deps)

    expect(exitCode).toBe(1)
    expect(output.join('')).toContain('No config found. Run: reverie setup')
  })

  it('--dry-run reports pending deletions and changes nothing on disk, proven by a folder hash', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await rm(paths.profile, { force: true })
    await writeDocumentAtomic({
      path: join(paths.rollupsDailyDir, '2026-08-14.md'),
      meta: { id: newId('doc'), date: '2026-08-14' },
      body: 'A rollup.\n',
    })
    await writeDocumentAtomic({
      path: join(paths.rollupsDailyDir, '2026-08-15.md'),
      meta: { id: newId('doc'), date: '2026-08-15' },
      body: 'A rollup.\n',
    })
    await writeDocumentAtomic({
      path: join(paths.rollupsWeeklyDir, '2026-W33.md'),
      meta: { id: newId('doc'), week: '2026-W33' },
      body: 'A week.\n',
    })

    const before = await hashFolder(dir)

    const output: string[] = []
    const exitCode = await runMigrate(['--dry-run'], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    expect(output.join('')).toContain('would delete 2 daily and 1 weekly rollup files')
    expect(output.join('')).toContain('would write profile.md')

    const after = await hashFolder(dir)
    expect(after).toBe(before)
  })

  it('running twice does the work once: the second run reports nothing and leaves transcripts byte-identical', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await rm(paths.profile, { force: true })
    await writeDocumentAtomic({
      path: join(paths.rollupsDailyDir, '2026-08-15.md'),
      meta: { id: newId('doc'), date: '2026-08-15' },
      body: 'A rollup.\n',
    })
    const store = await SessionStore.start(paths, new Date('2026-08-15T21:00:00Z'))
    await store.appendLine({ ts: '2026-08-15T21:00:00.000Z', role: 'user', content: 'hello' })

    const transcriptBefore = await readFile(join(store.dir, 'transcript.jsonl'), 'utf8')

    const first: string[] = []
    const firstCode = await runMigrate([], fakeDeps(dir, first))
    expect(firstCode).toBe(0)

    const second: string[] = []
    const secondCode = await runMigrate([], fakeDeps(dir, second))
    expect(secondCode).toBe(0)
    expect(second.join('')).toContain('Nothing to migrate')

    const transcriptAfter = await readFile(join(store.dir, 'transcript.jsonl'), 'utf8')
    expect(transcriptAfter).toBe(transcriptBefore)
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
