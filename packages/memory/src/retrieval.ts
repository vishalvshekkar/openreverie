// Hybrid retrieval: merges FTS text search and cosine vector search with
// reciprocal rank fusion.
//
// Both the caller's kind filter and the caller's after/before date filter
// are applied inside the index, in the SQL WHERE clauses of searchText and
// searchVector, not here. That is deliberate and it is the same argument in
// both cases: this module only ever sees the top-20 candidate window from
// each search, so anything filtered out afterwards has already cost a
// candidate slot, and a narrow filter could come back empty while matching
// documents sat just outside the window.
//
// Date filtering compares against the span stored on each document row
// (date_start, date_end), written at index time by documentDateSpan. Session
// summaries, daily rollups and weekly rollups have a real span. Living
// documents (the constitution, and realm, arc and person pages) have none:
// they carry NULL and are never excluded by a date filter, because no single
// date on them means "when this content is about". See dateSpan.ts for the
// full reasoning.

import type { EmbeddingProvider } from '@openreverie/providers'
import type { DocKind, MemoryIndex, SearchHit } from './sqlite.js'

export interface SearchFilters {
  kinds?: DocKind[]
  after?: string
  before?: string
}

const CANDIDATE_LIMIT = 20
const DEFAULT_LIMIT = 8
const RRF_K = 60

export async function searchMemory(
  index: MemoryIndex,
  embeddings: EmbeddingProvider,
  embeddingModel: string,
  query: string,
  filters?: SearchFilters,
  limit = DEFAULT_LIMIT,
): Promise<SearchHit[]> {
  const textHits = index.searchText(
    query,
    CANDIDATE_LIMIT,
    filters?.kinds,
    filters?.after,
    filters?.before,
  )
  const [queryVector] = await embeddings.embed(embeddingModel, [query])
  const vectorHits = queryVector
    ? await index.searchVector(
        queryVector,
        CANDIDATE_LIMIT,
        filters?.kinds,
        filters?.after,
        filters?.before,
      )
    : []

  const fused = fuseByReciprocalRank([textHits, vectorHits])
  return fused.slice(0, limit)
}

// Reciprocal rank fusion: each hit's score is the sum, over every list it
// appears in, of 1 / (RRF_K + rank), with rank 1-indexed. A document
// present in both lists accumulates both contributions. Dedupes by docId,
// keeping the snippet from whichever occurrence has the better (lowest)
// individual rank.
//
// searchText and searchVector return chunk-level rows, so a single
// document can occupy several positions in one list (a multi-item summary,
// for instance). Rank is computed over each list after collapsing it to
// one row per docId, not over the raw chunk rows: otherwise a document
// with many matching chunks in only one list could out-accumulate a
// document that genuinely tops both lists, which would break the fusion's
// basic guarantee.
function fuseByReciprocalRank(lists: SearchHit[][]): SearchHit[] {
  const scoreByDocId = new Map<string, number>()
  const bestByDocId = new Map<string, { hit: SearchHit; rank: number }>()

  for (const list of lists) {
    const deduped = dedupeByDocId(list)
    deduped.forEach((hit, index) => {
      const rank = index + 1
      const contribution = 1 / (RRF_K + rank)
      scoreByDocId.set(hit.docId, (scoreByDocId.get(hit.docId) ?? 0) + contribution)

      const current = bestByDocId.get(hit.docId)
      if (!current || rank < current.rank) {
        bestByDocId.set(hit.docId, { hit, rank })
      }
    })
  }

  const fused: SearchHit[] = []
  for (const [docId, score] of scoreByDocId) {
    const best = bestByDocId.get(docId)
    if (!best) {
      continue
    }
    fused.push({ ...best.hit, score })
  }

  fused.sort((a, b) => b.score - a.score)
  return fused
}

// Keeps the first (best-ranked) occurrence of each docId in a chunk-level
// hit list, preserving relative order.
function dedupeByDocId(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>()
  const deduped: SearchHit[] = []
  for (const hit of hits) {
    if (seen.has(hit.docId)) {
      continue
    }
    seen.add(hit.docId)
    deduped.push(hit)
  }
  return deduped
}
