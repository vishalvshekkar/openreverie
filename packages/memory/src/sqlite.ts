// The SQLite index: FTS5 over prose chunks, cosine vector search over
// embeddings, and materialized node and edge tables folded from
// graph.jsonl. Everything in here is derived and disposable. Nothing may
// exist only in this database; a fresh index can always be rebuilt from
// the markdown files and the graph log.

import { stat } from 'node:fs/promises'
import Database from 'better-sqlite3'
import type { Document } from './documents.js'
import type { EdgeType, GraphEdge, GraphNode, GraphState, NodeType } from './graph.js'

export type DocKind =
  | 'constitution'
  | 'realm'
  | 'arc'
  | 'summary'
  | 'rollup_daily'
  | 'rollup_weekly'

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
  snippet: string
  score: number
}

export type EmbedFn = (texts: string[]) => Promise<number[][]>

const MAX_CHUNK_CHARS = 1200

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

  private constructor(db: Database.Database) {
    this.db = db
    this.initSchema()
  }

  static open(dbPath: string): MemoryIndex {
    const db = new Database(dbPath)
    return new MemoryIndex(db)
  }

  close(): void {
    this.db.close()
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        mtime TEXT NOT NULL
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

    const run = this.db.transaction(() => {
      this.deleteChunksForDoc(docId)

      this.db
        .prepare(
          `INSERT INTO documents (id, path, kind, mtime) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET path = excluded.path, kind = excluded.kind, mtime = excluded.mtime`,
        )
        .run(docId, doc.path, kind, mtime)

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

  searchText(query: string, limit: number, kinds?: DocKind[]): SearchHit[] {
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
    const rows = this.db
      .prepare(
        `SELECT d.id as docId, d.path as path, d.kind as kind,
                snippet(chunks_fts, 0, '', '', '...', 12) as snippet,
                chunks_fts.rank as rank
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         JOIN documents d ON d.id = c.doc_id
         WHERE chunks_fts MATCH ? ${kindClause}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, ...(kinds ?? []), limit) as (DocumentRow & { snippet: string; rank: number })[]

    return rows.map((row) => ({
      docId: row.docId,
      path: row.path,
      kind: row.kind,
      snippet: row.snippet,
      score: -row.rank,
    }))
  }

  async searchVector(queryVec: number[], limit: number, kinds?: DocKind[]): Promise<SearchHit[]> {
    if (kinds && kinds.length === 0) {
      return []
    }
    const kindClause = kinds ? `WHERE d.kind IN (${kinds.map(() => '?').join(', ')})` : ''
    const rows = this.db
      .prepare(
        `SELECT e.vector as vector, d.id as docId, d.path as path, d.kind as kind, c.text as text
         FROM embeddings e
         JOIN chunks c ON c.id = e.chunk_id
         JOIN documents d ON d.id = c.doc_id
         ${kindClause}`,
      )
      .all(...(kinds ?? [])) as {
      vector: Buffer
      docId: string
      path: string
      kind: DocKind
      text: string
    }[]

    const scored: SearchHit[] = rows.map((row) => ({
      docId: row.docId,
      path: row.path,
      kind: row.kind,
      snippet: makeSnippet(row.text),
      score: cosineSimilarity(queryVec, blobToVector(row.vector)),
    }))

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
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
    for (const item of items) {
      chunks.push(itemChunkText(item))
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

function itemChunkText(item: unknown): string {
  const record = item as { id?: unknown; text?: unknown }
  const id = typeof record.id === 'string' ? record.id : ''
  const text = typeof record.text === 'string' ? record.text : ''
  return `${id}: ${text}`
}

// Builds an FTS5 MATCH expression from free text. Each word is wrapped as
// a quoted phrase so punctuation and FTS operator characters (hyphens,
// colons, apostrophes) never reach the query parser as syntax. Returns
// null for a query with no words, so callers can skip the query entirely
// instead of asking FTS5 to match on nothing.
function toFtsQuery(query: string): string | null {
  const terms = query.trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) {
    return null
  }
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' ')
}

function makeSnippet(text: string, maxChars = 200): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text
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
