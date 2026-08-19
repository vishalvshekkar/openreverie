import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'
import { loadProfile } from './profile.js'
import { isValidIanaTimeZone } from './time.js'

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
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('index.db\n*.tmp-*\n')
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
