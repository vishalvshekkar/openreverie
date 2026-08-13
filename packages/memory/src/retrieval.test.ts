import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeEmbeddingProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Document } from './documents.js'
import { searchMemory } from './retrieval.js'
import { type EmbedFn, MemoryIndex } from './sqlite.js'

const MODEL = 'fake-model'

function doc(overrides: Partial<Document> = {}): Document {
  return {
    path: '/memory/realms/work.md',
    meta: { id: 'doc_1' },
    body: 'Filler body text.',
    ...overrides,
  }
}

function embedFn(provider: FakeEmbeddingProvider): EmbedFn {
  return (texts: string[]) => provider.embed(MODEL, texts)
}

describe('searchMemory', () => {
  let dir: string
  let dbPath: string
  let index: MemoryIndex
  let embeddings: FakeEmbeddingProvider

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-retrieval-'))
    dbPath = join(dir, 'index.db')
    index = MemoryIndex.open(dbPath)
    embeddings = new FakeEmbeddingProvider()
  })

  afterEach(async () => {
    index.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('ranks a doc that tops both the text and vector lists above a doc that only tops one', async () => {
    const query = 'marathon training discipline'

    // Exact match to the query: guaranteed rank 1 in text search (matches
    // all three query words) and rank 1 in vector search (cosine similarity
    // 1.0 against the query embedding, since FakeEmbeddingProvider is
    // deterministic per exact string).
    await index.upsertDocument(
      doc({ meta: { id: 'doc_both' }, body: query }),
      'realm',
      embedFn(embeddings),
    )

    // Shares only one of the three query words. The FTS query is an
    // implicit AND over all terms, so this document never matches the
    // text search at all: it can only surface through the vector list.
    await index.upsertDocument(
      doc({
        meta: { id: 'doc_one_list' },
        body: 'A long unrelated reflection about something else, discipline mentioned once quietly.',
      }),
      'realm',
      embedFn(embeddings),
    )

    const hits = await searchMemory(index, embeddings, MODEL, query)

    expect(hits.length).toBe(2)
    expect(hits[0]?.docId).toBe('doc_both')
    expect(hits[1]?.docId).toBe('doc_one_list')
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? Number.POSITIVE_INFINITY)
  })

  it('excludes hits whose kind is not in the filter', async () => {
    const query = 'guitar lessons'

    await index.upsertDocument(
      doc({ meta: { id: 'doc_realm' }, body: query }),
      'realm',
      embedFn(embeddings),
    )
    await index.upsertDocument(
      doc({ meta: { id: 'doc_summary' }, body: query }),
      'summary',
      embedFn(embeddings),
    )

    const hits = await searchMemory(index, embeddings, MODEL, query, { kinds: ['realm'] })

    expect(hits.map((h) => h.docId)).toEqual(['doc_realm'])
  })

  it('kinds filter reaches matches that fall outside the top-20 candidate windows', async () => {
    const query = 'quarterly budget review'

    // 21 kind-A docs, each an exact-text match to the query: guaranteed
    // top score in both text search (matches all three query words with
    // nothing else competing for term frequency) and vector search
    // (cosine similarity 1.0, since FakeEmbeddingProvider is deterministic
    // per exact string). This fills the CANDIDATE_LIMIT=20 window in both
    // lists entirely with kind-A docs, before any filtering happens.
    for (let i = 0; i < 21; i++) {
      await index.upsertDocument(
        doc({ meta: { id: `doc_a_${i}` }, body: query }),
        'realm',
        embedFn(embeddings),
      )
    }

    // A handful of kind-B docs that still match the query (all three
    // words present, so they pass the FTS AND), but padded with enough
    // extra text that both their FTS rank and their vector cosine
    // similarity are lower than every kind-A doc above. Before the fix,
    // these fall outside both top-20 windows and searchMemory silently
    // returns zero results for kinds: ['other']; after the fix, the kinds
    // filter is applied inside the index before the windows are built, so
    // these are the only candidates considered and all three come back.
    const bIds = ['doc_b_0', 'doc_b_1', 'doc_b_2']
    for (const id of bIds) {
      await index.upsertDocument(
        doc({
          meta: { id },
          body: `${query} mentioned briefly amid a long stretch of unrelated padding text added specifically to dilute both the term frequency and the vector similarity well below every exact-match kind-A document seeded above.`,
        }),
        'summary',
        embedFn(embeddings),
      )
    }

    const hits = await searchMemory(index, embeddings, MODEL, query, { kinds: ['summary'] })

    expect(hits.map((h) => h.docId).sort()).toEqual(bIds)
  })

  it('respects the limit even when more documents match', async () => {
    const query = 'kayaking trip photos'

    for (let i = 0; i < 5; i++) {
      await index.upsertDocument(
        doc({ meta: { id: `doc_${i}` }, body: `${query} number ${i}` }),
        'realm',
        embedFn(embeddings),
      )
    }

    const hits = await searchMemory(index, embeddings, MODEL, query, undefined, 2)

    expect(hits.length).toBe(2)
  })

  it('defaults the limit to 8', async () => {
    const query = 'lighthouse keeper journal'

    for (let i = 0; i < 10; i++) {
      await index.upsertDocument(
        doc({ meta: { id: `doc_${i}` }, body: `${query} entry ${i}` }),
        'realm',
        embedFn(embeddings),
      )
    }

    const hits = await searchMemory(index, embeddings, MODEL, query)

    expect(hits.length).toBe(8)
  })

  it('filters by date encoded in the path when present, and passes hits through when it is not', async () => {
    const query = 'quiet morning walk'

    // Daily rollups are written to rollups/daily/<date>.md, so the date is
    // recoverable from the filename.
    await index.upsertDocument(
      doc({
        meta: { id: 'doc_early' },
        body: query,
        path: '/memory/rollups/daily/2026-01-01.md',
      }),
      'rollup_daily',
      embedFn(embeddings),
    )
    await index.upsertDocument(
      doc({
        meta: { id: 'doc_late' },
        body: query,
        path: '/memory/rollups/daily/2026-08-01.md',
      }),
      'rollup_daily',
      embedFn(embeddings),
    )
    // Session summaries carry their date in the parent directory
    // (sessions/<date>-<sessionId>/summary.md), not the filename.
    await index.upsertDocument(
      doc({
        meta: { id: 'doc_session' },
        body: query,
        path: '/memory/sessions/2026-07-01-abc123/summary.md',
      }),
      'summary',
      embedFn(embeddings),
    )
    // A kind whose path has no recoverable date. It has no date to compare,
    // so an after/before filter never excludes it.
    await index.upsertDocument(
      doc({ meta: { id: 'doc_undated' }, body: query, path: '/memory/realms/undated.md' }),
      'realm',
      embedFn(embeddings),
    )
    // A decoy: a date-like substring appears in an ancestor directory, but
    // that segment does not start with it, so it must not be read as the
    // document's date. Without the segment-start anchor this would be
    // wrongly excluded by the after filter below.
    await index.upsertDocument(
      doc({
        meta: { id: 'doc_decoy' },
        body: query,
        path: '/memory/backup-2024-01-01/realms/notes.md',
      }),
      'realm',
      embedFn(embeddings),
    )

    const hits = await searchMemory(index, embeddings, MODEL, query, { after: '2026-06-01' })

    expect(hits.map((h) => h.docId).sort()).toEqual([
      'doc_decoy',
      'doc_late',
      'doc_session',
      'doc_undated',
    ])
  })

  it('does not let a document with many matching chunks in one list outrank a document that tops both lists', async () => {
    const query = 'quiet lake cabin'

    // Tops both lists outright: single chunk, exact match to the query.
    await index.upsertDocument(
      doc({ meta: { id: 'doc_both' }, body: query }),
      'realm',
      embedFn(embeddings),
    )

    // Six chunks, each sharing only one of the three query words, so none
    // of them match the FTS query (an implicit AND over all terms): this
    // document is absent from the text list entirely. Before fusion
    // dedupes each list by docId first, its six vector-list appearances
    // would each contribute a reciprocal-rank term, letting it outscore
    // doc_both even though doc_both is the only document that genuinely
    // tops both lists.
    await index.upsertDocument(
      doc({
        meta: {
          id: 'doc_many_chunks',
          items: [
            { id: 'item_1', text: 'A quiet street, nothing else notable.' },
            { id: 'item_2', text: 'Somewhere a lake was mentioned in passing.' },
            { id: 'item_3', text: 'A cabin came up briefly in conversation.' },
            { id: 'item_4', text: 'It was quiet all afternoon.' },
            { id: 'item_5', text: 'The lake again, just a mention.' },
            { id: 'item_6', text: 'Another cabin, unrelated to the first.' },
          ],
        },
        body: '',
      }),
      'summary',
      embedFn(embeddings),
    )

    const hits = await searchMemory(index, embeddings, MODEL, query)

    expect(hits.length).toBe(2)
    expect(hits[0]?.docId).toBe('doc_both')
    expect(hits[1]?.docId).toBe('doc_many_chunks')
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? Number.POSITIVE_INFINITY)
  })

  it('dedupes a document that appears in both lists, keeping one hit', async () => {
    const query = 'sailing lesson notes'

    await index.upsertDocument(
      doc({ meta: { id: 'doc_dup' }, body: query }),
      'realm',
      embedFn(embeddings),
    )

    const hits = await searchMemory(index, embeddings, MODEL, query)

    expect(hits.length).toBe(1)
    expect(hits[0]?.docId).toBe('doc_dup')
  })
})
