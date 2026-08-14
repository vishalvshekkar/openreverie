import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeEmbeddingProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Document } from './documents.js'
import type { GraphState } from './graph.js'
import { type DocKind, type EmbedFn, MemoryIndex } from './sqlite.js'

function doc(overrides: Partial<Document> = {}): Document {
  return {
    path: '/memory/realms/work.md',
    meta: { id: 'realm_1' },
    body: 'This is a paragraph about work.\n\nThis is a second paragraph about deadlines.',
    ...overrides,
  }
}

function embedFn(): EmbedFn {
  const provider = new FakeEmbeddingProvider()
  return (texts: string[]) => provider.embed('fake-model', texts)
}

describe('MemoryIndex', () => {
  let dir: string
  let dbPath: string
  let index: MemoryIndex

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-sqlite-'))
    dbPath = join(dir, 'index.db')
    index = MemoryIndex.open(dbPath)
  })

  afterEach(async () => {
    index.close()
    await rm(dir, { recursive: true, force: true })
  })

  describe('open', () => {
    it('creates the schema on a fresh path', () => {
      // Schema creation must not throw and basic queries must succeed.
      expect(index.searchText('anything', 10)).toEqual([])
      expect(index.nodeById('missing')).toBeUndefined()
    })

    it('reuses an existing database on reopen, preserving data', async () => {
      await index.upsertDocument(doc(), 'realm', embedFn())
      index.close()

      const reopened = MemoryIndex.open(dbPath)
      const hits = reopened.searchText('work', 10)
      expect(hits.length).toBeGreaterThan(0)
      reopened.close()
      // Reassign so afterEach's index.close() does not double-close.
      index = MemoryIndex.open(dbPath)
    })
  })

  describe('upsertDocument and searchText', () => {
    it('finds an upserted document by text with a snippet', async () => {
      await index.upsertDocument(doc(), 'realm', embedFn())

      const hits = index.searchText('deadlines', 10)
      expect(hits.length).toBe(1)
      expect(hits[0]?.docId).toBe('realm_1')
      expect(hits[0]?.path).toBe('/memory/realms/work.md')
      expect(hits[0]?.kind).toBe('realm')
      expect(hits[0]?.snippet.length).toBeGreaterThan(0)
    })

    it('ranks a document mentioning the term repeatedly above one mentioning it once', async () => {
      await index.upsertDocument(
        doc({
          meta: { id: 'realm_dense' },
          body: 'Marathon training. Marathon pace. Marathon nutrition and marathon recovery.',
        }),
        'realm',
        embedFn(),
      )
      await index.upsertDocument(
        doc({ meta: { id: 'realm_sparse' }, body: 'A brief mention of a marathon.' }),
        'realm',
        embedFn(),
      )

      const hits = index.searchText('marathon', 10)
      expect(hits.length).toBe(2)
      expect(hits[0]?.docId).toBe('realm_dense')
      expect(hits[0]?.score).toBeGreaterThanOrEqual(hits[1]?.score ?? Number.POSITIVE_INFINITY)
    })

    it('re-upsert with a changed body drops stale hits', async () => {
      await index.upsertDocument(doc({ body: 'Talking about a guitar hobby.' }), 'realm', embedFn())
      expect(index.searchText('guitar', 10).length).toBe(1)

      await index.upsertDocument(
        doc({ body: 'Talking about a marathon instead.' }),
        'realm',
        embedFn(),
      )

      expect(index.searchText('guitar', 10).length).toBe(0)
      expect(index.searchText('marathon', 10).length).toBe(1)
    })

    it('indexes summary items as one chunk each, prefixed with the item id', async () => {
      const summaryDoc = doc({
        meta: {
          id: 'summary_1',
          items: [
            {
              id: 'item_aaa',
              text: 'Felt anxious about the deadline',
              ts: '2026-08-01',
              kind: 'feeling',
            },
            { id: 'item_bbb', text: 'Went for a long run', ts: '2026-08-01', kind: 'event' },
          ],
        },
        body: 'A short summary paragraph.',
      })

      await index.upsertDocument(summaryDoc, 'summary', embedFn())

      const anxiousHits = index.searchText('anxious', 10)
      expect(anxiousHits.length).toBe(1)
      expect(anxiousHits[0]?.snippet).toContain('item_aaa')

      const runHits = index.searchText('run', 10)
      expect(runHits.length).toBe(1)
    })

    it('removeDocument deletes the document and its chunks', async () => {
      await index.upsertDocument(doc(), 'realm', embedFn())
      expect(index.searchText('work', 10).length).toBe(1)

      index.removeDocument('realm_1')

      expect(index.searchText('work', 10).length).toBe(0)
    })

    it('searchText tolerates an empty query and punctuation without throwing', async () => {
      await index.upsertDocument(
        doc({ body: "Don't forget the foo-bar release notes." }),
        'realm',
        embedFn(),
      )

      expect(index.searchText('', 10)).toEqual([])
      expect(index.searchText('   ', 10)).toEqual([])
      expect(() => index.searchText("don't", 10)).not.toThrow()
      expect(() => index.searchText('foo-bar', 10)).not.toThrow()
    })

    it('searchText applies a kinds filter at the SQL level', async () => {
      await index.upsertDocument(
        doc({ meta: { id: 'realm_kite' }, body: 'A note about kite surfing.' }),
        'realm',
        embedFn(),
      )
      await index.upsertDocument(
        doc({ meta: { id: 'summary_kite' }, body: 'A note about kite surfing.' }),
        'summary',
        embedFn(),
      )

      const hits = index.searchText('kite', 10, ['summary'])
      expect(hits.map((h) => h.docId)).toEqual(['summary_kite'])
    })

    it('searchText treats an explicit empty kinds list as matching nothing', async () => {
      await index.upsertDocument(
        doc({ meta: { id: 'realm_kite2' }, body: 'A note about kite surfing.' }),
        'realm',
        embedFn(),
      )

      expect(index.searchText('kite', 10, [])).toEqual([])
    })

    it('searchText treats a kinds value containing a quote as an ordinary bound value, not SQL syntax', async () => {
      await index.upsertDocument(
        doc({ meta: { id: 'realm_kite3' }, body: 'A note about kite surfing.' }),
        'realm',
        embedFn(),
      )

      // Not a real DocKind, but proves the value is bound as a parameter:
      // if it were ever string-interpolated into the query it would break
      // the SQL (unbalanced quote) or, worse, silently widen the match.
      const maliciousKinds = ["realm' OR '1'='1"] as unknown as DocKind[]

      expect(() => index.searchText('kite', 10, maliciousKinds)).not.toThrow()
      expect(index.searchText('kite', 10, maliciousKinds)).toEqual([])
    })
  })

  describe('removeDocumentsAtPath', () => {
    it('deletes any other row at the same path, keeping only the given id, so a path collision self-heals', async () => {
      const path = '/memory/realms/collide.md'
      await index.upsertDocument(
        doc({
          meta: { id: 'realm_stale' },
          path,
          body: 'Collision term appears in the stale doc.',
        }),
        'realm',
        embedFn(),
      )
      await index.upsertDocument(
        doc({
          meta: { id: 'realm_fresh' },
          path,
          body: 'Collision term appears in the fresh doc.',
        }),
        'realm',
        embedFn(),
      )
      // upsertDocument alone is keyed by id, not path: both rows coexist
      // until something explicitly reconciles the path.
      expect(
        index
          .searchText('collision', 10)
          .map((h) => h.docId)
          .sort(),
      ).toEqual(['realm_fresh', 'realm_stale'])

      index.removeDocumentsAtPath(path, 'realm_fresh')

      const hits = index.searchText('collision', 10)
      expect(hits.length).toBe(1)
      expect(hits.map((h) => h.docId)).toEqual(['realm_fresh'])
    })

    it('does nothing when the given id is the only row at the path', async () => {
      await index.upsertDocument(doc(), 'realm', embedFn())

      index.removeDocumentsAtPath('/memory/realms/work.md', 'realm_1')

      expect(index.searchText('work', 10).length).toBe(1)
    })
  })

  describe('wipeAllDocuments', () => {
    it('clears documents, chunks, chunks_fts, and embeddings, leaving the index empty but usable', async () => {
      await index.upsertDocument(doc(), 'realm', embedFn())
      expect(index.searchText('work', 10).length).toBe(1)

      index.wipeAllDocuments()

      expect(index.searchText('work', 10)).toEqual([])

      const provider = new FakeEmbeddingProvider()
      const [queryVec] = await provider.embed('fake-model', ['work'])
      if (!queryVec) throw new Error('expected a query vector')
      expect(await index.searchVector(queryVec, 5)).toEqual([])

      // The index must still be usable after a wipe: the manual
      // chunks_fts 'rebuild' sync must not have broken future upserts.
      await index.upsertDocument(doc(), 'realm', embedFn())
      expect(index.searchText('work', 10).length).toBe(1)
    })
  })

  describe('searchVector', () => {
    it('ranks an exact-text vector match above unrelated documents', async () => {
      const provider = new FakeEmbeddingProvider()
      const embed = (texts: string[]) => provider.embed('fake-model', texts)

      await index.upsertDocument(
        doc({ meta: { id: 'realm_a' }, body: 'The quick brown fox jumps over the lazy dog.' }),
        'realm',
        embed,
      )
      await index.upsertDocument(
        doc({ meta: { id: 'realm_b' }, body: 'Completely unrelated content about tax filings.' }),
        'realm',
        embed,
      )

      const [queryVec] = await provider.embed('fake-model', [
        'The quick brown fox jumps over the lazy dog.',
      ])
      if (!queryVec) {
        throw new Error('expected a query vector')
      }

      const hits = await index.searchVector(queryVec, 5)
      expect(hits.length).toBe(2)
      expect(hits[0]?.docId).toBe('realm_a')
      expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0)
    })

    it('applies a kinds filter at the SQL level', async () => {
      const provider = new FakeEmbeddingProvider()
      const embed = (texts: string[]) => provider.embed('fake-model', texts)

      await index.upsertDocument(
        doc({ meta: { id: 'realm_fox' }, body: 'The quick brown fox jumps over the lazy dog.' }),
        'realm',
        embed,
      )
      await index.upsertDocument(
        doc({ meta: { id: 'summary_fox' }, body: 'The quick brown fox jumps over the lazy dog.' }),
        'summary',
        embed,
      )

      const [queryVec] = await provider.embed('fake-model', [
        'The quick brown fox jumps over the lazy dog.',
      ])
      if (!queryVec) {
        throw new Error('expected a query vector')
      }

      const hits = await index.searchVector(queryVec, 5, ['summary'])
      expect(hits.map((h) => h.docId)).toEqual(['summary_fox'])
    })

    it('treats an explicit empty kinds list as matching nothing', async () => {
      const provider = new FakeEmbeddingProvider()
      const embed = (texts: string[]) => provider.embed('fake-model', texts)

      await index.upsertDocument(
        doc({ meta: { id: 'realm_fox2' }, body: 'The quick brown fox jumps over the lazy dog.' }),
        'realm',
        embed,
      )

      const [queryVec] = await provider.embed('fake-model', [
        'The quick brown fox jumps over the lazy dog.',
      ])
      if (!queryVec) {
        throw new Error('expected a query vector')
      }

      expect(await index.searchVector(queryVec, 5, [])).toEqual([])
    })

    it('treats a kinds value containing a quote as an ordinary bound value, not SQL syntax', async () => {
      const provider = new FakeEmbeddingProvider()
      const embed = (texts: string[]) => provider.embed('fake-model', texts)

      await index.upsertDocument(
        doc({ meta: { id: 'realm_fox3' }, body: 'The quick brown fox jumps over the lazy dog.' }),
        'realm',
        embed,
      )

      const [queryVec] = await provider.embed('fake-model', [
        'The quick brown fox jumps over the lazy dog.',
      ])
      if (!queryVec) {
        throw new Error('expected a query vector')
      }

      // Not a real DocKind, but proves the value is bound as a parameter:
      // if it were ever string-interpolated into the query it would break
      // the SQL (unbalanced quote) or, worse, silently widen the match.
      const maliciousKinds = ["realm' OR '1'='1"] as unknown as DocKind[]

      await expect(index.searchVector(queryVec, 5, maliciousKinds)).resolves.toEqual([])
    })
  })

  describe('graph tables', () => {
    function sampleGraph(): GraphState {
      const nodes = new Map()
      nodes.set('person_1', {
        id: 'person_1',
        type: 'person',
        label: 'Alex',
        ts: '2026-08-01T00:00:00Z',
      })
      nodes.set('item_1', {
        id: 'item_1',
        type: 'item',
        label: 'Ran a marathon',
        ts: '2026-08-01T00:00:00Z',
      })
      nodes.set('arc_1', {
        id: 'arc_1',
        type: 'arc',
        label: 'Marathon training',
        ts: '2026-08-01T00:00:00Z',
      })
      nodes.set('realm_1', {
        id: 'realm_1',
        type: 'realm',
        label: 'Fitness',
        ts: '2026-08-01T00:00:00Z',
      })

      const edges = new Map()
      edges.set('part_of:item_1:arc_1', {
        edge: 'part_of',
        from: 'item_1',
        to: 'arc_1',
        confidence: 0.9,
        confirmed: true,
        ts: '2026-08-01T00:00:00Z',
      })
      edges.set('in:arc_1:realm_1', {
        edge: 'in',
        from: 'arc_1',
        to: 'realm_1',
        confidence: 0.9,
        confirmed: true,
        ts: '2026-08-01T00:00:00Z',
      })
      edges.set('involves:item_1:person_1', {
        edge: 'involves',
        from: 'item_1',
        to: 'person_1',
        confidence: 0.8,
        confirmed: false,
        ts: '2026-08-01T00:00:00Z',
      })
      // Dangling edge: 'missing_node' does not exist in nodes.
      edges.set('relates_to:item_1:missing_node', {
        edge: 'relates_to',
        from: 'item_1',
        to: 'missing_node',
        confidence: 0.5,
        confirmed: false,
        ts: '2026-08-01T00:00:00Z',
      })

      return { nodes, edges }
    }

    it('folds nodes and edges, skipping edges with missing endpoints', () => {
      index.replaceGraph(sampleGraph())

      expect(index.nodeById('item_1')?.label).toBe('Ran a marathon')
      expect(index.nodeById('missing_node')).toBeUndefined()

      const neighborsOfItem = index.neighbors('item_1')
      const neighborIds = neighborsOfItem.map((n) => n.node.id).sort()
      expect(neighborIds).toEqual(['arc_1', 'person_1'])
    })

    it('itemsInArc returns items linked to the arc by part_of', () => {
      index.replaceGraph(sampleGraph())

      const items = index.itemsInArc('arc_1')
      expect(items.map((n) => n.id)).toEqual(['item_1'])
    })

    it('arcsInvolvingPerson returns arcs reached through an involved item', () => {
      index.replaceGraph(sampleGraph())

      const arcs = index.arcsInvolvingPerson('person_1')
      expect(arcs.map((n) => n.id)).toEqual(['arc_1'])
    })

    it('replaceGraph wipes prior state before reloading', () => {
      index.replaceGraph(sampleGraph())
      expect(index.nodeById('person_1')).toBeDefined()

      const nodes = new Map()
      nodes.set('realm_2', {
        id: 'realm_2',
        type: 'realm',
        label: 'Solo realm',
        ts: '2026-08-02T00:00:00Z',
      })
      index.replaceGraph({ nodes, edges: new Map() })

      expect(index.nodeById('person_1')).toBeUndefined()
      expect(index.nodeById('realm_2')?.label).toBe('Solo realm')
    })
  })
})
