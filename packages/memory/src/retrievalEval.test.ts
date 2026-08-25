// Step A1 of the retrieval fix plan:
// docs/superpowers/plans/2026-08-24-recall-and-event-time-fixes.md, Unit A.
// This is the harness, and it changes no search behavior of its own. It
// measured the pre-A2 baseline (recall@5 = 0.79, with the keyword lane
// returning zero hits for 20 of 24 queries) and now measures the state
// after A2 through A6 landed: recall@5 = 0.88 (21/24), and the FTS lane
// returns at least one hit for every query shape in the fixture set.
//
// Every assertion below is live; none is skipped. The FTS-lane test
// (`it('FTS lane returns at least one hit for every natural-language
// query...')` further down) used to be `it.skip`, written before A2
// landed to state what correct looked like without asserting the bug.
// A2 landed (toFtsQuery ORs terms instead of ANDing them), the assertion
// held on the first try, and it has run as a normal passing test since.
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

// The floor the fixture corpus's recall@5 must not drop below. The current
// code, with A2 (revive the FTS lane), A5 (retune RRF_K and
// CANDIDATE_LIMIT) and A6 (recency tiebreaker) all landed, clears
// recall@5 = 0.88 (21/24; see the report printed by the test below).
//
// 0.83 (20/24) is deliberately NOT 0.88: with 24 fixed queries, one lost
// hit is worth 1/24 ≈ 0.042, so a floor pinned at the exact current value
// would fail on any single query's worth of noise from an unrelated
// fixture change. 0.83 tolerates losing one query but still fails on
// losing two, which is what this floor exists to catch: reverting A2
// (the FTS-lane implicit-AND fix) during falsification dropped recall@5
// to 0.79 (19/24, two queries lost: q11 and q12, see the pinned-rank test
// below), and the OLD floor of 0.75 did not fail on that regression. This
// floor would.
//
// Raise this number only when a real improvement lands and the new,
// higher recall is confirmed stable (not a one-off from fixture ordering
// or embedding-stub noise), and update the reasoning above to match.
// Lowering it to make a failing suite pass is exactly the wrong move: a
// dropping recall@5 means retrieval got worse, and the fix is to find out
// why, not to stop measuring it.
const BASELINE_RECALL_AT_5_FLOOR = 0.83

// The two queries that flip from hit to miss when the FTS lane's
// implicit-AND bug (defect 5, toFtsQuery joining terms with AND instead
// of OR) comes back: q11 (rank 3 today) and q12 (rank 5 today), both
// natural-language "is there anything/has anything been decided" queries
// whose expected document is a near-miss the vector lane alone ranks
// lower than 5. See the pinned-rank test below for why this list exists
// as its own assertion, separate from the aggregate recall@5 floor.
const FTS_REGRESSION_CLUSTER = ['q11', 'q12']

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
  // real queries"): before A2, toFtsQuery joined terms with an implicit
  // AND, so most of the natural-language queries above (10 to 15 tokens)
  // matched zero chunks in the FTS lane, and so did q24, a 3-token keyword
  // query where a word-form mismatch ('flight' in the query, 'Flights' in
  // the document) was enough on its own to starve it. A2 landed
  // (toFtsQuery now ORs terms instead of ANDing them), and both
  // assertions below hold as ordinary passing tests, not aspirational
  // ones.
  it('FTS lane returns at least one hit for every natural-language query, and for q24', () => {
    const naturalOrMismatched = results.filter(
      (result) => result.query.shape === 'natural' || result.query.id === 'q24',
    )
    for (const result of naturalOrMismatched) {
      expect(result.lane.textHits).toBeGreaterThan(0)
    }
  })

  it('pins the FTS-regression cluster (q11, q12) within the top 5, so a change that keeps aggregate recall@5 flat cannot silently reopen the implicit-AND bug for these two', () => {
    // Deliberately a looser check than "rank equals exactly 3" and
    // "exactly 5": the invariant this test protects is that these two
    // stay HITS (rank within RECALL_K), not that their exact position
    // never moves for unrelated reasons. Reverting A2 alone (see
    // BASELINE_RECALL_AT_5_FLOOR's comment) pushes q11 to rank 13 and q12
    // to rank 10, both misses; a future change that improves some other
    // query enough to hold aggregate recall@5 steady while reintroducing
    // that regression would slip past the floor test above but not this
    // one.
    for (const id of FTS_REGRESSION_CLUSTER) {
      const result = results.find((r) => r.query.id === id)
      expect(result).toBeDefined()
      expect(result?.rank).not.toBeNull()
      expect(result?.rank).toBeLessThanOrEqual(RECALL_K)
    }
  })
})
