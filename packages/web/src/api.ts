import { z } from 'zod'

const responseMetaSchema = z.strictObject({ nextCursor: z.string().nullable() })

function responseSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({ data, meta: responseMetaSchema })
}

const documentKindSchema = z.enum([
  'constitution',
  'realm',
  'arc',
  'summary',
  'rollup_daily',
  'rollup_weekly',
  'person',
])

export const documentRowSchema = z.strictObject({
  docId: z.string(),
  kind: documentKindSchema,
  title: z.string(),
  updatedAt: z.string(),
  readOnly: z.literal(true),
})

export const documentSchema = documentRowSchema.extend({ body: z.string() })

export const sessionSchema = z.strictObject({
  sessionId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(['live', 'ended', 'expired']),
  readOnly: z.boolean(),
  mode: z.string().optional(),
  transcript: z.strictObject({
    lineCount: z.number().int().nonnegative(),
    userCount: z.number().int().nonnegative(),
    assistantCount: z.number().int().nonnegative(),
    toolCount: z.number().int().nonnegative(),
  }),
})

export const createSessionResponseSchema = sessionSchema.extend({
  initialGreetingStreamUrl: z.string().optional(),
})

const toolCallSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
})

export const transcriptLineSchema = z.strictObject({
  lineSequence: z.number().int().positive(),
  ts: z.string(),
  utcOffsetMinutes: z.number().optional(),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z.array(toolCallSchema).optional(),
  toolCallId: z.string().optional(),
  synthetic: z.literal(true).optional(),
})

export const proposalSchema = z.strictObject({
  proposalId: z.string(),
  createdAt: z.string(),
  kind: z.enum(['new_arc', 'new_person', 'link']),
  summary: z.string(),
  sourceSessionId: z.string(),
})

const graphNodeTypeSchema = z.enum(['realm', 'arc', 'item', 'session', 'person', 'entity'])
const graphEdgeTypeSchema = z.enum(['part_of', 'in', 'from', 'involves', 'relates_to'])

export const graphNodeSchema = z.strictObject({
  id: z.string(),
  type: graphNodeTypeSchema,
  label: z.string(),
  docId: z.string().optional(),
  assertedAt: z.string(),
})

export const graphEdgeSchema = z.strictObject({
  key: z.string(),
  type: graphEdgeTypeSchema,
  from: z.string(),
  to: z.string(),
  confidence: z.number().min(0).max(1),
  confirmed: z.boolean(),
  sourceSessionId: z.string().optional(),
  assertedAt: z.string(),
})

export const graphSnapshotSchema = z.strictObject({
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
})

const bootstrapResponseSchema = z.strictObject({ authenticated: z.literal(true) })

const proposalResolutionResponseSchema = z.strictObject({
  proposalId: z.string(),
  resolution: z.enum(['accepted', 'rejected']),
})

const errorBodySchema = z.strictObject({
  schemaVersion: z.literal('1'),
  code: z.string(),
  message: z.string(),
})

export const streamEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    schemaVersion: z.literal('1'),
    seq: z.number().int().positive(),
    type: z.literal('thinking'),
  }),
  z.strictObject({
    schemaVersion: z.literal('1'),
    seq: z.number().int().positive(),
    type: z.literal('text'),
    text: z.string(),
  }),
  z.strictObject({
    schemaVersion: z.literal('1'),
    seq: z.number().int().positive(),
    type: z.literal('tool'),
    name: z.string(),
  }),
  z.strictObject({
    schemaVersion: z.literal('1'),
    seq: z.number().int().positive(),
    type: z.literal('mode'),
    mode: z.string(),
  }),
  z.strictObject({
    schemaVersion: z.literal('1'),
    seq: z.number().int().positive(),
    type: z.literal('done'),
  }),
  z.strictObject({
    schemaVersion: z.literal('1'),
    seq: z.number().int().positive(),
    type: z.literal('error'),
    code: z.enum(['chat_unavailable', 'chat_failed']),
    retryable: z.boolean(),
    message: z.string(),
  }),
])

export type StreamEvent = z.infer<typeof streamEventSchema>
export type Session = z.infer<typeof sessionSchema>
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>
export type DocumentRow = z.infer<typeof documentRowSchema>
export type Document = z.infer<typeof documentSchema>
export type TranscriptLine = z.infer<typeof transcriptLineSchema>
export type Proposal = z.infer<typeof proposalSchema>
export type GraphNode = z.infer<typeof graphNodeSchema>
export type GraphEdge = z.infer<typeof graphEdgeSchema>
export type GraphSnapshot = z.infer<typeof graphSnapshotSchema>

export interface Page<T> {
  data: T[]
  nextCursor: string | null
}

export interface AppApi {
  bootstrap(token: string): Promise<{ authenticated: true }>
  createSession(mode?: string): Promise<CreateSessionResponse>
  setSessionMode(sessionId: string, mode: string): Promise<{ mode: string }>
  listSessions(cursor?: string): Promise<Page<Session>>
  listDocuments(cursor?: string): Promise<Page<DocumentRow>>
  getDocument(docId: string): Promise<Document>
  listProposals(cursor?: string): Promise<Page<Proposal>>
  resolveProposal(
    proposalId: string,
    resolution: 'accepted' | 'rejected',
  ): Promise<{ proposalId: string; resolution: 'accepted' | 'rejected' }>
  message(
    sessionId: string,
    turnId: string,
    message: string,
    after?: number,
  ): Promise<AsyncIterable<StreamEvent>>
  events(sessionId: string, after?: number): Promise<AsyncIterable<StreamEvent>>
  transcript(sessionId: string, cursor?: string): Promise<Page<TranscriptLine>>
  end(sessionId: string): Promise<Session>
  getGraphSnapshot(): Promise<GraphSnapshot>
}

export class ApiHttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiHttpError'
    this.status = status
    this.code = code
  }

  static async from(response: Response): Promise<ApiHttpError> {
    let code = 'internal_error'
    let message = 'The server could not process the request.'
    try {
      const parsed = errorBodySchema.safeParse(await response.json())
      if (parsed.success) {
        code = parsed.data.code
        message = parsed.data.message
      }
    } catch {
      // A non-JSON error body keeps the generic message.
    }
    return new ApiHttpError(response.status, code, message)
  }
}

export class IncompleteStreamError extends Error {
  constructor() {
    super('The stream ended before the turn completed.')
    this.name = 'IncompleteStreamError'
  }
}

export function isTerminalEvent(event: StreamEvent): boolean {
  return event.type === 'done' || event.type === 'error'
}

export function parseStreamEvent(line: string): StreamEvent {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new ApiHttpError(500, 'invalid_stream', 'The stream contained invalid JSON.')
  }
  const parsed = streamEventSchema.safeParse(value)
  if (!parsed.success) {
    throw new ApiHttpError(500, 'invalid_stream', 'The stream contained an invalid event.')
  }
  return parsed.data
}

export async function* decodeNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim() !== '') yield parseStreamEvent(line)
        newline = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.trim() !== '') yield parseStreamEvent(buffer)
  } finally {
    reader.releaseLock()
  }
}

export async function* requireTerminal(
  events: AsyncIterable<StreamEvent>,
): AsyncGenerator<StreamEvent> {
  let terminal = false
  for await (const event of events) {
    terminal ||= isTerminalEvent(event)
    yield event
  }
  if (!terminal) throw new IncompleteStreamError()
}

function withCursor(path: string, cursor?: string): string {
  if (cursor === undefined) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}cursor=${encodeURIComponent(cursor)}`
}

export class ApiClient implements AppApi {
  async request<T>(path: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
    const response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...init.headers },
    })
    if (!response.ok) throw await ApiHttpError.from(response)
    return responseSchema(schema).parse(await response.json()).data
  }

  async requestPage<T>(path: string, schema: z.ZodType<T[]>): Promise<Page<T>> {
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw await ApiHttpError.from(response)
    const parsed = responseSchema(schema).parse(await response.json())
    return { data: parsed.data, nextCursor: parsed.meta.nextCursor }
  }

  bootstrap(token: string): Promise<{ authenticated: true }> {
    return this.request(
      '/api/v1/auth/bootstrap',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      },
      bootstrapResponseSchema,
    )
  }

  createSession(mode?: string): Promise<CreateSessionResponse> {
    return this.request(
      '/api/v1/sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === undefined ? {} : { mode }),
      },
      createSessionResponseSchema,
    )
  }

  setSessionMode(sessionId: string, mode: string): Promise<{ mode: string }> {
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/mode`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      },
      z.strictObject({ mode: z.string() }),
    )
  }

  listSessions(cursor?: string): Promise<Page<Session>> {
    return this.requestPage(withCursor('/api/v1/sessions', cursor), z.array(sessionSchema))
  }

  listDocuments(cursor?: string): Promise<Page<DocumentRow>> {
    return this.requestPage(withCursor('/api/v1/documents', cursor), z.array(documentRowSchema))
  }

  getDocument(docId: string): Promise<Document> {
    return this.request(`/api/v1/documents/${encodeURIComponent(docId)}`, {}, documentSchema)
  }

  listProposals(cursor?: string): Promise<Page<Proposal>> {
    return this.requestPage(withCursor('/api/v1/proposals', cursor), z.array(proposalSchema))
  }

  resolveProposal(
    proposalId: string,
    resolution: 'accepted' | 'rejected',
  ): Promise<{ proposalId: string; resolution: 'accepted' | 'rejected' }> {
    return this.request(
      `/api/v1/proposals/${encodeURIComponent(proposalId)}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution }),
      },
      proposalResolutionResponseSchema,
    )
  }

  message(
    sessionId: string,
    turnId: string,
    message: string,
    after?: number,
  ): Promise<AsyncIterable<StreamEvent>> {
    return this.ndjson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Reverie-Turn-Id': turnId,
        ...(after === undefined ? {} : { 'X-Reverie-Last-Sequence': String(after) }),
      },
      body: JSON.stringify({ message }),
    })
  }

  events(sessionId: string, after?: number): Promise<AsyncIterable<StreamEvent>> {
    return this.ndjson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'GET',
      ...(after === undefined ? {} : { headers: { 'X-Reverie-Last-Sequence': String(after) } }),
    })
  }

  transcript(sessionId: string, cursor?: string): Promise<Page<TranscriptLine>> {
    return this.requestPage(
      withCursor(`/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript`, cursor),
      z.array(transcriptLineSchema),
    )
  }

  end(sessionId: string): Promise<Session> {
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/end`,
      { method: 'POST' },
      sessionSchema,
    )
  }

  getGraphSnapshot(): Promise<GraphSnapshot> {
    return this.request('/api/v1/graph/snapshot', {}, graphSnapshotSchema)
  }

  private async ndjson(path: string, init: RequestInit): Promise<AsyncIterable<StreamEvent>> {
    const response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: { Accept: 'application/x-ndjson; charset=utf-8', ...init.headers },
    })
    if (!response.ok) throw await ApiHttpError.from(response)
    if (!response.body) {
      throw new ApiHttpError(500, 'internal_error', 'The server returned an empty stream.')
    }
    return requireTerminal(decodeNdjson(response.body))
  }
}
