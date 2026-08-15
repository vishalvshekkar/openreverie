import { Buffer } from 'node:buffer'
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
