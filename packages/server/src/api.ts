import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import type { PublicGraphEdge, PublicGraphNode } from '@openreverie/memory'
import { z } from 'zod'

export const LIMITS = {
  requestBytes: 256 * 1024,
  messageBytes: 64 * 1024,
  queryBytes: 8 * 1024,
  idChars: 256,
  documentBytes: 4 * 1024 * 1024,
  transcriptPageBytes: 4 * 1024 * 1024,
  proposalPageBytes: 2 * 1024 * 1024,
  graphPageBytes: 8 * 1024 * 1024,
  graphEventBytes: 256 * 1024,
} as const

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export type CursorResource = 'sessions' | 'documents' | 'proposals' | 'transcript' | 'graph_events'

export type Cursor =
  | { v: 1; resource: 'sessions'; tuple: [startedAt: string, sessionId: string]; revision: string }
  | {
      v: 1
      resource: 'documents'
      tuple: [kind: string, title: string, docId: string]
      revision: string
    }
  | {
      v: 1
      resource: 'proposals'
      tuple: [createdAt: string, proposalId: string]
      revision: string
    }
  | { v: 1; resource: 'transcript'; tuple: [lineSequence: number]; revision: string }
  | { v: 1; resource: 'graph_events'; tuple: [sequence: number]; revision: string }

const cursorSchemas = [
  z.strictObject({
    v: z.literal(1),
    resource: z.literal('sessions'),
    tuple: z.tuple([z.string(), z.string()]),
    revision: z.string(),
  }),
  z.strictObject({
    v: z.literal(1),
    resource: z.literal('documents'),
    tuple: z.tuple([z.string(), z.string(), z.string()]),
    revision: z.string(),
  }),
  z.strictObject({
    v: z.literal(1),
    resource: z.literal('proposals'),
    tuple: z.tuple([z.string(), z.string()]),
    revision: z.string(),
  }),
  z.strictObject({
    v: z.literal(1),
    resource: z.literal('transcript'),
    tuple: z.tuple([z.number().int().positive()]),
    revision: z.string(),
  }),
  z.strictObject({
    v: z.literal(1),
    resource: z.literal('graph_events'),
    tuple: z.tuple([z.number().int().positive()]),
    revision: z.string(),
  }),
] as const

export const cursorSchema = z.discriminatedUnion('resource', cursorSchemas)

export function encodeCursor(value: Cursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export function decodeCursor<R extends CursorResource>(
  cursor: string,
  resource: R,
  revision: string,
): Extract<Cursor, { resource: R }> {
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    )
    if (!parsed.success || parsed.data.resource !== resource || parsed.data.revision !== revision) {
      throw new Error('invalid')
    }
    return parsed.data as Extract<Cursor, { resource: R }>
  } catch {
    throw new ApiError(400, 'cursor_invalid', 'The cursor is invalid.')
  }
}

export function envelope<T>(data: T, nextCursor: string | null) {
  return { data, meta: { nextCursor } }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    )
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('Canonical JSON does not support undefined.')
  return serialized
}

export function makeGraphSnapshot(graph: { nodes: PublicGraphNode[]; edges: PublicGraphEdge[] }): {
  revision: string
  nodes: PublicGraphNode[]
  edges: PublicGraphEdge[]
} {
  const nodes = [...graph.nodes].sort(
    (a, b) => a.assertedAt.localeCompare(b.assertedAt) || a.id.localeCompare(b.id),
  )
  const edges = [...graph.edges].sort(
    (a, b) => a.assertedAt.localeCompare(b.assertedAt) || a.key.localeCompare(b.key),
  )
  const bytes = Buffer.from(canonicalJson({ nodes, edges }), 'utf8')
  if (bytes.byteLength > LIMITS.graphPageBytes) {
    throw new ApiError(413, 'graph_snapshot_too_large', 'The graph snapshot is too large.')
  }
  return { revision: createHash('sha256').update(bytes).digest('hex'), nodes, edges }
}

export function parsePageLimit(value: string | null, fallback: number, maximum: number): number {
  if (value === null) return fallback
  if (!/^[1-9]\d*$/.test(value)) {
    throw new ApiError(400, 'invalid_request', 'The limit is invalid.')
  }
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit > maximum) {
    throw new ApiError(400, 'invalid_request', 'The limit is invalid.')
  }
  return limit
}
