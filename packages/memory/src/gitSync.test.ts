// These tests only ever run git inside a fs.mkdtemp sandbox. Never point
// commitMemory at the repository this test file lives in.

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commitMemory } from './gitSync.js'

const run = promisify(execFile)

async function revCount(dir: string): Promise<number> {
  const { stdout } = await run('git', ['rev-list', '--count', 'HEAD'], { cwd: dir })
  return Number.parseInt(stdout.trim(), 10)
}

describe('commitMemory', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-gitsync-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('initializes a repo and makes the first commit', async () => {
    await writeFile(join(dir, 'note.md'), 'first note\n', 'utf8')

    const result = await commitMemory(dir, 'initial commit')

    expect(result).toEqual({ ok: true })
    expect(await revCount(dir)).toBe(1)
  })

  it('is ok when a second call has nothing new to commit', async () => {
    await writeFile(join(dir, 'note.md'), 'first note\n', 'utf8')
    await commitMemory(dir, 'initial commit')

    const result = await commitMemory(dir, 'nothing changed')

    expect(result).toEqual({ ok: true })
    expect(await revCount(dir)).toBe(1)
  })

  it('commits again when a file changes', async () => {
    await writeFile(join(dir, 'note.md'), 'first note\n', 'utf8')
    await commitMemory(dir, 'initial commit')

    await writeFile(join(dir, 'note.md'), 'updated note\n', 'utf8')
    const result = await commitMemory(dir, 'second commit')

    expect(result).toEqual({ ok: true })
    expect(await revCount(dir)).toBe(2)
  })

  it('returns ok false with a warning when the root does not exist', async () => {
    const notADir = join(dir, 'missing-root')

    const result = await commitMemory(notADir, 'irrelevant')

    expect(result.ok).toBe(false)
    expect(result.warning).toBeTruthy()
  })

  it('returns ok false with a warning when the root is a file, not a directory', async () => {
    const filePath = join(dir, 'not-a-dir')
    await writeFile(filePath, 'this is a file, not a memory root\n', 'utf8')

    const result = await commitMemory(filePath, 'irrelevant')

    expect(result.ok).toBe(false)
    expect(result.warning).toBeTruthy()
  })

  it('never throws, returning ok false with a warning when git itself fails', async () => {
    // A .git that is a plain file (not a directory) makes `git init` fail
    // with "invalid gitfile format" instead of succeeding.
    await writeFile(join(dir, '.git'), 'not a real git dir\n', 'utf8')

    const result = await commitMemory(dir, 'irrelevant')

    expect(result.ok).toBe(false)
    expect(result.warning).toBeTruthy()
  })
})
