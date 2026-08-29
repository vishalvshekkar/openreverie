// Proves NodeFileStore.writeFile still does exactly what documents.ts's
// writeDocumentAtomic used to do inline before P0-1 moved the mechanics
// here: write the full content to a sibling temp file named
// `<path>.tmp-<ulid>`, then rename it onto the real path. A caller that
// reads mid-write only ever sees the old contents or the new ones, never a
// partial file, because the temp file is invisible under the final name
// until the rename completes.
//
// This mocks node:fs/promises' writeFile and rename to record the exact
// arguments nodeStore.ts passes them, then delegates to the real
// implementation so the write actually happens on disk. A test that only
// checked the end state (final file has the right bytes, no .tmp- file
// left over, see memoryStore.test.ts) would pass even if writeFile wrote
// straight to the final path with no temp file at all; only intercepting
// the calls themselves proves the mechanism, not just its outcome.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls: { fn: string; args: unknown[] }[] = []
// When set, readdir returns this instead of delegating to the real
// node:fs/promises readdir. This is what lets the readdir-order test below
// assert the sort happens in NodeFileStore itself, rather than depending on
// which order this machine's own filesystem happens to hand back today
// (macOS/APFS observed returning already-sorted names for a small
// directory in this repo's own sandbox, which would make a real-filesystem
// version of that test pass whether or not NodeFileStore sorts at all).
let readdirOverride: string[] | undefined

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      calls.push({ fn: 'writeFile', args })
      return actual.writeFile(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      calls.push({ fn: 'rename', args })
      return actual.rename(...args)
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (readdirOverride !== undefined) return readdirOverride
      return actual.readdir(...args)
    },
  }
})

const { NodeFileStore } = await import('./nodeStore.js')

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

describe('NodeFileStore.writeFile atomic write mechanics', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openreverie-atomic-'))
    calls.length = 0
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes the temp file named <path>.tmp-<ulid>, then renames it onto path, in that order', async () => {
    const files = new NodeFileStore()
    const path = join(root, 'doc.md')

    await files.writeFile(path, 'body text\n')

    expect(calls.map((c) => c.fn)).toEqual(['writeFile', 'rename'])
    const tmpPathWritten = calls[0]?.args[0] as string
    const renameArgs = calls[1]?.args as [string, string]

    // Same temp naming documents.ts's writeDocumentAtomic used before P0-1
    // moved it here verbatim: `${path}.tmp-${ulid()}`, a 26-character
    // Crockford base32 ulid suffix.
    expect(tmpPathWritten).toMatch(new RegExp(`^${escapeRegExp(path)}\\.tmp-[0-9A-Z]{26}$`))
    expect(renameArgs[0]).toBe(tmpPathWritten)
    expect(renameArgs[1]).toBe(path)

    await expect(files.readFile(path)).resolves.toBe('body text\n')
  })

  it('gives every write a distinct temp file name', async () => {
    const files = new NodeFileStore()
    const path = join(root, 'doc.md')

    await files.writeFile(path, 'first\n')
    const firstTmp = calls[0]?.args[0]
    calls.length = 0
    await files.writeFile(path, 'second\n')
    const secondTmp = calls[0]?.args[0]

    expect(firstTmp).not.toBe(secondTmp)
  })
})

describe('NodeFileStore.readFile', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openreverie-readfile-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  // store.ts's FileStore.readFile comment documents this as a contract:
  // journal.ts and profile.ts both catch a readFile rejection and only
  // treat it as "file does not exist" when err.code === 'ENOENT'. The
  // conformance suite in memoryStore.test.ts already runs this same
  // assertion against NodeFileStore (via describe.each), so this is not
  // new coverage; it exists here too because a reader of this file, which
  // exercises NodeFileStore's other behaviors directly, should not have to
  // go looking in memoryStore.test.ts to find the one that matters most.
  it('readFile on a path that was never written rejects with ENOENT', async () => {
    const files = new NodeFileStore()
    const path = join(root, 'missing.md')
    await expect(files.readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('NodeFileStore.readdir sorts its result', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openreverie-readdir-order-'))
    readdirOverride = undefined
  })

  afterEach(async () => {
    readdirOverride = undefined
    await rm(root, { recursive: true, force: true })
  })

  // node:fs/promises' own readdir order is unspecified and OS-dependent
  // (see store.ts's FileStore.readdir comment for the sorted-order
  // contract this satisfies). readdirOverride stands in for whatever raw
  // order a real filesystem might hand back, deliberately not sorted, so
  // this proves NodeFileStore imposes the order itself rather than
  // happening to agree with a real filesystem that is already sorted.
  it('sorts entries even when the underlying fs.readdir returns them out of order', async () => {
    readdirOverride = ['c.md', 'a.md', 'b.md']
    const files = new NodeFileStore()
    await expect(files.readdir(root)).resolves.toEqual(['a.md', 'b.md', 'c.md'])
  })
})
