// Hybrid retrieval: merges FTS text search and cosine vector search with
// reciprocal rank fusion, then applies caller filters.
//
// A note on date filtering: SearchFilters compares after/before against
// the document's meta date "when present". MemoryIndex, though, never
// persists document meta to SQLite: the documents table (and therefore
// every SearchHit) only carries docId, path, kind, snippet, and score.
// The one place a date reliably survives into a SearchHit is the path
// itself, for the kinds whose file layout encodes it (see dateFromPath
// below). So date filtering here reads the date out of the path when one
// is present, and treats any hit without one as undated: undated hits are
// never excluded by an after/before filter, which matches "when present"
// in the brief.

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
  const textHits = index.searchText(query, CANDIDATE_LIMIT)
  const [queryVector] = await embeddings.embed(embeddingModel, [query])
  const vectorHits = queryVector ? await index.searchVector(queryVector, CANDIDATE_LIMIT) : []

  const fused = fuseByReciprocalRank([textHits, vectorHits])
  const filtered = fused.filter((hit) => passesFilters(hit, filters))
  return filtered.slice(0, limit)
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

function passesFilters(hit: SearchHit, filters?: SearchFilters): boolean {
  if (filters?.kinds && !filters.kinds.includes(hit.kind)) {
    return false
  }

  const date = dateFromPath(hit.path)
  if (date === undefined) {
    return true
  }
  if (filters?.after && date < filters.after) {
    return false
  }
  if (filters?.before && date > filters.before) {
    return false
  }
  return true
}

const DATE_AT_SEGMENT_START = /^(\d{4}-\d{2}-\d{2})/

// Reads a YYYY-MM-DD date from the start of a path segment, checking the
// filename first and then each parent directory. This covers the two
// places a date is actually encoded: rollups/daily/<date>.md (in the
// filename) and sessions/<date>-<sessionId>/summary.md (in the parent
// directory). Deliberately not a search over the whole path string: the
// memory root itself is a user-chosen directory and could contain a
// date-like substring (a dated backup folder, say) that has nothing to do
// with the document's own date, so only a segment that starts with the
// date counts.
function dateFromPath(path: string): string | undefined {
  const segments = path.split('/')
  for (let i = segments.length - 1; i >= 0; i--) {
    const match = DATE_AT_SEGMENT_START.exec(segments[i] ?? '')
    if (match) {
      return match[1]
    }
  }
  return undefined
}
