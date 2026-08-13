// The graph log: an append-only JSONL file of node and edge assertions and
// retractions. This file is the record of relationships between people,
// realms, arcs, items, sessions, and entities. Prose files may talk about
// relationships, but the graph log is what queries fold into current state.
//
// Fold semantics: records are applied in file order, later records win.
// A retract removes the node or edge from current state but the assertion
// and retraction both stay in the file, so history is never lost. A node
// retract does not cascade to its edges; edges pointing at a missing node
// are left dangling and callers skip them when they matter.

import { appendFile, readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { MemoryPaths } from './paths.js'

export type NodeType = 'realm' | 'arc' | 'item' | 'session' | 'person' | 'entity'
export type EdgeType = 'part_of' | 'in' | 'from' | 'involves' | 'relates_to'

export interface NodeRecord {
  ts: string
  op: 'assert' | 'retract'
  node: string
  type: NodeType
  label: string
  doc?: string
}

export interface EdgeRecord {
  ts: string
  op: 'assert' | 'retract'
  edge: EdgeType
  from: string
  to: string
  confidence: number
  source?: string
  confirmed: boolean
}

export type GraphRecord = NodeRecord | EdgeRecord

// Exported so callers that need to validate a record shape independently of
// appendGraph/readGraph (e.g. reflection.ts, or tests) can reuse the exact
// rules the graph log enforces, instead of re-deriving them.
export const nodeRecordSchema = z.object({
  ts: z.string(),
  op: z.enum(['assert', 'retract']),
  node: z.string(),
  type: z.enum(['realm', 'arc', 'item', 'session', 'person', 'entity']),
  label: z.string(),
  doc: z.string().optional(),
})

export const edgeRecordSchema = z.object({
  ts: z.string(),
  op: z.enum(['assert', 'retract']),
  edge: z.enum(['part_of', 'in', 'from', 'involves', 'relates_to']),
  from: z.string(),
  to: z.string(),
  confidence: z.number().min(0).max(1),
  source: z.string().optional(),
  confirmed: z.boolean(),
})

export interface GraphNode {
  id: string
  type: NodeType
  label: string
  doc?: string
  ts: string
}

export interface GraphEdge {
  edge: EdgeType
  from: string
  to: string
  confidence: number
  source?: string
  confirmed: boolean
  ts: string
}

export interface GraphState {
  nodes: Map<string, GraphNode>
  edges: Map<string, GraphEdge>
}

function isNodeRecord(record: GraphRecord): record is NodeRecord {
  return 'node' in record
}

export function edgeKey(e: { edge: EdgeType; from: string; to: string }): string {
  return `${e.edge}:${e.from}:${e.to}`
}

export function foldGraph(records: GraphRecord[]): GraphState {
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()

  for (const record of records) {
    if (isNodeRecord(record)) {
      if (record.op === 'retract') {
        nodes.delete(record.node)
        continue
      }
      nodes.set(record.node, {
        id: record.node,
        type: record.type,
        label: record.label,
        ...(record.doc !== undefined ? { doc: record.doc } : {}),
        ts: record.ts,
      })
      continue
    }

    const key = edgeKey(record)
    if (record.op === 'retract') {
      edges.delete(key)
      continue
    }
    edges.set(key, {
      edge: record.edge,
      from: record.from,
      to: record.to,
      confidence: record.confidence,
      ...(record.source !== undefined ? { source: record.source } : {}),
      confirmed: record.confirmed,
      ts: record.ts,
    })
  }

  return { nodes, edges }
}

interface RecordValidation {
  success: boolean
  data?: GraphRecord
  error?: string
}

// Shared shape check for both the write path (appendGraph) and the read
// path (readGraph), so a record that would fail to parse back off disk can
// never be appended in the first place.
function parseGraphRecord(parsed: unknown): RecordValidation {
  const nodeValidation = nodeRecordSchema.safeParse(parsed)
  if (nodeValidation.success) {
    return { success: true, data: nodeValidation.data as NodeRecord }
  }

  const edgeValidation = edgeRecordSchema.safeParse(parsed)
  if (edgeValidation.success) {
    return { success: true, data: edgeValidation.data as EdgeRecord }
  }

  return { success: false, error: edgeValidation.error.message }
}

export async function appendGraph(paths: MemoryPaths, records: GraphRecord[]): Promise<void> {
  if (records.length === 0) {
    return
  }
  for (let i = 0; i < records.length; i++) {
    const validation = parseGraphRecord(records[i])
    if (!validation.success) {
      throw new Error(`Cannot append graph record at index ${i}: ${validation.error}`)
    }
  }
  const lines = records.map((record) => `${JSON.stringify(record)}\n`).join('')
  await appendFile(paths.graphLog, lines, 'utf8')
}

export async function readGraph(paths: MemoryPaths): Promise<GraphState> {
  let raw: string
  try {
    raw = await readFile(paths.graphLog, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return foldGraph([])
    }
    throw err
  }

  const records: GraphRecord[] = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined || line.trim() === '') {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Graph log ${paths.graphLog} line ${i + 1} is not valid JSON: ${message}`)
    }

    const validation = parseGraphRecord(parsed)
    if (!validation.success || !validation.data) {
      throw new Error(`Graph log ${paths.graphLog} line ${i + 1}: ${validation.error}`)
    }
    records.push(validation.data)
  }

  return foldGraph(records)
}
