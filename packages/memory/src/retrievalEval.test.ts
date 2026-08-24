// Step A1 of the retrieval fix plan:
// docs/superpowers/plans/2026-08-24-recall-and-event-time-fixes.md, Unit A.
// This is the harness, and it changes no search behavior of its own. It
// measured the pre-A2 baseline (recall@5 = 0.79, with the keyword lane
// returning zero hits for 20 of 24 queries) and now measures the state
// after A2 through A6 landed.
//
// Two kinds of assertion appear below, deliberately different shapes for
// deliberately different reasons:
//
// - The recall@5 floor test asserts a number the CURRENT, unmodified code
//   already clears (via the vector lane alone; see the comment on the
//   test). It describes correct behavior, and A2/A5/A6 are expected to
//   raise this number, never to lower it silently.
// - The FTS-lane test is `it.skip`, because the current code does not
//   clear it: `toFtsQuery` ANDs every term, so a natural-language query
//   of 10-15 tokens matches nothing. Asserting that as a passing test
//   would assert the bug, and it would then fail the moment A2 fixes it.
//   The skipped assertion states what correct looks like and names the
//   step (A2) that turns it on.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BagOfWordsEmbeddingProvider } from './evalEmbeddingStub.js'
import { EVAL_MODEL, EVAL_QUERIES, evalFixtureDocuments } from './evalFixtures.js'
import {
  type EvalQueryResult,
  formatEvalReport,
  rankOf,
  recallAtK,
  runRetrievalEval,
  summarize,
} from './retrievalEval.js'
import { type EmbedFn, MemoryIndex } from './sqlite.js'

const RECALL_K = 5

// The floor the fixture corpus's recall@5 must not drop below. Measured
// against the current, unmodified code (see the report printed by the test
// below): the vector lane alone, scored by the deterministic bag-of-words
// stub, already resolves most of the near-miss clusters correctly, because
// cosine similarity over shared content words is enough signal on its own
// when nothing from the FTS lane is there to fuse against it. This is a
// floor, not a target: A2 (revive the FTS lane), A5 (retune RRF_K and
// CANDIDATE_LIMIT) and A6 (recency tiebreaker) are all expected to raise
// it, and this assertion exists so none of them can lower it by accident.
const BASELINE_RECALL_AT_5_FLOOR = 0.75

function embedFn(provider: BagOfWordsEmbeddingProvider): EmbedFn {
  return (texts: string[]) => provider.embed(EVAL_MODEL, texts)
}

describe('retrieval eval metric correctness', () => {
  it('rankOf finds the 1-indexed position of the expected docId in a hand-built hit list', () => {
    const hits = [{ docId: 'doc_c' }, { docId: 'doc_a' }, { docId: 'doc_b' }]

    expect(rankOf(hits, 'doc_c')).toBe(1)
    expect(rankOf(hits, 'doc_a')).toBe(2)
    expect(rankOf(hits, 'doc_b')).toBe(3)
    expect(rankOf(hits, 'doc_missing')).toBeNull()
    expect(rankOf([], 'doc_a')).toBeNull()
  })

  it('recallAtK and summarize agree on a hand-built set of per-query results with known ranks', () => {
    const results: EvalQueryResult[] = [
      {
        query: { id: 'q1', query: 'x', expectedDocId: 'a', shape: 'natural' },
        rank: 1,
        lane: { textHits: 1, vectorHits: 1 },
        topDocIds: ['a'],
      },
      {
        query: { id: 'q2', query: 'x', expectedDocId: 'b', shape: 'natural' },
        rank: 4,
        lane: { textHits: 0, vectorHits: 3 },
        topDocIds: [],
      },
      {
        query: { id: 'q3', query: 'x', expectedDocId: 'c', shape: 'natural' },
        rank: null,
        lane: { textHits: 0, vectorHits: 0 },
        topDocIds: [],
      },
      {
        query: { id: 'q4', query: 'x', expectedDocId: 'd', shape: 'natural' },
        rank: 8,
        lane: { textHits: 0, vectorHits: 1 },
        topDocIds: [],
      },
    ]

    // rank 1 and rank 4 land within top 5; rank null and rank 8 do not.
    expect(recallAtK(results, 5)).toBe(0.5)
    // only rank 1 lands within top 1.
    expect(recallAtK(results, 1)).toBe(0.25)
    // nothing lands within top 0.
    expect(recallAtK(results, 0)).toBe(0)

    const summary = summarize(results, 5)
    expect(summary.recallAtK).toBe(0.5)
    expect(summary.hitCount).toBe(2)
    expect(summary.totalCount).toBe(4)
    expect(summary.k).toBe(5)
  })

  it('recallAtK returns 0 on an empty result set rather than dividing by zero', () => {
    expect(recallAtK([], 5)).toBe(0)
  })
})

describe('retrieval eval (fixture corpus)', () => {
  let dir: string
  let dbPath: string
  let index: MemoryIndex
  let embeddings: BagOfWordsEmbeddingProvider
  let results: EvalQueryResult[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-retrieval-eval-'))
    dbPath = join(dir, 'index.db')
    index = MemoryIndex.open(dbPath)
    embeddings = new BagOfWordsEmbeddingProvider()

    for (const fixture of evalFixtureDocuments()) {
      await index.upsertDocument(fixture.doc, fixture.kind, embedFn(embeddings))
    }

    results = await runRetrievalEval(index, embeddings, EVAL_MODEL, EVAL_QUERIES)
  })

  afterEach(async () => {
    index.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('prints a readable baseline report and clears the recall@5 floor', () => {
    const summary = summarize(results, RECALL_K)

    // The report a human tuning RRF_K or CANDIDATE_LIMIT reads: overall
    // recall@k, how often each lane came back empty, and one line per
    // query with its rank and per-lane hit counts. This is the "readable
    // summary" the harness is required to produce; run `pnpm test` in
    // packages/memory to see it.
    console.log(formatEvalReport(summary))

    expect(summary.recallAtK).toBeGreaterThanOrEqual(BASELINE_RECALL_AT_5_FLOOR)
  })

  it('the FTS lane still returns hits for short keyword queries, the shape every existing unit test uses', () => {
    // A floor, not an aspirational assertion: toFtsQuery's implicit-AND
    // bug (defect 5) only starves the lane on long natural-language
    // queries, where many distinct terms must all land in the same ~100
    // character chunk. A 2-3 token keyword query already clears that bar
    // today, which is exactly why no existing unit test caught the bug:
    // every one of them queries this way. This stays true before and
    // after A2.
    //
    // q24 is excluded on purpose: it is the same keyword query as q22, but
    // with 'flight' instead of 'flights', and the document only contains
    // 'Flights'. That word-form mismatch alone drops it to zero hits under
    // today's implicit AND, which is a genuine instance of defect 5, not a
    // floor this harness can honestly claim already holds. It is asserted
    // separately below, alongside the aspirational natural-language case.
    const shortKeywordResults = results.filter(
      (result) => result.query.shape === 'keyword' && result.query.id !== 'q24',
    )
    expect(shortKeywordResults.length).toBeGreaterThan(0)
    for (const result of shortKeywordResults) {
      expect(result.lane.textHits).toBeGreaterThan(0)
    }
  })

  // Defect 5 (docs/superpowers/plans/2026-08-24-recall-and-event-time-fixes.md,
  // Unit A, "the keyword lane of the hybrid search returns nothing for
  // real queries"): toFtsQuery joins terms with an implicit AND, so most
  // of the natural-language queries above (10 to 15 tokens) match zero
  // chunks in the FTS lane today, and so does q24, a 3-token keyword query
  // where a word-form mismatch ('flight' in the query, 'Flights' in the
  // document) is enough on its own to starve it. Both assertions describe
  // the CORRECT behavior: every one of these should get at least one hit
  // from the keyword lane once it ORs terms instead of ANDing them. They
  // are skipped, not asserted, because the current code does not clear
  // them; unskip this when A2 lands.
  it('FTS lane returns at least one hit for every natural-language query, and for q24 (enable at A2)', () => {
    const naturalOrMismatched = results.filter(
      (result) => result.query.shape === 'natural' || result.query.id === 'q24',
    )
    for (const result of naturalOrMismatched) {
      expect(result.lane.textHits).toBeGreaterThan(0)
    }
  })
})
