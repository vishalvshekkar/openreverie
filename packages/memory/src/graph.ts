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

import { z } from 'zod'
import type { ResolvedWindow } from './commitmentTime.js'
import type { MemoryPaths } from './paths.js'

// NODE_TYPES and EDGE_TYPES are the single source of truth for the graph
// vocabulary. NodeType and EdgeType are derived from these arrays, and the
// record schemas below build their z.enum from the same arrays, so there is
// exactly one place in this file that lists the members. Before this
// change, the type union above and the z.enum in nodeRecordSchema were two
// hand written copies that a reviewer had to check matched by eye. Other
// packages (server, web) keep their own copies of this vocabulary for
// reasons documented at each copy; when adding a member here, update those
// too, and see their guard tests.
export const NODE_TYPES = [
  'realm',
  'arc',
  'item',
  'session',
  'person',
  'entity',
  'commitment',
] as const
export type NodeType = (typeof NODE_TYPES)[number]

export const EDGE_TYPES = ['part_of', 'in', 'from', 'involves', 'relates_to', 'waits_on'] as const
export type EdgeType = (typeof EDGE_TYPES)[number]

// Task 1 added the 'commitment' node type and the 'waits_on' edge to the
// vocabulary above but deliberately left NodeRecord's shape untouched. Task 3
// (the commitment record itself) is where the structured payload belongs,
// so it is added here rather than bolted on elsewhere.
//
// Where this data lives is a deliberate choice, not the default: NodeRecord
// already has one place to put arbitrary prose, `label`, and searchNodes
// (sqlite.ts) tokenizes and matches search queries against exactly that
// field for the node lane of retrieval. Encoding a commitment's structured
// fields (flavor, state, timing...) as JSON inside `label` would make
// commitments record correctly and retrieve badly: a JSON blob does not
// read as the words a person would search for. So `label` stays the plain,
// human-readable sentence ("See Nightfall with Arjun"), and the structured
// data lives in this sibling field, validated by nodeRecordSchema the same
// way `label` and `doc` already are.
export type CommitmentFlavor = 'errand' | 'plan'
export type CommitmentState = 'open' | 'done' | 'dropped' | 'unknown' | 'quiet'

export interface CommitmentInterpretation {
  // How precisely the PERSON spoke: 'period' for a named span such as a
  // season ("come summer"), 'vague' for anything looser ("someday",
  // "at some point"). This is distinct from interpretationConfidence
  // below, which is how sure OUR reading is. The two come apart on
  // purpose (spec Section 3, "Two fields, not one"): "come summer" is
  // vague speech that we may bracket well, while "next Friday" sounds
  // precise but our bracket for it is a coin flip. Conflating them into
  // one field was the earlier draft's mistake.
  statedPrecision: 'period' | 'vague'
  gloss: string
  bracketFrom?: string
  bracketTo?: string
  interpretationConfidence: 'high' | 'medium' | 'low'
}

export interface CommitmentTiming {
  // The person's own words, always, never overwritten.
  words: string
  // When they said it. ISO instant.
  anchor: string
  // Present only when the resolver was certain. Marker: this was stated.
  // ResolvedWindow already carries its own statedPrecision ('day' | 'range'),
  // so the "how precisely did the person speak" field exists on this branch
  // too, not only on the interpreted one below.
  resolved?: ResolvedWindow
  // Present only when the resolver refused. Marker: this was interpreted.
  interpretation?: CommitmentInterpretation
}

export interface CommitmentPayload {
  flavor: CommitmentFlavor
  state: CommitmentState
  timing?: CommitmentTiming
  waitsOn?: string
  askedAt?: string
  sessionId: string
}

export interface NodeRecord {
  ts: string
  op: 'assert' | 'retract'
  node: string
  type: NodeType
  label: string
  doc?: string
  // Only meaningful when type is 'commitment'. See the comment above
  // CommitmentPayload for why this is a sibling field rather than JSON
  // packed into label.
  commitment?: CommitmentPayload
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

export interface SequencedGraphRecord {
  sequence: number
  record: GraphRecord
}

const resolvedWindowSchema = z.object({
  from: z.string(),
  to: z.string(),
  statedPrecision: z.enum(['day', 'range']),
})

const commitmentInterpretationSchema = z.object({
  statedPrecision: z.enum(['period', 'vague']),
  gloss: z.string(),
  bracketFrom: z.string().optional(),
  bracketTo: z.string().optional(),
  interpretationConfidence: z.enum(['high', 'medium', 'low']),
})

const commitmentTimingSchema = z
  .object({
    words: z.string(),
    anchor: z.string(),
    resolved: resolvedWindowSchema.optional(),
    interpretation: commitmentInterpretationSchema.optional(),
  })
  // The marker invariant from spec Section 3: resolved and interpretation
  // are mutually exclusive, and a reader must always be able to tell a
  // stated window from an interpreted one. Enforced here, not by
  // convention, so a record that violates it can never reach the log.
  .refine((timing) => !(timing.resolved !== undefined && timing.interpretation !== undefined), {
    message:
      'commitment timing cannot carry both a resolved window and an interpretation: exactly one marks whether the window was stated or guessed',
  })

// Exported so commitments.ts (and tests) can validate a commitment payload
// before it ever reaches appendGraph, with an error that names the actual
// problem instead of the generic "does not match node or edge shape"
// message appendGraph's own re-validation would produce.
export const commitmentPayloadSchema = z.object({
  flavor: z.enum(['errand', 'plan']),
  state: z.enum(['open', 'done', 'dropped', 'unknown', 'quiet']),
  timing: commitmentTimingSchema.optional(),
  waitsOn: z.string().optional(),
  askedAt: z.string().optional(),
  sessionId: z.string(),
})

// Exported so callers that need to validate a record shape independently of
// appendGraph/readGraph (e.g. reflection.ts, or tests) can reuse the exact
// rules the graph log enforces, instead of re-deriving them.
export const nodeRecordSchema = z.object({
  ts: z.string(),
  op: z.enum(['assert', 'retract']),
  node: z.string(),
  type: z.enum(NODE_TYPES),
  label: z.string(),
  doc: z.string().optional(),
  commitment: commitmentPayloadSchema.optional(),
})

export const edgeRecordSchema = z.object({
  ts: z.string(),
  op: z.enum(['assert', 'retract']),
  edge: z.enum(EDGE_TYPES),
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
  commitment?: CommitmentPayload
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
        ...(record.commitment !== undefined ? { commitment: record.commitment } : {}),
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
  const lines = records.map((record) => JSON.stringify(record))
  await paths.logs.appendLines(paths.graphLog, lines)
}

interface GraphLogLine {
  record: GraphRecord
  sourceLine: number
}

// sourceLine numbers lines by their index in the split file content (1
// based), which readAll's own contract preserves: it only drops the one
// trailing empty string that a trailing newline produces, never an
// interior blank line, so a blank line here still consumes a line number
// exactly as it did when this function read and split the file itself.
async function readGraphLines(paths: MemoryPaths): Promise<GraphLogLine[]> {
  const lines = await paths.logs.readAll(paths.graphLog)
  const records: GraphLogLine[] = []
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
    records.push({ record: validation.data, sourceLine: i + 1 })
  }

  return records
}

export async function readGraphRecords(paths: MemoryPaths): Promise<SequencedGraphRecord[]> {
  const lines = await readGraphLines(paths)
  return lines.map(({ record, sourceLine }) => ({ sequence: sourceLine, record }))
}

export async function readGraph(paths: MemoryPaths): Promise<GraphState> {
  const lines = await readGraphLines(paths)
  return foldGraph(lines.map(({ record }) => record))
}
