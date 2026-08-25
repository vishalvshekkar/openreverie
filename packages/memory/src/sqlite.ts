// The SQLite index: FTS5 over prose chunks, cosine vector search over
// embeddings, and materialized node and edge tables folded from
// graph.jsonl. Everything in here is derived and disposable. Nothing may
// exist only in this database; a fresh index can always be rebuilt from
// the markdown files and the graph log.

import { stat } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { documentDateSpan } from './dateSpan.js'
import type { Document } from './documents.js'
import type { EdgeType, GraphEdge, GraphNode, GraphState, NodeType } from './graph.js'

// The closed set of document kinds, kept as a const array so the
// table-driven wiring test (packages/core/src/docKinds.test.ts) can
// enumerate the union at runtime. Adding a kind here and wiring none of its
// touchpoints makes that test fail, which is the enforcement mechanism for
// the P8 rule: every document type must declare how the model reads it.
export const DOC_KINDS = [
  'constitution',
  'realm',
  'arc',
  'summary',
  'rollup_daily',
  'rollup_weekly',
  'person',
  'journal',
  'journaling',
  'dream',
  'dream_insight',
] as const

export type DocKind = (typeof DOC_KINDS)[number]

export interface IndexedChunk {
  docId: string
  path: string
  kind: DocKind
  seq: number
  text: string
}

export interface SearchHit {
  docId: string
  path: string
  kind: DocKind
  // The chunk's own text, verbatim, not a lane-rendered approximation of
  // it. Both searchText and searchVector join the chunks table already
  // (for identity and, previously, for the vector lane's truncation), so
  // this is simply c.text: the same row a direct read_document call would
  // eventually reach anyway. It used to differ by lane (searchText's
  // snippet(chunks_fts, ...) windowed to 12 tokens around the match,
  // searchVector's makeSnippet cut at 200 characters), which meant a chunk
  // matched by only one lane reached retrieval.ts's payload as a fragment.
  // Bounded by construction, not by truncation here: chunks are split to
  // at most MAX_CHUNK_CHARS (1200) at index time (paragraphChunks), so this
  // field never exceeds that regardless of chunk content.
  snippet: string
  score: number
  // The document's date span (documentDateSpan, written at index time),
  // start and end always present together or not at all. A dated kind
  // (summary, rollup_daily, rollup_weekly, journal) carries it. A living
  // document (constitution, realm, arc, person, journaling) has no single
  // date and the keys are omitted entirely here, not sent as null: a
  // guessed or defaulted date is worse than no date, so absence has to be
  // visibly absence, not a value a careless caller could render as one.
  dateStart?: string
  dateEnd?: string
  // The chunk's position within its document (chunks.seq), 0-indexed.
  // Populated on every chunk-level hit returned by searchText and
  // searchVector: a single physical chunk can be matched by both lanes,
  // and docId+seq is the stable identity retrieval.ts uses to recognize
  // that as one chunk rather than two. Optional, not required, because
  // the fused, document-level hit searchMemory returns is no longer one
  // chunk (see DocumentHit in retrieval.ts) and carries no single seq.
  seq?: number
}

// A graph node whose name matched a search query. Separate from SearchHit
// on purpose: a node has no chunk, no FTS rank and no cosine score, so it
// carries no score at all rather than an invented one.
export interface NodeMatch {
  id: string
  type: NodeType
  label: string
  doc: string | null
  ts: string
}

export type EmbedFn = (texts: string[]) => Promise<number[][]>

const MAX_CHUNK_CHARS = 1200

// Bumped whenever the derived document tables change shape. On open, an
// index.db carrying a lower version has those tables dropped and recreated,
// and MemoryEngine.open rebuilds them from the memory folder.
export const INDEX_SCHEMA_VERSION = 2

interface DocumentRow {
  docId: string
  path: string
  kind: DocKind
}

interface NodeRow {
  id: string
  type: NodeType
  label: string
  doc: string | null
  ts: string
}

interface EdgeRow {
  edge: EdgeType
  from_id: string
  to_id: string
  confidence: number
  confirmed: number
  ts: string
}

export class MemoryIndex {
  private readonly db: Database.Database
  readonly schemaRebuilt: boolean

  private constructor(db: Database.Database) {
    this.db = db
    this.schemaRebuilt = this.initSchema()
  }

  static open(dbPath: string): MemoryIndex {
    const db = new Database(dbPath)
    return new MemoryIndex(db)
  }

  close(): void {
    this.db.close()
  }

  // Reads PRAGMA user_version and brings the derived document tables up to
  // INDEX_SCHEMA_VERSION. Returns true only when there was an older index
  // to migrate, so a caller can rebuild it.
  //
  // Migration is drop-and-recreate, not ALTER TABLE. Everything in these
  // four tables is derived from the markdown files on disk and can be
  // rebuilt exactly, so carrying rows forward buys nothing and every future
  // schema change would need its own hand-written ALTER path. `nodes` and
  // `edges` are left alone: replaceGraph already rewrites both wholesale on
  // every engine open.
  //
  // A fresh database and a stale one both start at user_version 0, so the
  // presence of the `documents` table in sqlite_master is what tells them
  // apart. Without that check every brand-new memory folder would report a
  // migration that never happened.
  private initSchema(): boolean {
    const storedVersion = Number(this.db.pragma('user_version', { simple: true }) ?? 0)
    if (storedVersion >= INDEX_SCHEMA_VERSION) {
      this.createTables()
      return false
    }

    const hadDocuments =
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'documents'")
        .get() !== undefined

    if (hadDocuments) {
      // chunks_fts first: it is an external-content FTS5 table over chunks,
      // so dropping it before its content table keeps the drop of its
      // shadow tables uncomplicated.
      this.db.exec(`
        DROP TABLE IF EXISTS chunks_fts;
        DROP TABLE IF EXISTS embeddings;
        DROP TABLE IF EXISTS chunks;
        DROP TABLE IF EXISTS documents;
      `)
    }

    this.createTables()
    this.db.pragma(`user_version = ${INDEX_SCHEMA_VERSION}`)
    return hadDocuments
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        mtime TEXT NOT NULL,
        date_start TEXT,
        date_end TEXT
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        text TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        content='chunks',
        content_rowid='id'
      );

      CREATE TABLE IF NOT EXISTS embeddings (
        chunk_id INTEGER PRIMARY KEY,
        vector BLOB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        label TEXT NOT NULL,
        doc TEXT,
        ts TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS edges (
        edge TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        confidence REAL NOT NULL,
        confirmed INTEGER NOT NULL,
        ts TEXT NOT NULL,
        PRIMARY KEY (edge, from_id, to_id)
      );
    `)
  }

  async upsertDocument(doc: Document, kind: DocKind, embed: EmbedFn): Promise<void> {
    const docId = doc.meta.id
    const texts = buildChunks(doc)
    const vectors = texts.length > 0 ? await embed(texts) : []
    const mtime = await fileMtime(doc.path)
    // Null for living documents (the constitution, and realm, arc and person
    // pages) by design, so an after/before filter never excludes them. See
    // dateSpan.ts for why no date is better than a wrong one here.
    const span = documentDateSpan(kind, doc.meta)

    const run = this.db.transaction(() => {
      this.deleteChunksForDoc(docId)

      this.db
        .prepare(
          `INSERT INTO documents (id, path, kind, mtime, date_start, date_end)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             path = excluded.path,
             kind = excluded.kind,
             mtime = excluded.mtime,
             date_start = excluded.date_start,
             date_end = excluded.date_end`,
        )
        .run(docId, doc.path, kind, mtime, span?.start ?? null, span?.end ?? null)

      const insertChunk = this.db.prepare('INSERT INTO chunks (doc_id, seq, text) VALUES (?, ?, ?)')
      const insertFts = this.db.prepare('INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)')
      const insertEmbedding = this.db.prepare(
        'INSERT INTO embeddings (chunk_id, vector) VALUES (?, ?)',
      )

      texts.forEach((text, seq) => {
        const info = insertChunk.run(docId, seq, text)
        const chunkId = Number(info.lastInsertRowid)
        insertFts.run(chunkId, text)
        const vector = vectors[seq]
        if (vector) {
          insertEmbedding.run(chunkId, vectorToBlob(vector))
        }
      })
    })
    run()
  }

  // True full-rebuild wipe: clears every document, chunk, embedding, and
  // FTS row in one transaction, leaving the schema intact and ready for a
  // fresh set of upsertDocument calls to rebuild from. Nodes and edges
  // (folded from graph.jsonl via replaceGraph) are untouched; this only
  // covers the prose/document side of the index.
  wipeAllDocuments(): void {
    const run = this.db.transaction(() => {
      this.db.exec('DELETE FROM embeddings;')
      this.db.exec('DELETE FROM chunks;')
      this.db.exec('DELETE FROM documents;')
      // chunks_fts is an external-content FTS5 table (content='chunks'):
      // deleting the underlying chunks rows directly does not update its
      // shadow tables on its own, so 'rebuild' resyncs it against the
      // now-empty chunks table instead of leaving stale FTS entries
      // behind.
      this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')")
    })
    run()
  }

  // Path collision self-heal: removes any row whose path matches `path`
  // but whose id is not `keepId`. Callers use this immediately before
  // indexing the current, authoritative document at that path, so any
  // other row still sitting at the same path is necessarily stale (e.g. a
  // previous doc id superseded when a file like summary.md is rewritten
  // with a freshly minted id on every reflection). Deliberately keyed on
  // path rather than id, since documents are otherwise looked up by id
  // only, which is exactly what lets a stale id linger unnoticed.
  removeDocumentsAtPath(path: string, keepId: string): void {
    const run = this.db.transaction(() => {
      const staleRows = this.db
        .prepare('SELECT id FROM documents WHERE path = ? AND id != ?')
        .all(path, keepId) as { id: string }[]
      for (const stale of staleRows) {
        this.deleteChunksForDoc(stale.id)
        this.db.prepare('DELETE FROM documents WHERE id = ?').run(stale.id)
      }
    })
    run()
  }

  removeDocument(docId: string): void {
    const run = this.db.transaction(() => {
      this.deleteChunksForDoc(docId)
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(docId)
    })
    run()
  }

  private deleteChunksForDoc(docId: string): void {
    const chunks = this.db.prepare('SELECT id, text FROM chunks WHERE doc_id = ?').all(docId) as {
      id: number
      text: string
    }[]

    const deleteFtsEntry = this.db.prepare(
      "INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', ?, ?)",
    )
    const deleteEmbedding = this.db.prepare('DELETE FROM embeddings WHERE chunk_id = ?')

    for (const chunk of chunks) {
      deleteFtsEntry.run(chunk.id, chunk.text)
      deleteEmbedding.run(chunk.id)
    }

    this.db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(docId)
  }

  replaceGraph(graph: GraphState): void {
    const run = this.db.transaction(() => {
      this.db.exec('DELETE FROM edges; DELETE FROM nodes;')

      const insertNode = this.db.prepare(
        'INSERT INTO nodes (id, type, label, doc, ts) VALUES (?, ?, ?, ?, ?)',
      )
      for (const node of graph.nodes.values()) {
        insertNode.run(node.id, node.type, node.label, node.doc ?? null, node.ts)
      }

      const insertEdge = this.db.prepare(
        'INSERT INTO edges (edge, from_id, to_id, confidence, confirmed, ts) VALUES (?, ?, ?, ?, ?, ?)',
      )
      for (const edge of graph.edges.values()) {
        if (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) {
          continue
        }
        insertEdge.run(
          edge.edge,
          edge.from,
          edge.to,
          edge.confidence,
          edge.confirmed ? 1 : 0,
          edge.ts,
        )
      }
    })
    run()
  }

  searchText(
    query: string,
    limit: number,
    kinds?: DocKind[],
    after?: string,
    before?: string,
  ): SearchHit[] {
    const ftsQuery = toFtsQuery(query)
    if (ftsQuery === null) {
      return []
    }
    // An explicit but empty kinds list matches nothing, same as the old
    // post-fusion `.includes` check on an empty array did. Short-circuit
    // rather than emit `IN ()`, which is invalid SQL.
    if (kinds && kinds.length === 0) {
      return []
    }
    // Values are always bound as parameters, never interpolated into the
    // SQL string; only the placeholder count (one '?' per kind) varies.
    const kindClause = kinds ? `AND d.kind IN (${kinds.map(() => '?').join(', ')})` : ''
    const dates = dateClause(after, before)
    const rows = this.db
      .prepare(
        `SELECT d.id as docId, d.path as path, d.kind as kind,
                d.date_start as dateStart, d.date_end as dateEnd, c.seq as seq,
                c.text as text,
                chunks_fts.rank as rank
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         JOIN documents d ON d.id = c.doc_id
         WHERE chunks_fts MATCH ? ${kindClause} ${dates.sql}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, ...(kinds ?? []), ...dates.params, limit) as (DocumentRow & {
      dateStart: string | null
      dateEnd: string | null
      seq: number
      text: string
      rank: number
    })[]

    return rows.map((row) => ({
      docId: row.docId,
      path: row.path,
      kind: row.kind,
      snippet: row.text,
      score: -row.rank,
      seq: row.seq,
      ...dateSpanFields(row.dateStart, row.dateEnd),
    }))
  }

  async searchVector(
    queryVec: number[],
    limit: number,
    kinds?: DocKind[],
    after?: string,
    before?: string,
  ): Promise<SearchHit[]> {
    if (kinds && kinds.length === 0) {
      return []
    }
    const predicates: string[] = []
    const params: (string | DocKind)[] = []
    if (kinds) {
      predicates.push(`d.kind IN (${kinds.map(() => '?').join(', ')})`)
      params.push(...kinds)
    }
    const dates = dateClause(after, before)
    if (dates.sql.length > 0) {
      // dateClause returns its predicate already prefixed with AND, for the
      // searchText query where it is never first. Here it can be first, so
      // the prefix is stripped.
      predicates.push(dates.sql.replace(/^AND /, ''))
      params.push(...dates.params)
    }
    const whereClause = predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT e.vector as vector, d.id as docId, d.path as path, d.kind as kind,
                d.date_start as dateStart, d.date_end as dateEnd, c.seq as seq, c.text as text
         FROM embeddings e
         JOIN chunks c ON c.id = e.chunk_id
         JOIN documents d ON d.id = c.doc_id
         ${whereClause}`,
      )
      .all(...params) as {
      vector: Buffer
      docId: string
      path: string
      kind: DocKind
      dateStart: string | null
      dateEnd: string | null
      seq: number
      text: string
    }[]

    const scored: SearchHit[] = rows.map((row) => ({
      docId: row.docId,
      path: row.path,
      kind: row.kind,
      snippet: row.text,
      score: cosineSimilarity(queryVec, blobToVector(row.vector)),
      seq: row.seq,
      ...dateSpanFields(row.dateStart, row.dateEnd),
    }))

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  // A full scan of the nodes table, case-folded, matched by substring. See
  // the comment on nodeQueryTokens for the matching rule, and the spec for
  // why this is a scan rather than an FTS5 table: node counts are in the
  // hundreds to low thousands, replaceGraph rewrites this table wholesale on
  // every open, and name lookup wants mid-token substring behavior that FTS5
  // does not give.
  searchNodes(query: string, limit: number): NodeMatch[] {
    const tokens = nodeQueryTokens(query)
    if (tokens.length === 0) {
      return []
    }
    const rows = this.db.prepare('SELECT id, type, label, doc, ts FROM nodes').all() as NodeRow[]

    const scored: { row: NodeRow; tier: number }[] = []
    for (const row of rows) {
      const label = row.label.toLowerCase()
      let tier = 3
      for (const token of tokens) {
        if (label === token) {
          tier = Math.min(tier, 0)
        } else if (label.startsWith(token)) {
          tier = Math.min(tier, 1)
        } else if (label.includes(token)) {
          tier = Math.min(tier, 2)
        }
      }
      if (tier < 3) {
        scored.push({ row, tier })
      }
    }

    scored.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier
      if (a.row.ts !== b.row.ts) return a.row.ts > b.row.ts ? -1 : 1
      return a.row.id < b.row.id ? 1 : a.row.id > b.row.id ? -1 : 0
    })

    return scored.slice(0, limit).map(({ row }) => ({
      id: row.id,
      type: row.type,
      label: row.label,
      doc: row.doc,
      ts: row.ts,
    }))
  }

  neighbors(nodeId: string): { edge: GraphEdge; node: GraphNode }[] {
    const rows = this.db
      .prepare(
        `SELECT edge, from_id, to_id, confidence, confirmed, ts
         FROM edges
         WHERE from_id = ? OR to_id = ?`,
      )
      .all(nodeId, nodeId) as EdgeRow[]

    const result: { edge: GraphEdge; node: GraphNode }[] = []
    for (const row of rows) {
      const otherId = row.from_id === nodeId ? row.to_id : row.from_id
      const node = this.nodeById(otherId)
      if (!node) {
        continue
      }
      result.push({ edge: rowToEdge(row), node })
    }
    return result
  }

  itemsInArc(arcId: string): GraphNode[] {
    const rows = this.db
      .prepare(
        `SELECT n.id as id, n.type as type, n.label as label, n.doc as doc, n.ts as ts
         FROM edges e
         JOIN nodes n ON n.id = e.from_id
         WHERE e.edge = 'part_of' AND e.to_id = ?`,
      )
      .all(arcId) as NodeRow[]
    return rows.map(rowToNode)
  }

  arcsInvolvingPerson(personId: string): GraphNode[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT n.id as id, n.type as type, n.label as label, n.doc as doc, n.ts as ts
         FROM edges involves_edge
         JOIN edges part_of_edge
           ON part_of_edge.edge = 'part_of' AND part_of_edge.from_id = involves_edge.from_id
         JOIN nodes n ON n.id = part_of_edge.to_id
         WHERE involves_edge.edge = 'involves' AND involves_edge.to_id = ?`,
      )
      .all(personId) as NodeRow[]
    return rows.map(rowToNode)
  }

  nodeById(nodeId: string): GraphNode | undefined {
    const row = this.db
      .prepare('SELECT id, type, label, doc, ts FROM nodes WHERE id = ?')
      .get(nodeId) as NodeRow | undefined
    return row ? rowToNode(row) : undefined
  }
}

// Projects the documents table's nullable date_start/date_end columns onto
// the object-spread shape SearchHit expects: both keys present when the
// document has a span, neither key present when it does not (a living
// document). documentDateSpan always writes both columns together or
// neither, so checking dateStart alone is enough to decide.
function dateSpanFields(
  dateStart: string | null,
  dateEnd: string | null,
): { dateStart: string; dateEnd: string } | Record<string, never> {
  if (dateStart === null || dateEnd === null) {
    return {}
  }
  return { dateStart, dateEnd }
}

function rowToNode(row: NodeRow): GraphNode {
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    ...(row.doc !== null ? { doc: row.doc } : {}),
    ts: row.ts,
  }
}

function rowToEdge(row: EdgeRow): GraphEdge {
  return {
    edge: row.edge,
    from: row.from_id,
    to: row.to_id,
    confidence: row.confidence,
    confirmed: row.confirmed === 1,
    ts: row.ts,
  }
}

function buildChunks(doc: Document): string[] {
  const chunks = paragraphChunks(doc.body)
  const items = doc.meta.items
  if (Array.isArray(items)) {
    // The document's own date (meta.date on a summary, set by
    // applyReflection to the session's date) is the anchor for any
    // eventTime an item carries. Not item.ts: several fixtures and one
    // hand-written summary.md leave that blank, and recentIntentions in
    // engine.ts already treats the session date as the reliable one.
    const docDate = typeof doc.meta.date === 'string' ? doc.meta.date : undefined
    for (const item of items) {
      chunks.push(itemChunkText(item, docDate))
    }
  }
  return chunks
}

function paragraphChunks(body: string): string[] {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  const chunks: string[] = []
  let current = ''
  for (const paragraph of paragraphs) {
    if (current.length === 0) {
      current = paragraph
      continue
    }
    const candidate = `${current}\n\n${paragraph}`
    if (candidate.length <= MAX_CHUNK_CHARS) {
      current = candidate
    } else {
      chunks.push(current)
      current = paragraph
    }
  }
  if (current.length > 0) {
    chunks.push(current)
  }
  return chunks
}

// The document's own file modification time, so a reindex from the same
// folder produces the same `mtime` value rather than the wall-clock time
// of the reindex run. Falls back to the current time if the file cannot
// be stat'd (a document not yet flushed to disk, or a test fixture path).
async function fileMtime(path: string): Promise<string> {
  try {
    const stats = await stat(path)
    return stats.mtime.toISOString()
  } catch {
    return new Date().toISOString()
  }
}

// docDate anchors eventTime, when present, to the record this item came
// from. The anchor is the person's own wording plus the date it is
// relative to, never a resolved instant: see reflection.ts:332 and the
// time spec (docs/superpowers/specs/2026-08-16-time-as-first-class-design.md,
// section 2) on why eventTime stays free text. An item with no eventTime,
// or a document with no date of its own (a living document has none),
// gets no anchor at all rather than a guessed one.
//
// Ruling 11: this reads raw frontmatter off a summary.md on disk, not a
// schema-validated value. AGENTS.md says truth lives in the user's memory
// folder and SQLite is a derived index that must always be rebuildable
// from it, so this folder is untrusted input the same way LLM output is
// untrusted at a schema boundary: a summary.md written before the four
// write-site fixes (commit 1f602e7), or hand-edited by the person the
// folder-is-truth design explicitly invites, can still carry
// `eventTime: ""`. reindexAll() walks every such file straight into this
// function. Trimmed and treated as absent here too, not only at the four
// write sites, so `typeof eventTime === 'string'` alone is never enough
// to admit it.
function itemChunkText(item: unknown, docDate?: string): string {
  const record = item as { id?: unknown; text?: unknown; eventTime?: unknown }
  const id = typeof record.id === 'string' ? record.id : ''
  const text = typeof record.text === 'string' ? record.text : ''
  const eventTime =
    typeof record.eventTime === 'string' && record.eventTime.trim().length > 0
      ? record.eventTime
      : undefined
  if (eventTime !== undefined && docDate !== undefined) {
    return `${id}: ${text} (eventTime: "${eventTime}", as stated on ${docDate})`
  }
  return `${id}: ${text}`
}

// Builds an FTS5 MATCH expression from free text. Each word is wrapped as
// a quoted phrase so punctuation and FTS operator characters (hyphens,
// colons, apostrophes) never reach the query parser as syntax, which also
// rules out a query-injection path: nothing from `query` is ever unquoted
// FTS5 syntax. Terms are joined with OR, not the whitespace that FTS5
// reads as an implicit AND: a chunk is about one summary item, roughly 100
// characters, and the model writes queries in plain language per the
// search_memory tool description, 10 to 15 tokens long. ANDing them meant
// every single term had to land in the same ~100 characters, which starved
// the lane on almost every real query (defect 5 in
// docs/superpowers/plans/2026-08-24-recall-and-event-time-fixes.md). OR
// lets bm25 do the ranking job it exists for: a chunk matching more terms
// still outranks one matching fewer, ordered by chunks_fts.rank exactly as
// before, just over a much larger candidate set.
//
// A term that tokenizes to nothing under FTS5's own tokenizer (pure
// punctuation, for instance) contributes an empty quoted phrase to the OR
// chain. FTS5 accepts that without error and it simply never matches, so a
// punctuation-only query returns no rows rather than throwing. A
// stopword-only query ("the of and is") is not filtered here: every term
// is still a term, and OR means each one can match on its own. That is
// deliberately not fixed by term selection, because the LIMIT clause in
// searchText already bounds every query, stopword-only or not, to at most
// `limit` rows: there is no path from this function to "return the whole
// corpus".
//
// Returns null for a query with no words at all, so callers can skip the
// query entirely instead of asking FTS5 to match on nothing.
function toFtsQuery(query: string): string | null {
  const terms = query.trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) {
    return null
  }
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
}

// Splits a search query into the tokens the node scan matches on. The query
// is case-folded and split on non-word characters. Tokens shorter than three
// characters are dropped, because a two-letter fragment matches a large
// share of any name list, unless the entire query is one token, in which
// case it is kept: a two-letter nickname is a real name someone might search
// for on its own.
export function nodeQueryTokens(query: string): string[] {
  const raw = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0)
  if (raw.length === 1) {
    return raw
  }
  return raw.filter((token) => token.length >= 3)
}

// The date predicate shared by searchText and searchVector. Filtering is by
// span overlap, not point comparison: a hit passes when its span ends on or
// after `after` and starts on or before `before`. A weekly rollup covering
// Monday through Sunday is therefore returned for any day inside it, which a
// comparison against its Monday alone would get wrong.
//
// A document with a NULL span (the constitution, and realm, arc and person
// pages) always passes. Those are living documents with no single date; see
// dateSpan.ts.
function dateClause(after?: string, before?: string): { sql: string; params: string[] } {
  const halves: string[] = []
  const params: string[] = []
  if (after !== undefined) {
    halves.push('d.date_end >= ?')
    params.push(after)
  }
  if (before !== undefined) {
    halves.push('d.date_start <= ?')
    params.push(before)
  }
  if (halves.length === 0) {
    return { sql: '', params: [] }
  }
  return { sql: `AND (d.date_start IS NULL OR (${halves.join(' AND ')}))`, params }
}

function vectorToBlob(vector: number[]): Buffer {
  const arr = new Float32Array(vector)
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

function blobToVector(blob: Buffer): number[] {
  const bytes = Uint8Array.from(blob)
  const arr = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  return Array.from(arr)
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }
  if (normA === 0 || normB === 0) {
    return 0
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
