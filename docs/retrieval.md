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
  `chunks`, `chunks_fts`, and `embeddings` tables, then `reindexAll` walks the
  memory folder (`walkAllDocuments`) and reinserts every document it finds:
  the constitution, realms, arcs, person pages, daily and weekly rollups, and
  each session's `summary.md`. (`packages/memory/src/engine.ts:1084-1098`)
  Verbatim session transcripts are never chunked or embedded; they are not
  in the search index at all (see below).
- **Graph.** Nodes and edges are reloaded straight from `graph.jsonl` and
  written into the `nodes` and `edges` tables via `replaceGraph`. This runs
  independently of the document walk, every time the engine opens.
  (`packages/memory/src/engine.ts:243`)

## Schema

Six tables (`packages/memory/src/sqlite.ts:81-125`):

- `documents(id, path, kind, mtime)`
- `chunks(id, doc_id, seq, text)`
- `chunks_fts`: an FTS5 virtual table, external content over `chunks`
- `embeddings(chunk_id, vector)`: one row per chunk, vector stored as a raw
  `Float32Array` blob
- `nodes(id, type, label, doc, ts)`
- `edges(edge, from_id, to_id, confidence, confirmed, ts)`, primary key on
  `(edge, from_id, to_id)`

## Chunking

Each document is split before indexing (`packages/memory/src/sqlite.ts:408-444`):

- The body is split on blank lines into paragraphs, then paragraphs are
  packed back together up to `MAX_CHUNK_CHARS` (1200 characters) per chunk.
  A paragraph that would push a chunk over the limit starts a new one
  instead.
- If the document's frontmatter has an `items` array (used by arc and person
  pages to record discrete facts), each item becomes its own extra chunk,
  formatted as `"<id>: <text>"`.

## Embeddings

Embeddings are computed at index time, not at query time for documents.
`reindexAll` and the per-document reindex path both pass an `embed` callback
into `upsertDocument`, which calls it once per document with all of that
document's chunk texts (`packages/memory/src/sqlite.ts:128-161`). The
callback goes through the OpenAI adapter (`packages/providers/src/openai.ts:305-335`),
wired in via the provider factory. The embedding model is configurable in
`config.toml` (`models.embeddings`, `packages/core/src/config.ts:53-57`) and
defaults to `text-embedding-3-small`.

## Query time

A search runs these steps in order (`packages/memory/src/retrieval.ts:31-51`):

1. **Text search.** An FTS5 `MATCH` query against `chunks_fts`, ordered by
   FTS rank (`packages/memory/src/sqlite.ts:262-297`). Each query word is
   wrapped as a quoted phrase so punctuation can't be read as FTS syntax.
2. **Embed the query.** One call to the embedding provider turns the query
   string into a vector.
3. **Vector search.** Every embedding row (optionally filtered by document
   kind) is pulled out of SQLite, cosine similarity against the query vector
   is computed in JavaScript for each one, and the results are sorted and
   truncated (`packages/memory/src/sqlite.ts:299-330`). This is a
   brute-force linear scan: there is no ANN index and no vector extension
   such as `sqlite-vec` in the loop. These three steps run in sequence, not
   in parallel (`packages/memory/src/retrieval.ts:39-43`).
4. **Fuse and filter.** The two ranked lists are combined with reciprocal
   rank fusion (`packages/memory/src/retrieval.ts:53-95`): each document's
   score is the sum of `1 / (60 + rank)` over every list it appears in
   (`RRF_K = 60`), deduplicated by document id. There is no reranking model
   or second pass over the fused list; RRF is the entire ranking step.
   `after`/`before` date filters, if given, are applied after fusion.

Each search pulls up to 20 candidates from each of text and vector search
(`CANDIDATE_LIMIT`) before fusion, and returns up to 8 results by default
(`DEFAULT_LIMIT`), or the caller's requested `limit`
(`packages/memory/src/retrieval.ts:27-28`).

This hybrid search is what the agent's `search_memory` tool runs. The agent
has other tools for the rest of memory: graph traversal (`neighbors`,
`itemsInArc`, `arcsInvolvingPerson` in `packages/memory/src/sqlite.ts:332-377`)
and full, verbatim transcript reads are separate tools, not part of
`search_memory` and not backed by this index.

## Known limitations

**Vector search does not scale past personal-memory sizes.** It is a full
scan over every embedding, with cosine similarity computed in JavaScript on
every query. This is fine at the size of one person's memory folder, but it
is a real ceiling: there is no approximate nearest-neighbor index behind it
today.

**There is no reranking stage.** Reciprocal rank fusion is the only ranking
logic. Results are not passed through a cross-encoder or any second-pass
scoring.

**Date filters are silently unreliable for most document kinds.** `after`
and `before` only work correctly for documents whose path encodes a date:
daily rollups (`rollups/daily/<date>.md`) and session summaries
(`sessions/<date>-<sessionId>/summary.md`). The filter,
`dateFromPath` in `packages/memory/src/retrieval.ts:112-146`, only reads a
date from the start of a path segment. For every other kind, arcs, realms,
person pages, the constitution, and weekly rollups, the path carries no
date, and an undated hit is never excluded by a date filter
(`packages/memory/src/retrieval.ts:114-116`). In practice this means a
date-filtered search over-includes: an arc or person page can show up in
results for a date range it has nothing to do with. The `search_memory` tool
description makes no mention of this; it describes the filter as if it
applied uniformly. A spec at
`docs/superpowers/specs/2026-08-16-context-and-retrieval-design.md` is in
progress to address this. As of this writing the fix it describes is not
implemented in code, regardless of the spec's own state.

**Entities are not searchable.** Entities (books, films, companies, places,
and the like) only ever get a graph node, never a document, so they never
enter the SQLite index and never appear in `search_memory` results. The same
is true of a person who has been mentioned but has not yet earned a page:
they exist as a node in the graph, reachable by graph traversal from
something that names them, but there is no document for search to find.
