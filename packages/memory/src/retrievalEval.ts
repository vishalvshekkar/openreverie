// The retrieval evaluation harness.
//
// This is step A1 of the retrieval fix plan
// (docs/superpowers/plans/2026-08-24-recall-and-event-time-fixes.md, Unit A).
// "Nothing else in this unit may be tuned until it exists": A2 (revive the
// FTS lane), A5 (retune RRF_K and CANDIDATE_LIMIT) and A6 (recency
// tiebreaker) all change ranking behavior, and this module is what turns
// "did that help" from a guess into a number. It is read-only with respect
// to retrieval.ts and sqlite.ts: it calls searchMemory, searchText and
// searchVector exactly as any other caller would, and scores what comes
// back. It does not touch toFtsQuery, RRF_K, CANDIDATE_LIMIT or
// fuseByReciprocalRank.
//
// retrievalEval.test.ts wires this to the fixture corpus in
// evalFixtures.ts and the offline stub embedding provider in
// evalEmbeddingStub.ts, and records the pre-A2 baseline.

import type { EmbeddingProvider } from '@openreverie/providers'
import { type SearchFilters, searchMemory } from './retrieval.js'
import type { MemoryIndex } from './sqlite.js'

export interface EvalQuery {
  id: string
  query: string
  expectedDocId: string
  // 'natural' for a full sentence in the 10-to-15-token shape the chat
  // model actually writes (the shape that triggers defect 5); 'keyword' for
  // a short 2-3 token query, the shape every existing unit test used. An
  // explicit field rather than a naming convention on `id`, so a test that
  // filters by shape cannot silently misclassify a query added later under
  // a differently-shaped id.
  shape: 'natural' | 'keyword'
  filters?: SearchFilters
}

export interface LaneCounts {
  textHits: number
  vectorHits: number
}

export interface EvalQueryResult {
  query: EvalQuery
  // 1-indexed position of expectedDocId in the fused, ranked document list,
  // read from the real output of searchMemory (rankLimit deep). null when
  // it does not appear at all within that window.
  rank: number | null
  lane: LaneCounts
  topDocIds: string[]
}

export interface EvalSummary {
  k: number
  rankLimit: number
  results: EvalQueryResult[]
  recallAtK: number
  hitCount: number
  totalCount: number
}

// The window for the direct lane-diagnostic calls to searchText and
// searchVector. 20 on purpose, the same number as retrieval.ts's private
// CANDIDATE_LIMIT, chosen for realism, not imported from it: this step does
// not touch retrieval.ts, so the match is a deliberate constant, not a
// coupling that would break if that constant later changes under A5.
//
// Read the vector count with this in mind: searchVector has no relevance
// threshold, it always ranks every embedded chunk and returns the top
// `limit` of them, so "vector hits" is min(LANE_DIAGNOSTIC_LIMIT, chunk
// count) on every single query, a constant, not a signal. That is not a
// harness defect, it is the real, honest shape of the asymmetry between the
// two lanes: the FTS lane can genuinely come back empty (chunks_fts MATCH
// finds nothing), the vector lane structurally cannot. The report below
// states this so a reader does not mistake a constant column for a broken
// diagnostic.
const LANE_DIAGNOSTIC_LIMIT = 20

// How deep into the fused ranking a query's rank is recorded. searchMemory
// defaults its own limit to 8; this harness asks for more so that a
// document ranked, say, 12th is recorded as rank 12 rather than folded into
// "not found", which is the detail A5 needs to see the fusion constant's
// effect on ordering, not just on the top-8 cutoff.
const DEFAULT_RANK_LIMIT = 20

// Finds the 1-indexed position of expectedDocId in an already-ranked hit
// list. Pure and DB-free on purpose, so it can be tested against a
// hand-built list with a known expected rank without standing up an index.
export function rankOf(hits: { docId: string }[], expectedDocId: string): number | null {
  const position = hits.findIndex((hit) => hit.docId === expectedDocId)
  return position === -1 ? null : position + 1
}

export async function runRetrievalEval(
  index: MemoryIndex,
  embeddings: EmbeddingProvider,
  model: string,
  queries: EvalQuery[],
  rankLimit = DEFAULT_RANK_LIMIT,
): Promise<EvalQueryResult[]> {
  const results: EvalQueryResult[] = []
  for (const evalQuery of queries) {
    const textHits = index.searchText(
      evalQuery.query,
      LANE_DIAGNOSTIC_LIMIT,
      evalQuery.filters?.kinds,
      evalQuery.filters?.after,
      evalQuery.filters?.before,
    )
    // Usage discarded here for the same reason retrieval.ts discards it:
    // this eval harness has no ledger, and a hosted deployment's own
    // wrapper already observed the call.
    const { vectors } = await embeddings.embed(model, [evalQuery.query])
    const [queryVector] = vectors
    const vectorHits = queryVector
      ? await index.searchVector(
          queryVector,
          LANE_DIAGNOSTIC_LIMIT,
          evalQuery.filters?.kinds,
          evalQuery.filters?.after,
          evalQuery.filters?.before,
        )
      : []

    const fused = (
      await searchMemory(index, embeddings, model, evalQuery.query, evalQuery.filters, rankLimit)
    ).documents

    results.push({
      query: evalQuery,
      rank: rankOf(fused, evalQuery.expectedDocId),
      lane: { textHits: textHits.length, vectorHits: vectorHits.length },
      topDocIds: fused.map((hit) => hit.docId),
    })
  }
  return results
}

// recall@k: the fraction of queries whose expected document landed at rank
// <= k. A query whose rank is null (not found within rankLimit) never
// counts as a hit, at any k.
export function recallAtK(results: EvalQueryResult[], k: number): number {
  if (results.length === 0) {
    return 0
  }
  const hits = results.filter((result) => result.rank !== null && result.rank <= k).length
  return hits / results.length
}

export function summarize(
  results: EvalQueryResult[],
  k: number,
  rankLimit = DEFAULT_RANK_LIMIT,
): EvalSummary {
  const hitCount = results.filter((result) => result.rank !== null && result.rank <= k).length
  return {
    k,
    rankLimit,
    results,
    recallAtK: results.length === 0 ? 0 : hitCount / results.length,
    hitCount,
    totalCount: results.length,
  }
}

// A readable summary for a human tuning RRF_K or CANDIDATE_LIMIT: overall
// recall@k, how often each lane came back empty, and one line per query
// with its rank and per-lane hit counts, so a change in ordering is visible
// query by query rather than only in the aggregate number.
export function formatEvalReport(summary: EvalSummary): string {
  const lines: string[] = []
  lines.push(
    `Retrieval eval: ${summary.totalCount} queries, recall@${summary.k} = ` +
      `${summary.recallAtK.toFixed(2)} (${summary.hitCount}/${summary.totalCount}), ` +
      `rank window = ${summary.rankLimit}`,
  )
  const zeroFts = summary.results.filter((result) => result.lane.textHits === 0).length
  const zeroVector = summary.results.filter((result) => result.lane.vectorHits === 0).length
  lines.push(
    `FTS lane returned zero hits for ${zeroFts}/${summary.totalCount} queries. ` +
      `Vector lane returned zero hits for ${zeroVector}/${summary.totalCount} queries ` +
      '(structurally near-impossible: cosine similarity is always defined, so the vector ' +
      'column below is expected to read the same fixed number, min(candidate window, chunk ' +
      'count), on every query; only the FTS column carries a per-query signal today).',
  )
  lines.push('')
  for (const result of summary.results) {
    const status = result.rank !== null && result.rank <= summary.k ? 'HIT ' : 'MISS'
    const rankLabel =
      result.rank === null ? `not in top ${summary.rankLimit}` : `rank ${result.rank}`
    lines.push(
      `  [${status}] ${result.query.id.padEnd(10)} fts=${String(result.lane.textHits).padStart(2)} ` +
        `vec=${String(result.lane.vectorHits).padStart(2)}  ${rankLabel.padEnd(18)} ` +
        `expected=${result.query.expectedDocId}  "${result.query.query}"`,
    )
  }
  return lines.join('\n')
}
