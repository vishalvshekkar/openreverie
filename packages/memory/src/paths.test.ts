import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commitMemory } from './gitSync.js'
import { memoryStores } from './memoryStore.js'
import { nodeStores } from './nodeStore.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'
import { loadProfile } from './profile.js'
import { isValidIanaTimeZone } from './time.js'

const execFileAsync = promisify(execFile)

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('ensureMemoryTree', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-paths-'))
    paths = memoryPaths(dir, nodeStores())
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('seeds profile.md with a system-default timezone on a brand new folder', async () => {
    await ensureMemoryTree(paths, 'UTC')

    const profile = await loadProfile(paths, 'UTC')
    expect(profile.meta.timezoneSource).toBe('system-default')
    expect(typeof profile.meta.timezone).toBe('string')
    expect(isValidIanaTimeZone(profile.meta.timezone as string)).toBe(true)
    expect(profile.body.trim().length).toBeGreaterThan(0)
  })

  it('leaves an existing profile.md exactly as it is', async () => {
    await ensureMemoryTree(paths, 'UTC')
    const first = await readFile(paths.profile, 'utf8')

    await ensureMemoryTree(paths, 'UTC')
    const second = await readFile(paths.profile, 'utf8')

    expect(second).toBe(first)
  })

  it('still seeds the constitution and the gitignore', async () => {
    await ensureMemoryTree(paths, 'UTC')
    expect((await readFile(paths.constitution, 'utf8')).length).toBeGreaterThan(0)
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe(
      'index.db\n*.tmp-*\ndreams/.lock\n',
    )
  })

  it('appends the dream lock rule to an existing gitignore without touching its other lines, and never duplicates it', async () => {
    const gitignorePath = join(dir, '.gitignore')
    await mkdir(dir, { recursive: true })
    await writeFile(gitignorePath, "# a person's own hand-edited rule\nnode_modules\n", 'utf8')

    await ensureMemoryTree(paths, 'UTC')
    const once = await readFile(gitignorePath, 'utf8')
    expect(once).toBe("# a person's own hand-edited rule\nnode_modules\ndreams/.lock\n")

    await ensureMemoryTree(paths, 'UTC')
    const twice = await readFile(gitignorePath, 'utf8')
    expect(twice).toBe(once)
  })

  // capabilities.versioning: false means "this host has no git", so there
  // is nothing to seed a .gitignore for. In-memory store, not
  // nodeStores(), because the point is a store whose capabilities differ
  // from Node's rather than a different filesystem.
  //
  // Falsified 2026-08-27: removed the `if (paths.files.capabilities.versioning)`
  // guard around the ensureGitignoreLine call in paths.ts's ensureMemoryTree
  // and reran this test. It failed because a .gitignore was seeded anyway
  // (files.exists resolved true where the test expects false). The guard
  // was then restored and this test passes again.
  it('skips seeding .gitignore entirely when the store has no versioning capability', async () => {
    // A fake root, not a real temp directory: MemoryFileStore never
    // touches disk, so there is nothing on the real filesystem to clean up.
    const noVersioningRoot = '/no-versioning-root'
    const noVersioningPaths = memoryPaths(
      noVersioningRoot,
      memoryStores({ versioning: false, locking: false }),
    )
    await ensureMemoryTree(noVersioningPaths, 'UTC')
    expect(await noVersioningPaths.files.exists(join(noVersioningRoot, '.gitignore'))).toBe(false)
    // Everything else ensureMemoryTree does still happens: the tree and
    // the starter documents are not gated on versioning.
    expect(await noVersioningPaths.files.exists(noVersioningPaths.constitution)).toBe(true)
  })

  // capabilities.versioning: false means "this host has no git" the same
  // way it means "no .gitignore to seed" above. The root is created inside
  // the in-memory store (via ensureMemoryTree's own paths.files.mkdir), so
  // it reads as a real directory to commitMemory's own isDirectory check;
  // the only thing standing between that and an actual `git` invocation
  // against a path that does not exist on the real filesystem is the
  // versioning guard. If that guard were gone, the real child_process call
  // would fail against the fake root and get swallowed into a "git commit
  // failed" warning, which is exactly the kind of warning that misstates
  // its own cause: git was never applicable here, it did not try and fail.
  //
  // Falsified 2026-08-27: removed the `if (!files.capabilities.versioning)`
  // guard at the top of commitMemory in gitSync.ts and reran this test. It
  // failed because commitResult.ok was false and commitResult.warning was
  // a "git commit failed: ..." string (the real git process could not find
  // the fake root on disk), instead of the expected ok: true with no
  // warning. The guard was then restored and this test passes again.
  it('commitMemory does no git work and returns no warning when the store has no versioning capability', async () => {
    const noVersioningRoot = '/no-versioning-root'
    const noVersioningPaths = memoryPaths(
      noVersioningRoot,
      memoryStores({ versioning: false, locking: false }),
    )
    await ensureMemoryTree(noVersioningPaths, 'UTC')

    const result = await commitMemory(
      noVersioningPaths.files,
      noVersioningPaths.root,
      'test: no versioning',
    )
    expect(result.ok).toBe(true)
    expect(result.warning).toBeUndefined()
    // No .git ever appears in the store: proof no git work was attempted,
    // not just that the returned result looks right.
    expect(await noVersioningPaths.files.exists(join(noVersioningRoot, '.git'))).toBe(false)
  })

  it('commitMemory leaves the working tree clean with a dream lock present', async () => {
    await ensureMemoryTree(paths, 'UTC')
    const lockPath = join(paths.dreamsDir, '.lock')
    await writeFile(lockPath, JSON.stringify({ ts: new Date().toISOString(), pid: 1 }), 'utf8')

    // Mirrors the real sequence: executeDream's commitMemory runs while the
    // lock still exists (release happens afterward, in maybeDream's
    // finally), so the commit that matters is the one made with the lock
    // present. Deleting it afterward is what releaseDreamLock does next.
    const committedWithLock = await commitMemory(paths.files, paths.root, 'dream: 2026-08-24')
    expect(committedWithLock.ok).toBe(true)
    await rm(lockPath, { force: true })

    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: paths.root })
    expect(stdout.trim()).toBe('')
  })
})

describe('journal paths', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-paths-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('memoryPaths joins journalDir and journaling under the root', () => {
    const paths = memoryPaths(dir, nodeStores())
    expect(paths.journalDir).toBe(join(dir, 'journal'))
    expect(paths.journaling).toBe(join(dir, 'journaling.md'))
  })

  it('ensureMemoryTree creates the journal directory', async () => {
    const paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
    expect(await pathExists(paths.journalDir)).toBe(true)
  })

  it('ensureMemoryTree does not seed journaling.md, unlike the constitution', async () => {
    const paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
    expect(await pathExists(paths.constitution)).toBe(true)
    expect(await pathExists(paths.journaling)).toBe(false)
  })

  it('running ensureMemoryTree twice never creates journaling.md on its own', async () => {
    const paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
    await ensureMemoryTree(paths, 'UTC')
    expect(await pathExists(paths.journaling)).toBe(false)
  })
})
