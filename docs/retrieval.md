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
4. **Fuse.** The two ranked lists are combined with reciprocal rank fusion
   (`packages/memory/src/retrieval.ts:76-95`): each document's score is the
   sum of `1 / (60 + rank)` over every list it appears in (`RRF_K = 60`),
   deduplicated by document id. There is no reranking model or second pass
   over the fused list; RRF is the entire ranking step. `after`/`before`
   date filters run earlier than this, inside `searchText` and
   `searchVector`'s own SQL, against a date span stored on each document
   row (see Known limitations below).

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

**Date filters are precise for point-in-time documents and deliberately
absent for living ones.** Each document's date span is computed once at
index time by `documentDateSpan` (`packages/memory/src/dateSpan.ts`) and
stored in the `date_start`/`date_end` columns added to `documents`. Session
summaries and daily rollups get a single-day span from their `date`
frontmatter, journal entries get one from `entryDate`, and weekly rollups
get a Monday-to-Sunday span from their `week` frontmatter. `after`/`before`
range-check against that stored span directly in `searchText` and
`searchVector`'s SQL (`dateClause`, `packages/memory/src/sqlite.ts:665-679`).
The constitution, and realm, arc, person, and journaling-protocol documents
are continuously rewritten and have no one date they are about, so
`documentDateSpan` returns null for them, and `dateClause` never excludes a
null-span row no matter what filter is given. That is a stated, tested
property of exactly those kinds, not a residual gap: a date-filtered search
still surfaces an arc or person page outside the requested range, by design,
alongside whichever point-in-time hits the filter actually narrowed. The
`search_memory` tool's own `after`/`before` parameter descriptions
(`packages/core/src/tools.ts:131-148`) state this distinction directly, so
the model is not left to infer it.

**Entities are not searchable.** Entities (books, films, companies, places,
and the like) only ever get a graph node, never a document, so they never
enter the SQLite index and never appear in `search_memory` results. The same
is true of a person who has been mentioned but has not yet earned a page:
they exist as a node in the graph, reachable by graph traversal from
something that names them, but there is no document for search to find.
