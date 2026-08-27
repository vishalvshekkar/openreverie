// Conformance suite for the two store implementations from store.ts: the
// same battery of operations run against NodeFileStore/NodeAppendStore and
// MemoryFileStore/MemoryAppendStore, so a caller written against FileStore
// and AppendOnlyStore cannot tell them apart. This is the "behaves
// identically to the Node one" proof P0-1 asks for, not a nicety: it is
// what makes the in-memory store safe to stand in for Node anywhere in the
// engine, in tests or in a host with no filesystem.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryAppendStore, MemoryFileStore } from './memoryStore.js'
import { NodeAppendStore, NodeFileStore } from './nodeStore.js'
import type { AppendOnlyStore, FileStore } from './store.js'

interface Fixture {
  name: string
  makeFiles: () => Promise<{ files: FileStore; root: string; cleanup: () => Promise<void> }>
  makeLogs: () => Promise<{ logs: AppendOnlyStore; root: string; cleanup: () => Promise<void> }>
}

const fixtures: Fixture[] = [
  {
    name: 'node',
    makeFiles: async () => {
      const root = await mkdtemp(join(tmpdir(), 'openreverie-filestore-'))
      return {
        files: new NodeFileStore(),
        root,
        cleanup: () => rm(root, { recursive: true, force: true }),
      }
    },
    makeLogs: async () => {
      const root = await mkdtemp(join(tmpdir(), 'openreverie-appendstore-'))
      return {
        logs: new NodeAppendStore(),
        root,
        cleanup: () => rm(root, { recursive: true, force: true }),
      }
    },
  },
  {
    name: 'memory',
    makeFiles: async () => ({
      files: new MemoryFileStore(),
      root: '/memory-root',
      cleanup: async () => {},
    }),
    makeLogs: async () => ({
      logs: new MemoryAppendStore(),
      root: '/memory-root',
      cleanup: async () => {},
    }),
  },
]

describe.each(fixtures)('FileStore ($name)', ({ makeFiles }) => {
  let files: FileStore
  let root: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    ;({ files, root, cleanup } = await makeFiles())
  })

  afterEach(async () => {
    await cleanup()
  })

  it('writeFile then readFile round-trips the exact bytes', async () => {
    const path = join(root, 'note.md')
    await files.writeFile(path, 'hello\nworld\n')
    await expect(files.readFile(path)).resolves.toBe('hello\nworld\n')
  })

  it('readFile on a path that was never written rejects with ENOENT', async () => {
    const path = join(root, 'missing.md')
    await expect(files.readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writeFile leaves no .tmp- file behind and overwrites cleanly on a second write', async () => {
    const dir = join(root, 'dir')
    const path = join(dir, 'note.md')
    await files.mkdir(dir)
    await files.writeFile(path, 'first\n')
    await files.writeFile(path, 'second\n')
    await expect(files.readFile(path)).resolves.toBe('second\n')
    const entries = await files.readdir(dir)
    expect(entries).toEqual(['note.md'])
  })

  it('mkdir is recursive and idempotent', async () => {
    const dir = join(root, 'a', 'b', 'c')
    await files.mkdir(dir)
    await files.mkdir(dir) // second call must not throw
    expect(await files.exists(dir)).toBe(true)
  })

  it('readdir lists entries written under a directory, in sorted order regardless of write order', async () => {
    const dir = join(root, 'listed')
    await files.mkdir(dir)
    // Written out of alphabetical order on purpose: FileStore.readdir's
    // contract (store.ts) is sorted output, not "whatever order the entries
    // happened to be created or stored in". Node's own fs.readdir order is
    // OS-dependent, so this is the case that would catch NodeFileStore
    // silently falling back to that unsorted order (see nodeStore.ts).
    // Comparing directly, without a normalizing .sort() on the result here,
    // is the whole point: a .sort() on both sides would make this pass even
    // if one implementation's real order disagreed with the other's.
    await files.writeFile(join(dir, 'b.md'), 'b')
    await files.writeFile(join(dir, 'c.md'), 'c')
    await files.writeFile(join(dir, 'a.md'), 'a')
    const entries = await files.readdir(dir)
    expect(entries).toEqual(['a.md', 'b.md', 'c.md'])
  })

  it('readdir on a directory that was never created rejects with ENOENT', async () => {
    await expect(files.readdir(join(root, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stat on a missing file rejects with ENOENT; on a written file reports its size', async () => {
    const path = join(root, 'sized.md')
    await expect(files.stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await files.writeFile(path, 'exactly ten')
    const info = await files.stat(path)
    expect(info.size).toBe(Buffer.byteLength('exactly ten', 'utf8'))
    expect(typeof info.mtimeMs).toBe('number')
  })

  it('exists is false before a write and true after', async () => {
    const path = join(root, 'maybe.md')
    expect(await files.exists(path)).toBe(false)
    await files.writeFile(path, 'now it is')
    expect(await files.exists(path)).toBe(true)
  })

  it('rename moves a file so the old path no longer exists and the new path holds its content', async () => {
    const from = join(root, 'from.md')
    const to = join(root, 'to.md')
    await files.writeFile(from, 'moved content')
    await files.rename(from, to)
    expect(await files.exists(from)).toBe(false)
    await expect(files.readFile(to)).resolves.toBe('moved content')
  })

  it('rm removes a file; rm on a missing file rejects', async () => {
    const path = join(root, 'gone.md')
    await files.writeFile(path, 'x')
    await files.rm(path)
    expect(await files.exists(path)).toBe(false)
    await expect(files.rm(path)).rejects.toBeTruthy()
  })
})

describe.each(fixtures)('AppendOnlyStore ($name)', ({ makeLogs }) => {
  let logs: AppendOnlyStore
  let root: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    ;({ logs, root, cleanup } = await makeLogs())
  })

  afterEach(async () => {
    await cleanup()
  })

  it('readAll on a path never created or appended to returns an empty array', async () => {
    await expect(logs.readAll(join(root, 'nowhere.jsonl'))).resolves.toEqual([])
  })

  it('create makes readAll return an empty array rather than throwing, and is idempotent', async () => {
    const path = join(root, 'created.jsonl')
    await logs.create(path)
    await expect(logs.readAll(path)).resolves.toEqual([])
    await logs.create(path) // second call must not throw or clear anything appended since
    await logs.appendLines(path, ['one'])
    await logs.create(path)
    await expect(logs.readAll(path)).resolves.toEqual(['one'])
  })

  it('appendLines then readAll round-trips lines without a trailing newline on any of them', async () => {
    const path = join(root, 'log.jsonl')
    await logs.appendLines(path, ['{"a":1}', '{"a":2}'])
    await logs.appendLines(path, ['{"a":3}'])
    const lines = await logs.readAll(path)
    expect(lines).toEqual(['{"a":1}', '{"a":2}', '{"a":3}'])
    for (const line of lines) expect(line.endsWith('\n')).toBe(false)
  })

  it('appendLines with an empty array appends nothing and does not create the file', async () => {
    const path = join(root, 'untouched.jsonl')
    await logs.appendLines(path, [])
    await expect(logs.readAll(path)).resolves.toEqual([])
  })

  it('appendLines on a path never created still creates it, matching node:fs appendFile', async () => {
    const path = join(root, 'auto-created.jsonl')
    await logs.appendLines(path, ['first'])
    await expect(logs.readAll(path)).resolves.toEqual(['first'])
  })

  it('readRange returns a slice starting at the given 0-based index', async () => {
    const path = join(root, 'range.jsonl')
    await logs.appendLines(path, ['a', 'b', 'c', 'd'])
    await expect(logs.readRange(path, 0, 1)).resolves.toEqual(['a'])
    await expect(logs.readRange(path, 1, 2)).resolves.toEqual(['b', 'c'])
    await expect(logs.readRange(path, 3, 5)).resolves.toEqual(['d'])
  })

  it('readRange on a path never created returns an empty array', async () => {
    await expect(logs.readRange(join(root, 'nowhere.jsonl'), 0, 1)).resolves.toEqual([])
  })

  it('readRange with count 0 returns an empty array without touching the file', async () => {
    const path = join(root, 'zero.jsonl')
    await logs.appendLines(path, ['a'])
    await expect(logs.readRange(path, 0, 0)).resolves.toEqual([])
  })
})

// The append-only guarantee: these two classes must expose exactly
// {create, appendLines, readAll, readRange} and nothing else, so that a
// module holding only an AppendOnlyStore (graph.ts, proposals.ts,
// dreamLog.ts, transcripts.ts's transcript.jsonl handling) has no write,
// rename, or rm to reach for even by accident. This is an allow-list
// check, not a check for the absence of specific bad names, per AGENTS.md's
// fail-closed rule: any method added to either class shows up here.
//
// Falsified 2026-08-27: added a `rewrite(path: string, lines: string[])`
// method to NodeAppendStore in nodeStore.ts (a plausible-looking helper
// that would let a caller replace a log's contents wholesale) and reran
// this test. It failed with the actual method set including 'rewrite',
// which is exactly the property this test exists to catch. The method was
// then removed and this test passes again.
describe('AppendOnlyStore surface (append-only guard)', () => {
  const expectedMethods = ['appendLines', 'create', 'readAll', 'readRange'].sort()

  it('NodeAppendStore exposes exactly the append-only methods, no write/rename/rm', () => {
    const methods = ownMethodNames(new NodeAppendStore())
    expect(methods).toEqual(expectedMethods)
  })

  it('MemoryAppendStore exposes exactly the append-only methods, no write/rename/rm', () => {
    const methods = ownMethodNames(new MemoryAppendStore())
    expect(methods).toEqual(expectedMethods)
  })
})

function ownMethodNames(instance: object): string[] {
  const proto = Object.getPrototypeOf(instance)
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .sort()
}
