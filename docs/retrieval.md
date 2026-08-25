# How retrieval works

This is a reference for the search side of memory: how a query becomes ranked
results the agent can read. It covers what exists today, not what is planned.
For the folder layout and reflection pipeline that produce the documents this
searches over, see the [main design spec](superpowers/specs/2026-08-13-openreverie-design.md).

## The index is derived, not source of truth

`index.db`, a SQLite file at the root of your memory folder, is a search index
built from the markdown files and `graph.jsonl`. It is disposable: `reverie
reindex` wipes it and rebuilds it from disk. Nothing lives only in this
database.

A rebuild does two independent things:

- **Documents.** `MemoryIndex.wipeAllDocuments` clears the `documents`,
  `chunks`, `chunks_fts`, and `embeddings` tables, then `reindexAll`
  (`packages/memory/src/engine.ts:1822`) walks the memory folder
  (`walkAllDocuments`) and reinserts every document it finds: the
  constitution, realms, arcs, person pages, daily and weekly rollups, and
  each session's `summary.md`. Verbatim session transcripts are never
  chunked or embedded; they are not in the search index at all (see below).
- **Graph.** Nodes and edges are reloaded straight from `graph.jsonl` and
  written into the `nodes` and `edges` tables via `replaceGraph`. This runs
  every time the engine opens (`MemoryEngine.open`,
  `packages/memory/src/engine.ts:461`), and again on every `reindexAll` and
  every live graph write (`syncGraph`, `packages/memory/src/engine.ts:1882`).

## Schema

Six tables (`createTables`, `packages/memory/src/sqlite.ts:181`):

- `documents(id, path, kind, mtime, date_start, date_end)`
- `chunks(id, doc_id, seq, text)`
- `chunks_fts`: an FTS5 virtual table, external content over `chunks`
- `embeddings(chunk_id, vector)`: one row per chunk, vector stored as a raw
  `Float32Array` blob
- `nodes(id, type, label, doc, ts)`
- `edges(edge, from_id, to_id, confidence, confirmed, ts)`, primary key on
  `(edge, from_id, to_id)`

## Chunking

Each document is split before indexing (`buildChunks`, `packages/memory/src/sqlite.ts:623`):

- The body is split on blank lines into paragraphs, then paragraphs are
  packed back together up to `MAX_CHUNK_CHARS` (1200 characters) per chunk.
  A paragraph that would push a chunk over the limit starts a new one
  instead.
- If the document's frontmatter has an `items` array (session summaries only,
  written by reflection to record discrete observations, feelings, events,
  and intentions), each item becomes its own extra chunk
  (`itemChunkText`, `packages/memory/src/sqlite.ts:699`), formatted as
  `"<id>: <text>"`, or `"<id>: <text> (eventTime: "<words>", as stated on
  <date>)"` when the item carries an `eventTime`: the person's own words for
  when the thing happens, not a resolved date, anchored to the date they
  said it. This parenthetical, and the fact that it reaches the search
  index at all, is the point of the event-time work: a search result now
  carries its own stated time instead of coming back undated. A blank or
  whitespace-only `eventTime` (from a folder written before that fix, or
  hand-edited) is treated as absent, never rendered as `(eventTime: "")`.

## Embeddings

Embeddings are computed at index time, not at query time for documents.
`reindexAll` and the per-document reindex path both pass an `embed` callback
into `upsertDocument`, which calls it once per document with all of that
document's chunk texts (`upsertDocument`, `packages/memory/src/sqlite.ts:230`). The
callback goes through the OpenAI adapter (`embed`, `packages/providers/src/openai.ts:317`),
wired in via the provider factory. The embedding model is configurable in
`config.toml` (`models.embeddings`, `packages/core/src/config.ts:56`) and
defaults to `text-embedding-3-small`.

## Query time

A search runs these steps in order (`searchMemory`,
`packages/memory/src/retrieval.ts:135`):

1. **Text search.** An FTS5 `MATCH` query against `chunks_fts`, ordered by
   FTS rank (`searchText`, `packages/memory/src/sqlite.ts:374`). Each query
   word is wrapped as a quoted phrase (`toFtsQuery`,
   `packages/memory/src/sqlite.ts:741`) so punctuation and FTS operator
   characters can't be read as syntax, and the phrases are joined with `OR`,
   not left to FTS5's default `AND`. This matters: before this was fixed
   (2026-08-24), the lane implicitly ANDed every whitespace-separated term,
   so almost no natural-language query (which rarely contains every one of
   its words in the matched text) actually matched anything, and the lane
   sat effectively dead in production without erroring or looking broken.
2. **Embed the query.** One call to the embedding provider turns the query
   string into a vector.
3. **Vector search.** Every embedding row (optionally filtered by document
   kind) is pulled out of SQLite, cosine similarity against the query vector
   is computed in JavaScript for each one, and the results are sorted and
   truncated (`searchVector`, `packages/memory/src/sqlite.ts:427`). This is
   a brute-force linear scan: there is no ANN index and no vector extension
   such as `sqlite-vec` in the loop. These three steps run in sequence, not
   in parallel.
4. **Fuse.** The two ranked lists are combined with reciprocal rank fusion
   (`fuseByReciprocalRank`, `packages/memory/src/retrieval.ts:192`): each
   document's score is the sum of `1 / (60 + rank)` over every list it
   appears in (`RRF_K = 60`), deduplicated by document id. There is no
   reranking model or second pass over the fused list; the only ranking
   logic on top of RRF is a recency tiebreaker (`recencyTiebreak`,
   `packages/memory/src/retrieval.ts`, just below `fuseByReciprocalRank`),
   applied only when two hits score exactly equal: the one with the later
   `dateEnd` sorts first, and a hit with no date span (a living document:
   the constitution, a realm, an arc, a person, journaling) sorts after
   every dated hit in a tie, never before. `after`/`before` date filters run
   earlier than fusion, inside `searchText` and `searchVector`'s own SQL,
   against a date span stored on each document row (see Known limitations
   below).

Each search pulls up to 20 candidates from each of text and vector search
(`CANDIDATE_LIMIT`) before fusion, and returns up to 8 results by default
(`DEFAULT_LIMIT`), or the caller's requested `limit`
(both constants at the top of `packages/memory/src/retrieval.ts`).

This hybrid search is what the agent's `search_memory` tool runs. The agent
has other tools for the rest of memory: graph traversal (`neighbors`,
`itemsInArc`, `arcsInvolvingPerson`, `packages/memory/src/sqlite.ts:532`
onward) and full, verbatim transcript reads are separate tools, not part of
`search_memory` and not backed by this index.

## Result shape

A fused hit (`DocumentHit`, `packages/memory/src/retrieval.ts:105`) is a
document, not a single chunk: `docId`, `path`,
`kind`, `score`, and optionally `dateStart`/`dateEnd` (present together or
not at all; absent on a living document). It also carries:

- `snippet`: the single best-ranked chunk's own text, verbatim, not a
  lane-rendered window or a truncated fragment. This is the same text a
  `read_document` call would eventually reach for that chunk.
- `chunks`: every distinct chunk of this document matched across both
  lanes, best first, up to `CHUNKS_PER_DOC_CAP` (3). Each entry is the
  chunk's own verbatim text as well, for the same reason `snippet` is: a
  document that carries both a vague mention and its precise, dated version
  now returns both instead of only the single best-ranked one.
- `chunksTotal`: how many distinct matched chunks were found before that
  cap, so a document whose `chunks.length` is less than `chunksTotal` is
  visibly truncated rather than silently cut. This count is bounded by
  `CANDIDATE_LIMIT` (20 rows per lane before fusion), not the document's
  true total number of matching chunks: a document with, say, 40 matching
  chunks in a large memory folder can still report at most 20, because
  fusion never sees candidates beyond that window in the first place.

## Known limitations

**Vector search does not scale past personal-memory sizes.** It is a full
scan over every embedding, with cosine similarity computed in JavaScript on
every query. This is fine at the size of one person's memory folder, but it
is a real ceiling: there is no approximate nearest-neighbor index behind it
today.

**There is no reranking stage.** Reciprocal rank fusion is the only ranking
logic. Results are not passed through a cross-encoder or any second-pass
scoring.

**Date filters are precise for point-in-time documents and deliberately
absent for living ones.** Each document's date span is computed once at
index time by `documentDateSpan` (`packages/memory/src/dateSpan.ts`) and
stored in the `date_start`/`date_end` columns added to `documents`. Session
summaries and daily rollups get a single-day span from their `date`
frontmatter, journal entries get one from `entryDate`, and weekly rollups
get a Monday-to-Sunday span from their `week` frontmatter. `after`/`before`
range-check against that stored span directly in `searchText` and
`searchVector`'s SQL (`dateClause`, `packages/memory/src/sqlite.ts:775`).
The constitution, and realm, arc, person, and journaling-protocol documents
are continuously rewritten and have no one date they are about, so
`documentDateSpan` returns null for them, and `dateClause` never excludes a
null-span row no matter what filter is given. That is a stated, tested
property of exactly those kinds, not a residual gap: a date-filtered search
still surfaces an arc or person page outside the requested range, by design,
alongside whichever point-in-time hits the filter actually narrowed. The
`search_memory` tool's own `after`/`before` parameter descriptions
(`packages/core/src/tools.ts:230`, `after`/`before`) state this distinction directly, so
the model is not left to infer it.

**Entities are not searchable.** Entities (books, films, companies, places,
and the like) only ever get a graph node, never a document, so they never
enter the SQLite index and never appear in `search_memory` results. The same
is true of a person who has been mentioned but has not yet earned a page:
they exist as a node in the graph, reachable by graph traversal from
something that names them, but there is no document for search to find.
