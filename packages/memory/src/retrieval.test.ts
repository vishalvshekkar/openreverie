import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeEmbeddingProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Document } from './documents.js'
import { fuseByReciprocalRank, searchMemory } from './retrieval.js'
import { type EmbedFn, MemoryIndex, type SearchHit } from './sqlite.js'

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

    const hits = (await searchMemory(index, embeddings, MODEL, query)).documents

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

    const hits = (await searchMemory(index, embeddings, MODEL, query, { kinds: ['realm'] }))
      .documents

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

    const hits = (await searchMemory(index, embeddings, MODEL, query, { kinds: ['summary'] }))
      .documents

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

    const hits = (await searchMemory(index, embeddings, MODEL, query, undefined, 2)).documents

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

    const hits = (await searchMemory(index, embeddings, MODEL, query)).documents

    expect(hits.length).toBe(8)
  })

  it('excludes a dated document outside the range, and returns it when unfiltered', async () => {
    const query = 'quiet morning walk'

    await index.upsertDocument(
      doc({
        meta: { id: 'doc_may', date: '2026-05-01' },
        body: query,
        path: '/memory/rollups/daily/2026-05-01.md',
      }),
      'rollup_daily',
      embedFn(embeddings),
    )
    await index.upsertDocument(
      doc({
        meta: { id: 'doc_august', date: '2026-08-01' },
        body: query,
        path: '/memory/rollups/daily/2026-08-01.md',
      }),
      'rollup_daily',
      embedFn(embeddings),
    )

    // Unfiltered first. Without this assertion the filtered one below
    // would still pass if the filter were deleted and nothing had ranked.
    const unfiltered = (await searchMemory(index, embeddings, MODEL, query)).documents
    expect(unfiltered.map((h) => h.docId).sort()).toEqual(['doc_august', 'doc_may'])

    const filtered = (await searchMemory(index, embeddings, MODEL, query, { after: '2026-07-01' }))
      .documents
    expect(filtered.map((h) => h.docId)).toEqual(['doc_august'])
  })

  it('never excludes a living document, whatever the date filter says', async () => {
    const query = 'quiet morning walk'

    await index.upsertDocument(
      doc({
        meta: { id: 'doc_may', date: '2026-05-01' },
        body: query,
        path: '/memory/rollups/daily/2026-05-01.md',
      }),
      'rollup_daily',
      embedFn(embeddings),
    )
    // An arc page carries opened and updated, both well outside the range,
    // and still must not be excluded: it has no date span at all.
    await index.upsertDocument(
      doc({
        meta: { id: 'doc_arc', opened: '2026-01-04', updated: '2026-01-20' },
        body: query,
        path: '/memory/arcs/walking.md',
      }),
      'arc',
      embedFn(embeddings),
    )

    const hits = (await searchMemory(index, embeddings, MODEL, query, { after: '2026-07-01' }))
      .documents
    expect(hits.map((h) => h.docId)).toEqual(['doc_arc'])
  })

  it('matches a weekly rollup on span overlap, not on its Monday alone', async () => {
    const query = 'quiet morning walk'

    // 2026-W33 runs Monday 2026-08-10 through Sunday 2026-08-16.
    await index.upsertDocument(
      doc({
        meta: { id: 'doc_week', week: '2026-W33' },
        body: query,
        path: '/memory/rollups/weekly/2026-W33.md',
      }),
      'rollup_weekly',
      embedFn(embeddings),
    )

    const midWeek = (await searchMemory(index, embeddings, MODEL, query, { after: '2026-08-14' }))
      .documents
    expect(midWeek.map((h) => h.docId)).toEqual(['doc_week'])

    const beforeMidWeek = (
      await searchMemory(index, embeddings, MODEL, query, {
        before: '2026-08-11',
      })
    ).documents
    expect(beforeMidWeek.map((h) => h.docId)).toEqual(['doc_week'])

    const afterTheWeek = (
      await searchMemory(index, embeddings, MODEL, query, {
        after: '2026-08-17',
      })
    ).documents
    expect(afterTheWeek.map((h) => h.docId)).toEqual([])
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

    const hits = (await searchMemory(index, embeddings, MODEL, query)).documents

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

    const hits = (await searchMemory(index, embeddings, MODEL, query)).documents

    expect(hits.length).toBe(1)
    expect(hits[0]?.docId).toBe('doc_dup')
  })

  it('returns the matched chunks from a document, best first, not just the single top-ranked one (A4)', async () => {
    // Modeled on the observed failure
    // (docs/superpowers/plans/2026-08-24-recall-and-event-time-fixes.md):
    // one summary carries both a vague, undated version of a fact and the
    // precise, dated one. Before A4, fuseByReciprocalRank kept only the
    // best-ranked chunk's snippet, so whichever of the two ranked worse was
    // dropped from the payload even though the document itself was
    // returned.
    await index.upsertDocument(
      doc({
        meta: {
          id: 'doc_nightfall',
          items: [
            { id: 'item_vague', text: 'Vishal booked tickets to see Nightfall with Arjun.' },
            {
              id: 'item_precise',
              text: 'Tickets are booked with Arjun for Nightfall on Sunday, 23 Aug 2026 at 6:45pm.',
            },
            { id: 'item_unrelated', text: 'Went to the gym in the morning, nothing else notable.' },
          ],
        },
        body: '',
      }),
      'summary',
      embedFn(embeddings),
    )

    const hits = (await searchMemory(index, embeddings, MODEL, 'Nightfall tickets booked with Arjun'))
      .documents

    expect(hits.length).toBe(1)
    expect(hits[0]?.chunks.length).toBeGreaterThan(1)
    expect(hits[0]?.chunks.some((c) => c.includes('6:45pm'))).toBe(true)
    expect(hits[0]?.chunks.some((c) => c.includes('Vishal booked tickets'))).toBe(true)
  })

  it('caps the chunks returned per document and reports the true total rather than truncating silently (A4)', async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      id: `item_${i}`,
      text: `Kayak trip mention number ${i}, kayak kayak kayak.`,
    }))
    await index.upsertDocument(
      doc({ meta: { id: 'doc_many_kayak', items }, body: '' }),
      'summary',
      embedFn(embeddings),
    )

    const hits = (await searchMemory(index, embeddings, MODEL, 'kayak trip mention number'))
      .documents

    expect(hits.length).toBe(1)
    expect(hits[0]?.chunksTotal).toBe(6)
    expect(hits[0]?.chunks.length).toBeLessThan(hits[0]?.chunksTotal ?? 0)
    expect(hits[0]?.chunks.length).toBeGreaterThan(0)
  })

  it('carries a matched chunk to the payload as its full text, not a windowed or truncated rendering (A4 heuristic removal)', async () => {
    // Before this fix, collectChunksByDocId kept whichever of the two
    // lane-rendered strings was longer: the FTS lane's 12-token
    // snippet() window, or the vector lane's 200-character makeSnippet
    // truncation. Neither is the chunk's own text. A marker placed more
    // than 12 tokens from the match, in a chunk well past 200 characters,
    // survives only once the payload carries the chunk verbatim.
    const filler = Array.from({ length: 30 }, (_, i) => `filler${i}`).join(' ')
    const itemText = `startmarker ${filler} targetword ${filler} endmarker`
    await index.upsertDocument(
      doc({
        meta: { id: 'doc_long_chunk', items: [{ id: 'item_long', text: itemText }] },
        body: '',
      }),
      'summary',
      embedFn(embeddings),
    )

    const hits = (await searchMemory(index, embeddings, MODEL, 'targetword')).documents

    expect(hits.length).toBe(1)
    expect(hits[0]?.chunks.length).toBe(1)
    expect(hits[0]?.chunks[0]).toContain('startmarker')
    expect(hits[0]?.chunks[0]).toContain('endmarker')
    expect(hits[0]?.chunks[0]?.length).toBeGreaterThan(200)
  })

  it('returns node matches in their own lane, never fused into the document ranking', async () => {
    const query = 'renata'

    await index.upsertDocument(
      doc({ meta: { id: 'doc_note' }, body: 'A note that mentions renata once.' }),
      'realm',
      embedFn(embeddings),
    )
    index.replaceGraph({
      nodes: new Map([
        [
          'person_renata',
          {
            id: 'person_renata',
            type: 'person' as const,
            label: 'Renata',
            ts: '2026-08-01T00:00:00.000Z',
          },
        ],
      ]),
      edges: new Map(),
    })

    const results = await searchMemory(index, embeddings, MODEL, query)

    expect(results.documents.map((h) => h.docId)).toEqual(['doc_note'])
    expect(results.nodes.map((n) => n.id)).toEqual(['person_renata'])
    // A node hit carries no score field at all: it has no rank in either
    // list and any score given to it for fusion would be fabricated.
    expect(Object.keys(results.nodes[0] ?? {}).sort()).toEqual(['doc', 'id', 'label', 'ts', 'type'])
  })
})

describe('fuseByReciprocalRank recency tiebreak (A6)', () => {
  function chunkHit(overrides: Partial<SearchHit> = {}): SearchHit {
    return {
      docId: 'doc',
      path: '/memory/x.md',
      kind: 'summary',
      snippet: 'x',
      score: 0,
      seq: 0,
      ...overrides,
    }
  }

  it('breaks an exact score tie by recency, the more recent document first', () => {
    // Each hit is rank 1 of its own list and absent from the other list
    // entirely, so both accumulate exactly one contribution of
    // 1 / (RRF_K + 1): a genuine, exact score tie, not an approximation.
    const older = chunkHit({ docId: 'doc_old', dateStart: '2025-01-01', dateEnd: '2025-01-01' })
    const newer = chunkHit({ docId: 'doc_new', dateStart: '2026-08-01', dateEnd: '2026-08-01' })

    const fused = fuseByReciprocalRank([[older], [newer]])

    expect(fused[0]?.score).toBe(fused[1]?.score)
    expect(fused.map((h) => h.docId)).toEqual(['doc_new', 'doc_old'])
  })

  it('sorts a document with no date span after a dated one when scores tie, regardless of input order (Important 2 / 7)', () => {
    // The original version of this test only ran with the undated hit
    // first in the input, which cannot distinguish "declined to compare,
    // arrival order preserved" from "the undated hit was actually sorted
    // to the front": both produce the same output on a single ordering.
    // Running both orderings and asserting the SAME output order is what
    // actually pins the comparator's decision, and closes the gap the
    // review named: this test used to pass even with the promote bug
    // (undated always winning ties) in place, because it only ever
    // exercised the ordering that bug agrees with.
    const living = chunkHit({ docId: 'doc_living', kind: 'arc' })
    const dated = chunkHit({ docId: 'doc_dated', dateStart: '2026-08-01', dateEnd: '2026-08-01' })

    const livingFirst = fuseByReciprocalRank([[living], [dated]])
    expect(livingFirst[0]?.score).toBe(livingFirst[1]?.score)
    expect(livingFirst.map((h) => h.docId)).toEqual(['doc_dated', 'doc_living'])

    const datedFirst = fuseByReciprocalRank([[dated], [living]])
    expect(datedFirst.map((h) => h.docId)).toEqual(['doc_dated', 'doc_living'])
  })

  it('keeps a total order across a three-way tie: an undated hit joining the tie never reorders two dated hits (Important 2)', () => {
    // Before the fix, recencyTiebreak returned 0 ("no preference") for
    // ANY comparison involving an undated hit, which is not the same as
    // 0 meaning "equal": Array.prototype.sort requires a genuine total
    // order, and this broke it. doc_old could rank ABOVE doc_new, despite
    // an identical score and an eight-month-older date, purely because
    // doc_living happened to sit between them in the arrival order that
    // fuseByReciprocalRank's Map iteration produced. Every one of the six
    // orderings below must now produce the same output: most recent
    // first, undated last.
    const older = chunkHit({ docId: 'doc_old', dateStart: '2026-01-05', dateEnd: '2026-01-05' })
    const living = chunkHit({ docId: 'doc_living', kind: 'arc' })
    const newer = chunkHit({ docId: 'doc_new', dateStart: '2026-08-23', dateEnd: '2026-08-23' })

    const orderings = [
      [older, living, newer],
      [newer, living, older],
      [living, older, newer],
      [older, newer, living],
      [newer, older, living],
      [living, newer, older],
    ]
    for (const ordering of orderings) {
      const fused = fuseByReciprocalRank(ordering.map((hit) => [hit]))
      expect(fused.map((h) => h.docId)).toEqual(['doc_new', 'doc_old', 'doc_living'])
    }
  })

  it('does not let recency override a genuine score difference', () => {
    // doc_new tops both lists outright; doc_old only tops one. Their scores
    // are not equal, so the tiebreak must never run: recency is a
    // tiebreaker, not a multiplier, and an older document that is more
    // relevant must still win.
    const olderButBetter1 = chunkHit({
      docId: 'doc_old',
      dateStart: '2020-01-01',
      dateEnd: '2020-01-01',
    })
    const olderButBetter2 = chunkHit({
      docId: 'doc_old',
      dateStart: '2020-01-01',
      dateEnd: '2020-01-01',
    })
    const newerButWorse = chunkHit({
      docId: 'doc_new',
      dateStart: '2026-08-01',
      dateEnd: '2026-08-01',
    })

    const fused = fuseByReciprocalRank([[olderButBetter1, newerButWorse], [olderButBetter2]])

    expect(fused.map((h) => h.docId)).toEqual(['doc_old', 'doc_new'])
    expect(fused[0]?.score).toBeGreaterThan(fused[1]?.score ?? Number.POSITIVE_INFINITY)
  })
})
