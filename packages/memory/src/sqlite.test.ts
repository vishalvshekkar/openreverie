import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeEmbeddingProvider } from '@openreverie/providers'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Document } from './documents.js'
import type { GraphState } from './graph.js'
import { type DocKind, type EmbedFn, INDEX_SCHEMA_VERSION, MemoryIndex } from './sqlite.js'

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
  return async (texts: string[]) => {
    const { vectors } = await provider.embed('fake-model', texts)
    return vectors
  }
}

const FIXED_MTIME = '2026-01-01T00:00:00.000Z'

// A thin wrapper matching upsertDocument's pre-P0-6 test call shape (doc,
// kind, embed): embeddingModel and mtime default to fixed values so the
// many existing calls below, none of which care about either, do not each
// need their own. embeddingModel defaults to 'fake-model' to match what
// embedFn's provider.embed call above actually uses.
function upsertDoc(
  index: MemoryIndex,
  doc: Document,
  kind: DocKind,
  embed: EmbedFn,
  embeddingModel = 'fake-model',
  mtime = FIXED_MTIME,
): Promise<void> {
  return index.upsertDocument(doc, kind, embed, embeddingModel, mtime)
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
      await upsertDoc(index, doc(), 'realm', embedFn())
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
      await upsertDoc(index, doc(), 'realm', embedFn())

      const hits = index.searchText('deadlines', 10)
      expect(hits.length).toBe(1)
      expect(hits[0]?.docId).toBe('realm_1')
      expect(hits[0]?.path).toBe('/memory/realms/work.md')
      expect(hits[0]?.kind).toBe('realm')
      expect(hits[0]?.snippet.length).toBeGreaterThan(0)
    })

    it('returns the chunk verbatim rather than a 12-token window around the match', async () => {
      // The match sits in the middle of a single paragraph (one chunk) with
      // a marker word more than 12 tokens away on each side. FTS5's own
      // snippet(chunks_fts, 0, '', '', '...', 12) would clip both markers
      // out, since it renders only the 12 tokens surrounding the match.
      // This is the exact defect: a chunk matched by the FTS lane must
      // reach the caller as its full text, not that window.
      const filler = Array.from({ length: 16 }, (_, i) => `filler${i}`).join(' ')
      const body = `startmarker ${filler} targetword ${filler} endmarker`
      await upsertDoc(index, doc({ meta: { id: 'realm_full_chunk' }, body }), 'realm', embedFn())

      const hits = index.searchText('targetword', 10)
      expect(hits.length).toBe(1)
      expect(hits[0]?.snippet).toBe(body)
      expect(hits[0]?.snippet).toContain('startmarker')
      expect(hits[0]?.snippet).toContain('endmarker')
    })

    it('ranks a document mentioning the term repeatedly above one mentioning it once', async () => {
      await upsertDoc(
        index,
        doc({
          meta: { id: 'realm_dense' },
          body: 'Marathon training. Marathon pace. Marathon nutrition and marathon recovery.',
        }),
        'realm',
        embedFn(),
      )
      await upsertDoc(
        index,
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
      await upsertDoc(index, doc({ body: 'Talking about a guitar hobby.' }), 'realm', embedFn())
      expect(index.searchText('guitar', 10).length).toBe(1)

      await upsertDoc(index, doc({ body: 'Talking about a marathon instead.' }), 'realm', embedFn())

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

      await upsertDoc(index, summaryDoc, 'summary', embedFn())

      const anxiousHits = index.searchText('anxious', 10)
      expect(anxiousHits.length).toBe(1)
      expect(anxiousHits[0]?.snippet).toContain('item_aaa')

      const runHits = index.searchText('run', 10)
      expect(runHits.length).toBe(1)
    })

    it("anchors a summary item's stated eventTime to the document's own date, never a resolved instant", async () => {
      const summaryDoc = doc({
        meta: {
          id: 'summary_2',
          date: '2026-08-16',
          items: [
            {
              id: 'item_ccc',
              text: 'Watching Zephyrquest',
              ts: '2026-08-16',
              kind: 'intention',
              eventTime: 'tonight',
            },
          ],
        },
        body: 'A short summary paragraph.',
      })

      await upsertDoc(index, summaryDoc, 'summary', embedFn())

      // searchText's snippet is the chunk's own verbatim text, so it
      // carries both the match and the date anchor together regardless of
      // where in the chunk the matched word sits.
      const hits = index.searchText('tonight', 10)
      expect(hits.length).toBe(1)
      const snippet = hits[0]?.snippet ?? ''
      // The person's own words, anchored to the date the record was made,
      // not resolved into any kind of timestamp. Guards against a clock
      // time appended in ANY shape, not only "date-T-time" ISO 8601 (a
      // narrower `/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/` guard here would pass
      // vacuously against, say, "as stated on 2026-08-16 at 19:25": no T,
      // so it slips through, but it is exactly the resolved instant the
      // spec forbids). The eventTime fixture above ("tonight") and the
      // docDate ("2026-08-16") both contain no HH:MM-shaped substring, so
      // this general check is safe against them and only fires on a
      // fabricated clock time appended by the code under test.
      expect(snippet).toContain('tonight')
      expect(snippet).toContain('2026-08-16')
      expect(snippet).not.toMatch(/\d{1,2}:\d{2}/)

      const titleHits = index.searchText('Zephyrquest', 10)
      expect(titleHits.length).toBe(1)
    })

    it('leaves a summary item with no eventTime chunked exactly as before, no anchor text at all', async () => {
      const summaryDoc = doc({
        meta: {
          id: 'summary_3',
          date: '2026-08-16',
          items: [
            { id: 'item_ddd', text: 'Went for a long walk', ts: '2026-08-16', kind: 'event' },
          ],
        },
        body: 'A short summary paragraph.',
      })

      await upsertDoc(index, summaryDoc, 'summary', embedFn())

      const hits = index.searchText('walk', 10)
      expect(hits.length).toBe(1)
      const snippet = hits[0]?.snippet ?? ''
      expect(snippet).not.toContain('stated')
      expect(snippet).not.toContain('eventTime')
    })

    it('removeDocument deletes the document and its chunks', async () => {
      await upsertDoc(index, doc(), 'realm', embedFn())
      expect(index.searchText('work', 10).length).toBe(1)

      index.removeDocument('realm_1')

      expect(index.searchText('work', 10).length).toBe(0)
    })

    it('searchText tolerates an empty query and punctuation without throwing', async () => {
      await upsertDoc(
        index,
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
      await upsertDoc(
        index,
        doc({ meta: { id: 'realm_kite' }, body: 'A note about kite surfing.' }),
        'realm',
        embedFn(),
      )
      await upsertDoc(
        index,
        doc({ meta: { id: 'summary_kite' }, body: 'A note about kite surfing.' }),
        'summary',
        embedFn(),
      )

      const hits = index.searchText('kite', 10, ['summary'])
      expect(hits.map((h) => h.docId)).toEqual(['summary_kite'])
    })

    it('searchText treats an explicit empty kinds list as matching nothing', async () => {
      await upsertDoc(
        index,
        doc({ meta: { id: 'realm_kite2' }, body: 'A note about kite surfing.' }),
        'realm',
        embedFn(),
      )

      expect(index.searchText('kite', 10, [])).toEqual([])
    })

    it('ORs terms so a realistic twelve-token natural-language query still finds the chunk (defect 5, A2)', async () => {
      // Regression for defect 5 (docs/superpowers/plans/2026-08-24-recall-and-event-time-fixes.md,
      // Unit A): toFtsQuery used to AND every whitespace-separated term, so a
      // natural-language query of 10 to 15 tokens matched zero chunks
      // against a ~100-character chunk. This is the shape the model actually
      // writes per the search_memory tool description ("in plain
      // language"), so this must stay non-empty for this exact kind of
      // query, not just a short keyword one.
      const summaryDoc = doc({
        meta: {
          id: 'summary_natural',
          date: '2026-08-20',
          items: [
            {
              id: 'item_natural',
              text: 'Tickets are booked with Arjun for Nightfall on Sunday, 23 Aug 2026 at 6:45pm.',
              ts: '2026-08-20',
              kind: 'event',
            },
          ],
        },
        body: 'A short summary paragraph.',
      })
      await upsertDoc(index, summaryDoc, 'summary', embedFn())

      // 12 tokens, the length named in the plan.
      const query = 'What day and time is the Nightfall booking with Arjun actually for?'
      const hits = index.searchText(query, 10)
      expect(hits.length).toBeGreaterThan(0)
      expect(hits.map((h) => h.docId)).toContain('summary_natural')
    })

    it('still ranks the document matching more OR-ed terms above one matching fewer', async () => {
      await upsertDoc(
        index,
        doc({
          meta: { id: 'doc_more_terms' },
          body: 'Nightfall tickets booked with Arjun for Sunday night showtime plans.',
        }),
        'realm',
        embedFn(),
      )
      await upsertDoc(
        index,
        doc({ meta: { id: 'doc_fewer_terms' }, body: 'Arjun mentioned Nightfall once in passing.' }),
        'realm',
        embedFn(),
      )

      const hits = index.searchText(
        'Nightfall tickets booked with Arjun for Sunday night showtime plans',
        10,
      )
      expect(hits.length).toBe(2)
      expect(hits[0]?.docId).toBe('doc_more_terms')
      expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? Number.POSITIVE_INFINITY)
    })

    it('a stopword-only or punctuation-only query does not throw and stays within the requested limit', async () => {
      await upsertDoc(
        index,
        doc({ body: 'The quick brown fox and a fast dog were in the yard.' }),
        'realm',
        embedFn(),
      )

      expect(() => index.searchText('the of and is', 5)).not.toThrow()
      expect(index.searchText('the of and is', 5).length).toBeLessThanOrEqual(5)

      expect(() => index.searchText('!!! ??? ...', 5)).not.toThrow()
      expect(index.searchText('!!! ??? ...', 5)).toEqual([])
    })

    it('searchText and searchVector both carry the chunk position within its document (A4 identity)', async () => {
      const summaryDoc = doc({
        meta: {
          id: 'summary_seq',
          items: [
            { id: 'item_first', text: 'Kayak trip notes, first item.' },
            { id: 'item_second', text: 'Kayak trip notes, second item.' },
          ],
        },
        body: '',
      })
      await upsertDoc(index, summaryDoc, 'summary', embedFn())

      const textHits = index.searchText('kayak trip notes', 10)
      expect(textHits.map((h) => h.seq).sort()).toEqual([0, 1])

      const provider = new FakeEmbeddingProvider()
      const {
        vectors: [queryVec],
      } = await provider.embed('fake-model', ['kayak trip notes'])
      if (!queryVec) throw new Error('expected a query vector')
      const vectorHits = await index.searchVector(queryVec, 10)
      expect(vectorHits.map((h) => h.seq).sort()).toEqual([0, 1])
    })

    it('searchText treats a kinds value containing a quote as an ordinary bound value, not SQL syntax', async () => {
      await upsertDoc(
        index,
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

    it('stores a date span for dated kinds and nulls for living ones', async () => {
      await upsertDoc(
        index,
        doc({ meta: { id: 'doc_daily', date: '2026-08-12' } }),
        'rollup_daily',
        embedFn(),
      )
      await upsertDoc(
        index,
        doc({ meta: { id: 'doc_weekly', week: '2026-W33' } }),
        'rollup_weekly',
        embedFn(),
      )
      await upsertDoc(
        index,
        doc({ meta: { id: 'doc_arc', opened: '2026-01-04', updated: '2026-08-12' } }),
        'arc',
        embedFn(),
      )

      const db = new Database(dbPath)
      const rows = db
        .prepare('SELECT id, date_start, date_end FROM documents ORDER BY id')
        .all() as { id: string; date_start: string | null; date_end: string | null }[]
      db.close()

      expect(rows).toEqual([
        { id: 'doc_arc', date_start: null, date_end: null },
        { id: 'doc_daily', date_start: '2026-08-12', date_end: '2026-08-12' },
        { id: 'doc_weekly', date_start: '2026-08-10', date_end: '2026-08-16' },
      ])
    })

    it('searchText carries the document date span on the hit for a dated document (A3)', async () => {
      await upsertDoc(
        index,
        doc({
          meta: { id: 'doc_dated', date: '2026-08-12' },
          body: 'A dated summary about kayaking.',
        }),
        'summary',
        embedFn(),
      )

      const hits = index.searchText('kayaking', 10)
      expect(hits.length).toBe(1)
      expect(hits[0]?.dateStart).toBe('2026-08-12')
      expect(hits[0]?.dateEnd).toBe('2026-08-12')
    })

    it('searchText leaves the date span absent, not guessed, for a living document (A3)', async () => {
      // opened and updated are set here on purpose, not left off: an arc
      // fixture with neither field can never distinguish "documentDateSpan
      // correctly returns null for a living document" from "there was
      // nothing to derive a span from anyway." Setting both, to two
      // different dates, means a mutation that started deriving a span
      // from either field would have real values to fabricate a span out
      // of, and this test would catch it.
      await upsertDoc(
        index,
        doc({
          meta: { id: 'doc_living', opened: '2026-06-01', updated: '2026-08-18' },
          body: 'A living arc page about kayaking.',
        }),
        'arc',
        embedFn(),
      )

      const hits = index.searchText('kayaking', 10)
      expect(hits.length).toBe(1)
      expect(hits[0]?.dateStart).toBeUndefined()
      expect(hits[0]?.dateEnd).toBeUndefined()
      expect('dateStart' in (hits[0] ?? {})).toBe(false)
    })
  })

  describe('removeDocumentsAtPath', () => {
    it('deletes any other row at the same path, keeping only the given id, so a path collision self-heals', async () => {
      const path = '/memory/realms/collide.md'
      await upsertDoc(
        index,
        doc({
          meta: { id: 'realm_stale' },
          path,
          body: 'Collision term appears in the stale doc.',
        }),
        'realm',
        embedFn(),
      )
      await upsertDoc(
        index,
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
      await upsertDoc(index, doc(), 'realm', embedFn())

      index.removeDocumentsAtPath('/memory/realms/work.md', 'realm_1')

      expect(index.searchText('work', 10).length).toBe(1)
    })
  })

  describe('wipeAllDocuments', () => {
    it('clears documents, chunks, chunks_fts, and embeddings, leaving the index empty but usable', async () => {
      await upsertDoc(index, doc(), 'realm', embedFn())
      expect(index.searchText('work', 10).length).toBe(1)

      index.wipeAllDocuments()

      expect(index.searchText('work', 10)).toEqual([])

      const provider = new FakeEmbeddingProvider()
      const {
        vectors: [queryVec],
      } = await provider.embed('fake-model', ['work'])
      if (!queryVec) throw new Error('expected a query vector')
      expect(await index.searchVector(queryVec, 5)).toEqual([])

      // The index must still be usable after a wipe: the manual
      // chunks_fts 'rebuild' sync must not have broken future upserts.
      await upsertDoc(index, doc(), 'realm', embedFn())
      expect(index.searchText('work', 10).length).toBe(1)
    })
  })

  describe('searchVector', () => {
    it('ranks an exact-text vector match above unrelated documents', async () => {
      const provider = new FakeEmbeddingProvider()
      const embed = async (texts: string[]) => {
        const { vectors } = await provider.embed('fake-model', texts)
        return vectors
      }

      await upsertDoc(
        index,
        doc({ meta: { id: 'realm_a' }, body: 'The quick brown fox jumps over the lazy dog.' }),
        'realm',
        embed,
      )
      await upsertDoc(
        index,
        doc({ meta: { id: 'realm_b' }, body: 'Completely unrelated content about tax filings.' }),
        'realm',
        embed,
      )

      const {
        vectors: [queryVec],
      } = await provider.embed('fake-model', ['The quick brown fox jumps over the lazy dog.'])
      if (!queryVec) {
        throw new Error('expected a query vector')
      }

      const hits = await index.searchVector(queryVec, 5)
      expect(hits.length).toBe(2)
      expect(hits[0]?.docId).toBe('realm_a')
      expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0)
    })

    it('returns the chunk verbatim rather than truncating it at 200 characters', async () => {
      const provider = new FakeEmbeddingProvider()
      const embed = async (texts: string[]) => {
        const { vectors } = await provider.embed('fake-model', texts)
        return vectors
      }

      // Well past makeSnippet's old 200-character cutoff, and past that
      // cutoff with content that survives to the end, "trailingmarker".
      const filler = Array.from({ length: 40 }, (_, i) => `filler${i}`).join(' ')
      const body = `${filler} trailingmarker`
      await upsertDoc(index, doc({ meta: { id: 'realm_long' }, body }), 'realm', embed)

      const {
        vectors: [queryVec],
      } = await provider.embed('fake-model', [body])
      if (!queryVec) {
        throw new Error('expected a query vector')
      }

      const hits = await index.searchVector(queryVec, 5)
      expect(hits.length).toBe(1)
      expect(body.length).toBeGreaterThan(200)
      expect(hits[0]?.snippet).toBe(body)
      expect(hits[0]?.snippet).toContain('trailingmarker')
      expect(hits[0]?.snippet.endsWith('...')).toBe(false)
    })

    it('applies a kinds filter at the SQL level', async () => {
      const provider = new FakeEmbeddingProvider()
      const embed = async (texts: string[]) => {
        const { vectors } = await provider.embed('fake-model', texts)
        return vectors
      }

      await upsertDoc(
        index,
        doc({ meta: { id: 'realm_fox' }, body: 'The quick brown fox jumps over the lazy dog.' }),
        'realm',
        embed,
      )
      await upsertDoc(
        index,
        doc({ meta: { id: 'summary_fox' }, body: 'The quick brown fox jumps over the lazy dog.' }),
        'summary',
        embed,
      )

      const {
        vectors: [queryVec],
      } = await provider.embed('fake-model', ['The quick brown fox jumps over the lazy dog.'])
      if (!queryVec) {
        throw new Error('expected a query vector')
      }

      const hits = await index.searchVector(queryVec, 5, ['summary'])
      expect(hits.map((h) => h.docId)).toEqual(['summary_fox'])
    })

    it('rejects a stored vector whose dims does not match the query vector, rather than comparing a truncated prefix (P0-6)', async () => {
      const embed8: EmbedFn = async (texts) => texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0])
      const embed4: EmbedFn = async (texts) => texts.map(() => [1, 0, 0, 0])

      await upsertDoc(
        index,
        doc({ meta: { id: 'dims_8' }, body: 'Eight dimensional embedding model.' }),
        'realm',
        embed8,
        'model-a-8dim',
      )
      await upsertDoc(
        index,
        doc({ meta: { id: 'dims_4' }, body: 'Four dimensional embedding model.' }),
        'realm',
        embed4,
        'model-b-4dim',
      )

      // Shaped like the 8-dim model's output. Without the dims guard,
      // cosineSimilarity's Math.min(a.length, b.length) would compare only
      // the first four components of both vectors, and the 4-dim
      // document's stored [1, 0, 0, 0] would score a perfect match against
      // this query's own first four components, also [1, 0, 0, 0].
      const queryVec = [1, 0, 0, 0, 0, 0, 0, 0]

      const hits = await index.searchVector(queryVec, 5)
      expect(hits.map((h) => h.docId)).toEqual(['dims_8'])
    })

    it('treats an explicit empty kinds list as matching nothing', async () => {
      const provider = new FakeEmbeddingProvider()
      const embed = async (texts: string[]) => {
        const { vectors } = await provider.embed('fake-model', texts)
        return vectors
      }

      await upsertDoc(
        index,
        doc({ meta: { id: 'realm_fox2' }, body: 'The quick brown fox jumps over the lazy dog.' }),
        'realm',
        embed,
      )

      const {
        vectors: [queryVec],
      } = await provider.embed('fake-model', ['The quick brown fox jumps over the lazy dog.'])
      if (!queryVec) {
        throw new Error('expected a query vector')
      }

      expect(await index.searchVector(queryVec, 5, [])).toEqual([])
    })

    it('treats a kinds value containing a quote as an ordinary bound value, not SQL syntax', async () => {
      const provider = new FakeEmbeddingProvider()
      const embed = async (texts: string[]) => {
        const { vectors } = await provider.embed('fake-model', texts)
        return vectors
      }

      await upsertDoc(
        index,
        doc({ meta: { id: 'realm_fox3' }, body: 'The quick brown fox jumps over the lazy dog.' }),
        'realm',
        embed,
      )

      const {
        vectors: [queryVec],
      } = await provider.embed('fake-model', ['The quick brown fox jumps over the lazy dog.'])
      if (!queryVec) {
        throw new Error('expected a query vector')
      }

      // Not a real DocKind, but proves the value is bound as a parameter:
      // if it were ever string-interpolated into the query it would break
      // the SQL (unbalanced quote) or, worse, silently widen the match.
      const maliciousKinds = ["realm' OR '1'='1"] as unknown as DocKind[]

      await expect(index.searchVector(queryVec, 5, maliciousKinds)).resolves.toEqual([])
    })

    it('carries the document date span on the hit for a dated document, absent for a living one (A3)', async () => {
      const provider = new FakeEmbeddingProvider()
      const embed = async (texts: string[]) => {
        const { vectors } = await provider.embed('fake-model', texts)
        return vectors
      }

      await upsertDoc(
        index,
        doc({
          meta: { id: 'doc_dated_vec', date: '2026-08-12' },
          body: 'A dated summary about rafting.',
        }),
        'summary',
        embed,
      )
      await upsertDoc(
        index,
        doc({ meta: { id: 'doc_living_vec' }, body: 'A living arc page about rafting.' }),
        'arc',
        embed,
      )

      const {
        vectors: [queryVec],
      } = await provider.embed('fake-model', ['rafting'])
      if (!queryVec) {
        throw new Error('expected a query vector')
      }

      const hits = await index.searchVector(queryVec, 5)
      const dated = hits.find((h) => h.docId === 'doc_dated_vec')
      const living = hits.find((h) => h.docId === 'doc_living_vec')
      expect(dated?.dateStart).toBe('2026-08-12')
      expect(dated?.dateEnd).toBe('2026-08-12')
      expect(living?.dateStart).toBeUndefined()
      expect(living?.dateEnd).toBeUndefined()
      expect('dateStart' in (living ?? {})).toBe(false)
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

  describe('searchNodes', () => {
    function graphWith(
      nodes: { id: string; type: string; label: string; doc?: string; ts: string }[],
    ) {
      return {
        nodes: new Map(
          nodes.map((n) => [
            n.id,
            { id: n.id, type: n.type, label: n.label, ...(n.doc ? { doc: n.doc } : {}), ts: n.ts },
          ]),
        ),
        edges: new Map(),
      } as unknown as GraphState
    }

    it('matches by case-folded substring and orders by match quality then recency', () => {
      index.replaceGraph(
        graphWith([
          { id: 'person_1', type: 'person', label: 'Renata', ts: '2026-08-01T00:00:00.000Z' },
          {
            id: 'person_2',
            type: 'person',
            label: 'Nicolette',
            ts: '2026-08-02T00:00:00.000Z',
          },
          { id: 'person_3', type: 'person', label: 'col', ts: '2026-07-01T00:00:00.000Z' },
          { id: 'entity_1', type: 'entity', label: 'Unrelated', ts: '2026-08-03T00:00:00.000Z' },
        ]),
      )

      const hits = index.searchNodes('col', 10)
      // Exact label match first, then the prefix match, then the mid-word
      // substring match. "Unrelated" does not match at all.
      expect(hits.map((h) => h.id)).toEqual(['person_3', 'person_1', 'person_2'])
    })

    it('drops short tokens unless the whole query is one token', () => {
      index.replaceGraph(
        graphWith([
          { id: 'person_1', type: 'person', label: 'Jo', ts: '2026-08-01T00:00:00.000Z' },
          { id: 'person_2', type: 'person', label: 'Anderson', ts: '2026-08-02T00:00:00.000Z' },
        ]),
      )

      // A single short token is kept: a two-letter nickname is a real name.
      expect(index.searchNodes('jo', 10).map((h) => h.id)).toEqual(['person_1'])
      // In a multi-token query the short token is dropped, so only
      // "anderson" is matched and Jo does not come back.
      expect(index.searchNodes('jo anderson', 10).map((h) => h.id)).toEqual(['person_2'])
    })

    it('returns every node type, with the page path when there is one, and honours the limit', () => {
      index.replaceGraph(
        graphWith([
          {
            id: 'arc_1',
            type: 'arc',
            label: 'Kayaking',
            doc: '/memory/arcs/kayaking.md',
            ts: '2026-08-01T00:00:00.000Z',
          },
          { id: 'item_1', type: 'item', label: 'Kayaking again', ts: '2026-08-02T00:00:00.000Z' },
          { id: 'entity_1', type: 'entity', label: 'Kayaks Inc', ts: '2026-08-03T00:00:00.000Z' },
        ]),
      )

      const hits = index.searchNodes('kayaking', 10)
      expect(hits.map((h) => h.type).sort()).toEqual(['arc', 'item'])
      expect(hits.find((h) => h.id === 'arc_1')?.doc).toBe('/memory/arcs/kayaking.md')
      expect(hits.find((h) => h.id === 'item_1')?.doc).toBeNull()
      expect(index.searchNodes('kayaking', 1)).toHaveLength(1)
    })

    it('returns nothing for a query with no usable tokens', () => {
      index.replaceGraph(
        graphWith([
          { id: 'person_1', type: 'person', label: 'Jo', ts: '2026-08-01T00:00:00.000Z' },
        ]),
      )
      expect(index.searchNodes('   ', 10)).toEqual([])
      expect(index.searchNodes('a b', 10)).toEqual([])
    })
  })

  describe('schema version', () => {
    it('marks a fresh database as current, not rebuilt', () => {
      expect(index.schemaRebuilt).toBe(false)
      const db = new Database(dbPath)
      expect(db.pragma('user_version', { simple: true })).toBe(INDEX_SCHEMA_VERSION)
      db.close()
    })

    it('drops and recreates the derived document tables when the stored version is behind', async () => {
      await upsertDoc(index, doc(), 'realm', embedFn())
      expect(index.searchText('work', 10).length).toBeGreaterThan(0)
      index.close()

      const db = new Database(dbPath)
      db.pragma('user_version = 1')
      db.close()

      const reopened = MemoryIndex.open(dbPath)
      expect(reopened.schemaRebuilt).toBe(true)
      // Derived rows are gone, and the table is present and queryable
      // rather than missing: an empty result, not a throw.
      expect(reopened.searchText('work', 10)).toEqual([])
      reopened.close()

      // Opening again finds the version current and does not rebuild.
      const third = MemoryIndex.open(dbPath)
      expect(third.schemaRebuilt).toBe(false)
      third.close()

      index = MemoryIndex.open(dbPath)
    })

    it('creates the date span columns on the documents table', () => {
      const db = new Database(dbPath)
      const columns = (db.pragma('table_info(documents)') as { name: string }[]).map((c) => c.name)
      db.close()
      expect(columns).toContain('date_start')
      expect(columns).toContain('date_end')
    })
  })
})
