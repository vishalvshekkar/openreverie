// Proves the defect fix from
// docs/superpowers/specs/2026-08-27-hostable-engine-design.md (P0-2's
// neighbor task): MemoryEngine can be constructed and used with no
// filesystem at all. MemoryEngine.open's own comment used to claim a
// filesystem-free host "works with the paths-based functions directly"
// instead of constructing a MemoryEngine, which was wrong: packages/core
// (agent.ts, context.ts) depends on MemoryEngine itself, so such a host
// still needs a real one. MemoryEngine.fromPaths is the constructor that
// makes that possible, and this test is its acceptance criterion.
//
// The stores are the in-memory FileStore/AppendOnlyStore from
// memoryStore.ts (P0-1), and the database is better-sqlite3's own
// :memory: mode through MemoryIndex.open (P0-2). :memory: still goes
// through the native module, which is fine: this test exists to prove the
// seam MemoryEngine.fromPaths exposes (any MemoryStores, any SqlDatabase),
// not to prove better-sqlite3 is absent from the process. A Cloudflare
// Durable Object would supply its own SqlDatabase over ctx.storage.sql
// instead, through MemoryIndex.fromDatabase.

import { FakeChatProvider, FakeEmbeddingProvider } from '@openreverie/providers'
import { describe, expect, it } from 'vitest'
import { newId, writeDocumentAtomic } from './documents.js'
import { type EngineDeps, MemoryEngine } from './engine.js'
import { memoryStores } from './memoryStore.js'
import { memoryPaths } from './paths.js'
import { MemoryIndex } from './sqlite.js'

function hostlessDeps(): EngineDeps {
  return {
    chat: new FakeChatProvider([]),
    embeddings: new FakeEmbeddingProvider(),
    reflectionModel: 'fake-reflect',
    embeddingModel: 'fake-embed',
    timezone: 'UTC',
  }
}

describe('MemoryEngine.fromPaths with no filesystem', () => {
  it('writes a document, indexes it, and finds it again by search, using only in-memory stores and an in-memory database', async () => {
    const paths = memoryPaths('/reverie', memoryStores())
    const index = MemoryIndex.open(':memory:')

    // maintenance: false: this proof is about the construction seam, not
    // about exercising reflection/rollup machinery, and a fresh :memory:
    // database has schemaRebuilt === false (nothing to migrate), so
    // nothing here relies on the maintenance-time reindex either.
    const engine = await MemoryEngine.fromPaths(paths, index, hostlessDeps(), {
      maintenance: false,
    })

    try {
      const docId = newId('realm')
      await writeDocumentAtomic(paths.files, {
        path: `${paths.realmsDir}/hostless-proof.md`,
        meta: { id: docId, name: 'Hostless Proof' },
        body: 'A realm page proving the engine runs with no filesystem at all, only in-memory stores and an in-memory database.',
      })

      // The write alone proves nothing about search: reindexAll is the
      // step that turns the file on the (in-memory) folder into rows in
      // the (in-memory) index, exactly as it does for the self-hosted
      // path. This is the "index it" leg of the round trip.
      await engine.reindexAll()

      const result = await engine.search('in-memory database')
      const found = result.documents.find((hit) => hit.docId === docId)
      expect(found).toBeDefined()
      expect(found?.snippet).toContain('in-memory database')
    } finally {
      await engine.close()
    }
  })
})

// fromPaths is the entry point a filesystem-free host calls directly,
// never through open(): open() validates deps.timezone itself, but that
// alone would leave a Durable Object caller (which never goes through
// open()) with no check at all. These prove fromPaths carries its own
// guard rather than relying on open() to have already run one.
describe('MemoryEngine.fromPaths timezone validation', () => {
  it('rejects a deps.timezone that is not a recognized IANA zone', async () => {
    const paths = memoryPaths('/reverie-bad-zone', memoryStores())
    const index = MemoryIndex.open(':memory:')
    await expect(
      MemoryEngine.fromPaths(
        paths,
        index,
        { ...hostlessDeps(), timezone: 'Not/AZone' },
        { maintenance: false },
      ),
    ).rejects.toThrow('deps.timezone is not a valid IANA timezone')
  })

  // Same reasoning as the malformed-zone case, but for the case AGENTS.md
  // records this codebase actually getting wrong before (2026-08-24): a
  // check whose tests covered a field being absent but not present and
  // empty. isValidIanaTimeZone treats '' as invalid; this exercises that
  // through fromPaths specifically, not just through the helper directly.
  it('rejects an empty-string deps.timezone', async () => {
    const paths = memoryPaths('/reverie-empty-zone', memoryStores())
    const index = MemoryIndex.open(':memory:')
    await expect(
      MemoryEngine.fromPaths(
        paths,
        index,
        { ...hostlessDeps(), timezone: '' },
        { maintenance: false },
      ),
    ).rejects.toThrow('deps.timezone is not a valid IANA timezone')
  })
})
