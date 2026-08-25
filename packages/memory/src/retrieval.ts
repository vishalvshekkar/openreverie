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
import type { DocKind, MemoryIndex, NodeMatch, SearchHit } from './sqlite.js'

export interface SearchFilters {
  kinds?: DocKind[]
  after?: string
  before?: string
}

// A5 (docs/superpowers/plans/2026-08-24-recall-and-event-time-fixes.md, Unit
// A) asked whether RRF_K=60 and CANDIDATE_LIMIT=20 still fit now that A2
// widened the FTS lane: k=60 was tuned for candidate lists of thousands, and
// the reasoning was that against a 20-item list within-list rank barely
// separates rank 1 from rank 20, so presence-in-both-lists should dominate
// regardless of k, and lowering k should sharpen that further. Measured
// against the packages/memory/src/evalFixtures.ts corpus with
// retrievalEval.test.ts: recall@5 stayed at 0.88 across every RRF_K from 1
// through 120 at CANDIDATE_LIMIT=20, and across every CANDIDATE_LIMIT from
// 20 through 100 at RRF_K=60, all flat, not one query's rank moved. Pushing
// both to an extreme at once (CANDIDATE_LIMIT=40 or higher together with
// RRF_K=1) measurably regressed it to 0.83: a wider window pulls in weaker
// vector-lane matches, and RRF_K=1's near-zero weight past rank 1 let one of
// those outweigh a genuinely correct single-list top match. The reasoning
// behind wanting to retune held up (within-list rank really does barely
// separate rank 1 from rank 20 here), but nothing tried actually raised
// recall@5, so per the plan's own rule ("keep the change only if the harness
// says it helped"), both constants are unchanged from before A5.
const CANDIDATE_LIMIT = 20
const DEFAULT_LIMIT = 8
const RRF_K = 60
const NODE_HITS_CAP = 10

// The most matched chunks a single document hit carries in its payload.
// Three, not more: A2 ORs FTS terms, so a document with a dozen items can
// now match on most of them, and returning every one would recreate the
// exact flooding problem defect 1 was fixed to stop, just moved from "one
// document crowding out others" to "one document's chunks crowding out its
// own document budget". Three is enough to almost always carry both a vague
// mention and the precise, dated version of the same fact next to each
// other, which is the shape of the observed failure (docs/superpowers/
// plans/2026-08-24-recall-and-event-time-fixes.md): four items in the real
// summary, one of them the exact date, the rest supporting mentions.
// `chunksTotal` on DocumentHit names whatever this cap drops, the same
// spirit as the truncation markers in packages/core/src/budget.ts: a
// document with more matches than shown is visibly truncated, not silently
// cut.
//
// Since each `chunks` entry is now a chunk's own text rather than a
// lane-rendered window (see SearchHit.snippet in sqlite.ts), this cap is
// also what keeps a document hit's total payload size bounded: chunks are
// split to at most MAX_CHUNK_CHARS (1200, sqlite.ts) at index time, and
// DocumentHit.snippet is the same kind of full chunk text (up to 1200 of
// its own), so (CHUNKS_PER_DOC_CAP + 1) * MAX_CHUNK_CHARS, roughly 4,800
// characters, is the most a single document hit can carry regardless of
// how long the source document is. Across DEFAULT_LIMIT document hits that
// puts the ceiling on searchMemory's `documents` array at roughly 38,400
// characters. Nothing downstream (packages/core/src/tools.ts,
// packages/core/src/budget.ts) caps search_memory's JSON output further;
// this construction-time bound is the only one there is.
const CHUNKS_PER_DOC_CAP = 3

// A fused, document-level search result. Distinct from SearchHit (sqlite.ts),
// which is a chunk-level row: one document can hold several matching
// chunks, and this is the shape that carries all of them (up to the cap)
// rather than just the single best-ranked one. Deliberately structured as a
// superset of SearchHit's required fields (docId, path, kind, snippet,
// score, and the same optional dateStart/dateEnd) rather than a competing
// shape, so a caller typed against SearchHit[] (packages/memory/src/
// engine.ts's EngineSearchResult) keeps compiling unchanged: `snippet`
// stays the single best chunk, exactly as before A4, and `chunks` /
// `chunksTotal` are additions, not a breaking replacement.
//
// `snippet` is set from the best hit's own SearchHit.snippet, which is now
// the chunk's verbatim text (see sqlite.ts), not a lane-rendered fragment.
// It is therefore no longer a lossier rendering than `chunks[0]`: both are
// full chunk text, never a truncated or windowed one. They can still name
// different physical chunks of the same document in one case: `snippet`
// comes from whichever hit fuseByReciprocalRank judged the single
// best-ranked occurrence of the document, while `chunks` is ordered by a
// separate per-chunk score computed across every raw occurrence
// (collectChunksByDocId below). Those two selections usually agree and can
// diverge when a different chunk of the same document scores higher by
// appearing in both lanes. That is a pre-existing property of having two
// separate ranking passes, not a truncation artifact, and it is out of
// scope here: this change removes lossy rendering, not that divergence.
export interface DocumentHit {
  docId: string
  path: string
  kind: DocKind
  snippet: string
  score: number
  dateStart?: string
  dateEnd?: string
  // Matched chunks from this document, best first, capped at
  // CHUNKS_PER_DOC_CAP. Always includes at least the chunk `snippet` names.
  chunks: string[]
  // The count of distinct matched chunks seen for this document within the
  // candidate window (CANDIDATE_LIMIT per lane, searchMemory below), before
  // CHUNKS_PER_DOC_CAP trims the list. Equal to chunks.length when nothing
  // was dropped. Not the document's true total: a document with more
  // matching chunks than fit in the candidate window can still report at
  // most CANDIDATE_LIMIT here, since fusion never sees candidates beyond
  // that window in the first place.
  chunksTotal: number
}

// Two lanes, returned separately. `documents` are ranked passages fused from
// the FTS and cosine lists. `nodes` are graph nodes whose name matched, and
// they are deliberately not fused in: a node has no chunk, so it has no rank
// in either list, and any score invented for it would corrupt a real ranking.
export interface SearchResults {
  documents: DocumentHit[]
  nodes: NodeMatch[]
}

export async function searchMemory(
  index: MemoryIndex,
  embeddings: EmbeddingProvider,
  embeddingModel: string,
  query: string,
  filters?: SearchFilters,
  limit = DEFAULT_LIMIT,
): Promise<SearchResults> {
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
  return {
    documents: fused.slice(0, limit),
    nodes: index.searchNodes(query, NODE_HITS_CAP),
  }
}

// Reciprocal rank fusion: each hit's score is the sum, over every list it
// appears in, of 1 / (RRF_K + rank), with rank 1-indexed. A document
// present in both lists accumulates both contributions. Dedupes by docId,
// keeping the identity (path, kind, dates) and the single best snippet from
// whichever occurrence has the better (lowest) individual rank, exactly as
// before A4: what changes under A4 is that the payload also carries every
// matched chunk for the document, not only that best one. See
// collectChunksByDocId below for how those are gathered and ordered; this
// function's own ranking logic (which document wins, and by how much) is
// untouched, because it is what the comment below still describes and it
// must stay correct on its own.
//
// searchText and searchVector return chunk-level rows, so a single
// document can occupy several positions in one list (a multi-item summary,
// for instance). Rank is computed over each list after collapsing it to
// one row per docId, not over the raw chunk rows: otherwise a document
// with many matching chunks in only one list could out-accumulate a
// document that genuinely tops both lists, which would break the fusion's
// basic guarantee.
// Exported for direct, DB-free unit tests of the fusion and its recency
// tiebreak (A6): a hand-built SearchHit list can force an exact score tie
// without needing to coax real bm25 ranks and cosine similarities into
// matching, which is what searchMemory's own integration tests exercise
// with a real index instead.
export function fuseByReciprocalRank(lists: SearchHit[][]): DocumentHit[] {
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

  const chunksByDocId = collectChunksByDocId(lists)

  const fused: DocumentHit[] = []
  for (const [docId, score] of scoreByDocId) {
    const best = bestByDocId.get(docId)
    if (!best) {
      continue
    }
    // Falls back to the best hit's own snippet if, for some reason, chunk
    // collection found nothing for this docId (it always finds at least
    // the best hit itself in practice; the fallback exists so a document
    // hit is never payload-less rather than as an expected path).
    const allChunks = chunksByDocId.get(docId) ?? [best.hit.snippet]
    fused.push({
      docId: best.hit.docId,
      path: best.hit.path,
      kind: best.hit.kind,
      snippet: best.hit.snippet,
      score,
      ...(best.hit.dateStart !== undefined ? { dateStart: best.hit.dateStart } : {}),
      ...(best.hit.dateEnd !== undefined ? { dateEnd: best.hit.dateEnd } : {}),
      chunks: allChunks.slice(0, CHUNKS_PER_DOC_CAP),
      chunksTotal: allChunks.length,
    })
  }

  // A6: recency is a tiebreaker, applied only when the score comparison
  // above is exactly equal, never a multiplier or a term folded into score
  // itself. A query about something years old must not be dragged toward
  // last week just because two candidates happen to score identically; this
  // only ever changes the order of a genuine tie.
  fused.sort((a, b) => (b.score !== a.score ? b.score - a.score : recencyTiebreak(a, b)))
  return fused
}

// Orders two equally-scored document hits by recency, more recent first.
// Compares dateEnd, the later edge of the span (documentDateSpan), as the
// closest reading of "how recent is this content"; a weekly rollup's
// dateEnd is its Sunday, not its Monday. Two equal dates return 0, a tie
// staying a tie.
//
// A hit missing a span (a living document: constitution, realm, arc,
// person, journaling) sorts after every dated hit, never before. This is
// a change from the original "return 0, no preference" rule for that
// case, made because that rule broke the comparator's own contract:
// returning 0 for "not comparable" is not the same as returning 0 for
// "equal", and Array.prototype.sort requires a genuine total order.
// With the old rule, three hits tied on score (one dated and old, one
// undated, one dated and much newer) could sort the old dated hit ABOVE
// the newer one, backwards from "more recent first", purely because an
// unrelated undated hit joined the same tie and the outcome depended on
// V8's sort implementation and the hits' arrival order, not on any rule
// stated here. Giving the undated case an explicit, fixed position (last)
// restores transitivity and keeps the original intent for the two-hit
// case: an absent date is never read as very recent, so it can never
// falsely promote a living document above a genuinely tied dated one.
function recencyTiebreak(a: DocumentHit, b: DocumentHit): number {
  if (a.dateEnd === b.dateEnd) return 0
  if (a.dateEnd === undefined) return 1
  if (b.dateEnd === undefined) return -1
  return a.dateEnd > b.dateEnd ? -1 : 1
}

// Gathers, per docId, every distinct chunk matched across both raw
// (non-deduped) candidate lists, ordered best first. A chunk's identity is
// docId + seq (SearchHit.seq, the chunk's position within its document):
// the same physical chunk can be matched by both the FTS lane and the
// vector lane, and without that identity it would look like two different
// chunks and be counted, and shown, twice.
//
// "Best first" here is the same reciprocal-rank idea used for documents
// above, just scoped one level down: a chunk's score is the sum, over every
// list it appears in, of 1 / (RRF_K + its position in that raw list). Both
// searchText (FTS rank) and searchVector (cosine similarity) already return
// their lists best first, so a chunk appearing early in either list, or in
// both, sorts to the front of its document's chunk list too. This is
// deliberately not the per-document dedupe used for document ranking above:
// that collapses each list to one row per docId before scoring, which is
// exactly the information this function needs kept, not thrown away.
function collectChunksByDocId(lists: SearchHit[][]): Map<string, string[]> {
  const scoreByChunkKey = new Map<string, number>()
  const snippetByChunkKey = new Map<string, string>()
  const docIdByChunkKey = new Map<string, string>()

  for (const list of lists) {
    list.forEach((hit, index) => {
      if (hit.seq === undefined) {
        return
      }
      const key = `${hit.docId}:${hit.seq}`
      const rank = index + 1
      const contribution = 1 / (RRF_K + rank)
      scoreByChunkKey.set(key, (scoreByChunkKey.get(key) ?? 0) + contribution)
      // hit.snippet is now the chunk's own text (sqlite.ts's searchText and
      // searchVector both select it straight from the chunks table), so the
      // same physical chunk carries the identical string regardless of
      // which lane's row is processed first or last here. There is no
      // longer a "more complete rendering" to prefer between two lossy
      // lane-specific windows, so the first write wins and later writes for
      // the same key are redundant, not competing.
      if (!snippetByChunkKey.has(key)) {
        snippetByChunkKey.set(key, hit.snippet)
      }
      docIdByChunkKey.set(key, hit.docId)
    })
  }

  const chunksByDocId = new Map<string, { key: string; score: number }[]>()
  for (const [key, score] of scoreByChunkKey) {
    const docId = docIdByChunkKey.get(key)
    if (!docId) {
      continue
    }
    const forDoc = chunksByDocId.get(docId) ?? []
    forDoc.push({ key, score })
    chunksByDocId.set(docId, forDoc)
  }

  const result = new Map<string, string[]>()
  for (const [docId, chunkScores] of chunksByDocId) {
    chunkScores.sort((a, b) => b.score - a.score)
    result.set(
      docId,
      chunkScores.map((c) => snippetByChunkKey.get(c.key) ?? ''),
    )
  }
  return result
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
