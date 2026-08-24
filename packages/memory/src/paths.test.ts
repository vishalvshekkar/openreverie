import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commitMemory } from './gitSync.js'
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
    paths = memoryPaths(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('seeds profile.md with a system-default timezone on a brand new folder', async () => {
    await ensureMemoryTree(paths)

    const profile = await loadProfile(paths)
    expect(profile.meta.timezoneSource).toBe('system-default')
    expect(typeof profile.meta.timezone).toBe('string')
    expect(isValidIanaTimeZone(profile.meta.timezone as string)).toBe(true)
    expect(profile.body.trim().length).toBeGreaterThan(0)
  })

  it('leaves an existing profile.md exactly as it is', async () => {
    await ensureMemoryTree(paths)
    const first = await readFile(paths.profile, 'utf8')

    await ensureMemoryTree(paths)
    const second = await readFile(paths.profile, 'utf8')

    expect(second).toBe(first)
  })

  it('still seeds the constitution and the gitignore', async () => {
    await ensureMemoryTree(paths)
    expect((await readFile(paths.constitution, 'utf8')).length).toBeGreaterThan(0)
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe(
      'index.db\n*.tmp-*\ndreams/.lock\n',
    )
  })

  it('appends the dream lock rule to an existing gitignore without touching its other lines, and never duplicates it', async () => {
    const gitignorePath = join(dir, '.gitignore')
    await mkdir(dir, { recursive: true })
    await writeFile(gitignorePath, "# a person's own hand-edited rule\nnode_modules\n", 'utf8')

    await ensureMemoryTree(paths)
    const once = await readFile(gitignorePath, 'utf8')
    expect(once).toBe("# a person's own hand-edited rule\nnode_modules\ndreams/.lock\n")

    await ensureMemoryTree(paths)
    const twice = await readFile(gitignorePath, 'utf8')
    expect(twice).toBe(once)
  })

  it('commitMemory leaves the working tree clean with a dream lock present', async () => {
    await ensureMemoryTree(paths)
    const lockPath = join(paths.dreamsDir, '.lock')
    await writeFile(lockPath, JSON.stringify({ ts: new Date().toISOString(), pid: 1 }), 'utf8')

    // Mirrors the real sequence: executeDream's commitMemory runs while the
    // lock still exists (release happens afterward, in maybeDream's
    // finally), so the commit that matters is the one made with the lock
    // present. Deleting it afterward is what releaseDreamLock does next.
    const committedWithLock = await commitMemory(paths.root, 'dream: 2026-08-24')
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
    const paths = memoryPaths(dir)
    expect(paths.journalDir).toBe(join(dir, 'journal'))
    expect(paths.journaling).toBe(join(dir, 'journaling.md'))
  })

  it('ensureMemoryTree creates the journal directory', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    expect(await pathExists(paths.journalDir)).toBe(true)
  })

  it('ensureMemoryTree does not seed journaling.md, unlike the constitution', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    expect(await pathExists(paths.constitution)).toBe(true)
    expect(await pathExists(paths.journaling)).toBe(false)
  })

  it('running ensureMemoryTree twice never creates journaling.md on its own', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await ensureMemoryTree(paths)
    expect(await pathExists(paths.journaling)).toBe(false)
  })
})
