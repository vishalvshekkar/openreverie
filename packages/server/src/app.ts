import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import type {
  Proposal,
  PublicDocument,
  PublicDocumentRow,
  PublicSession,
  PublicTranscriptLine,
} from '@openreverie/memory'
import { z } from 'zod'
import {
  ApiError,
  type Cursor,
  type CursorResource,
  decodeCursor,
  encodeCursor,
  envelope,
  LIMITS,
  parsePageLimit,
} from './api.js'
import type { BootstrapAuth } from './auth.js'

export interface RecordEngine {
  listPublicDocuments(): Promise<PublicDocumentRow[]>
  getPublicDocument(docId: string): Promise<PublicDocument | null>
  listStoredSessions(): Promise<PublicSession[]>
  readTranscriptPage(sessionId: string): Promise<PublicTranscriptLine[]>
  listPendingProposals(): Promise<Proposal[]>
  resolveProposal(id: string, resolution: 'accepted' | 'rejected'): Promise<void>
}

export interface CreateAppDeps {
  engine: RecordEngine
  auth: BootstrapAuth
  canonicalOrigin: string
}

interface CanonicalOrigin {
  origin: string
  host: string
}

interface PublicProposal {
  proposalId: string
  createdAt: string
  kind: Proposal['kind']
  summary: string
  sourceSessionId: string
}

export function createApp(deps: CreateAppDeps): RequestListener {
  const canonical = parseCanonicalOrigin(deps.canonicalOrigin)
  const proposalResolutionLocks = new Map<string, Promise<void>>()
  return (req, res) => {
    void handle(req, res, deps.engine, deps.auth, canonical, proposalResolutionLocks).catch(
      (error: unknown) => {
        writeError(res, toApiError(error))
      },
    )
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  engine: RecordEngine,
  auth: BootstrapAuth,
  canonical: CanonicalOrigin,
  proposalResolutionLocks: Map<string, Promise<void>>,
): Promise<void> {
  const parsed = parseRequestUrl(req)
  const path = decodePath(parsed.pathname)
  const method = req.method ?? 'GET'

  if (path.length === 4 && path.join('/') === 'api/v1/auth/bootstrap' && method === 'POST') {
    requireHost(req, canonical.host)
    const body = bootstrapSchema.safeParse(await readJson(req))
    if (!body.success) throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    const session = auth.exchange(body.data.token)
    res.setHeader('set-cookie', `reverie_session=${session}; HttpOnly; SameSite=Strict; Path=/`)
    writePublicJson(res, 200, bootstrapResponseSchema, { authenticated: true }, null)
    return
  }

  if (path[0] !== 'api' || path[1] !== 'v1') {
    throw new ApiError(404, 'not_found', 'The requested resource was not found.')
  }

  if (method === 'GET' || method === 'HEAD') {
    requireAuthenticatedRead(req, auth, canonical)
  } else {
    requireAuthenticatedWrite(req, auth, canonical)
  }

  if (method === 'GET' && path.length === 3 && path[2] === 'documents') {
    const documents = (await engine.listPublicDocuments()).sort(compareDocuments)
    const page = pageResource(documents, {
      resource: 'documents',
      query: parsed.searchParams,
      revisionValue: documents.map((document) => [document.kind, document.title, document.docId]),
      tuple: (document) => [document.kind, document.title, document.docId],
      byteLimit: undefined,
    })
    writePublicJson(res, 200, publicDocumentRowsSchema, page.data, page.nextCursor)
    return
  }

  if (method === 'GET' && path.length === 4 && path[2] === 'documents') {
    const docId = requiredId(path[3])
    const storedDocument = await engine.getPublicDocument(docId)
    if (!storedDocument)
      throw new ApiError(404, 'not_found', 'The requested resource was not found.')
    const document = storedDocument
    if (Buffer.byteLength(document.body, 'utf8') > LIMITS.documentBytes) {
      throw new ApiError(413, 'resource_too_large', 'The requested resource is too large.')
    }
    writePublicJson(res, 200, publicDocumentSchema, document, null)
    return
  }

  if (method === 'GET' && path.length === 3 && path[2] === 'sessions') {
    const sessions = (await engine.listStoredSessions()).sort(compareSessions)
    const page = pageResource(sessions, {
      resource: 'sessions',
      query: parsed.searchParams,
      revisionValue: sessions.map((session) => [session.createdAt, session.sessionId]),
      tuple: (session) => [session.createdAt, session.sessionId],
      byteLimit: undefined,
    })
    writePublicJson(res, 200, publicSessionsSchema, page.data, page.nextCursor)
    return
  }

  if (method === 'GET' && path.length === 4 && path[2] === 'sessions') {
    const sessionId = requiredId(path[3])
    const session = (await engine.listStoredSessions()).find((item) => item.sessionId === sessionId)
    if (!session) throw new ApiError(404, 'not_found', 'The requested resource was not found.')
    writePublicJson(res, 200, publicSessionSchema, session, null)
    return
  }

  if (method === 'GET' && path.length === 5 && path[2] === 'sessions' && path[4] === 'transcript') {
    const sessionId = requiredId(path[3])
    const session = (await engine.listStoredSessions()).find((item) => item.sessionId === sessionId)
    if (!session) throw new ApiError(404, 'not_found', 'The requested resource was not found.')
    const transcript = await engine.readTranscriptPage(sessionId)
    const page = pageResource(transcript, {
      resource: 'transcript',
      query: parsed.searchParams,
      revisionValue: transcript.map((line) => [
        line.lineSequence,
        line.ts,
        line.role,
        line.content,
      ]),
      tuple: (line) => [line.lineSequence],
      byteLimit: LIMITS.transcriptPageBytes,
      fallback: 200,
      maximum: 1000,
      recordTooLargeCode: 'record_too_large',
    })
    writePublicJson(
      res,
      200,
      publicTranscriptLinesSchema,
      page.data,
      page.nextCursor,
      LIMITS.transcriptPageBytes,
    )
    return
  }

  if (method === 'GET' && path.length === 3 && path[2] === 'proposals') {
    const proposals = (await engine.listPendingProposals())
      .map(publicProposal)
      .sort(compareProposals)
    const page = pageResource(proposals, {
      resource: 'proposals',
      query: parsed.searchParams,
      revisionValue: proposals.map((proposal) => [proposal.createdAt, proposal.proposalId]),
      tuple: (proposal) => [proposal.createdAt, proposal.proposalId],
      byteLimit: LIMITS.proposalPageBytes,
      recordTooLargeCode: 'record_too_large',
    })
    writePublicJson(
      res,
      200,
      publicProposalsSchema,
      page.data,
      page.nextCursor,
      LIMITS.proposalPageBytes,
    )
    return
  }

  if (method === 'POST' && path.length === 5 && path[2] === 'proposals' && path[4] === 'resolve') {
    const proposalId = requiredId(path[3])
    const body = proposalResolutionSchema.safeParse(await readJson(req))
    if (!body.success) throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    await serializeProposalResolution(proposalResolutionLocks, proposalId, async () => {
      const pending = await engine.listPendingProposals()
      if (!pending.some((proposal) => proposal.id === proposalId)) {
        throw new ApiError(404, 'not_found', 'The requested resource was not found.')
      }
      await engine.resolveProposal(proposalId, body.data.resolution)
    })
    writePublicJson(
      res,
      200,
      proposalResolutionResponseSchema,
      { proposalId, resolution: body.data.resolution },
      null,
    )
    return
  }

  throw new ApiError(404, 'not_found', 'The requested resource was not found.')
}

const bootstrapSchema = z.strictObject({ token: z.string() })
const proposalResolutionSchema = z.strictObject({ resolution: z.enum(['accepted', 'rejected']) })
const documentKindSchema = z.enum([
  'constitution',
  'realm',
  'arc',
  'summary',
  'rollup_daily',
  'rollup_weekly',
  'person',
])
const publicDocumentRowSchema = z.strictObject({
  docId: z.string(),
  kind: documentKindSchema,
  title: z.string(),
  updatedAt: z.string(),
  readOnly: z.literal(true),
})
const publicDocumentRowsSchema = z.array(publicDocumentRowSchema)
const publicDocumentSchema = publicDocumentRowSchema.extend({ body: z.string() })
const publicSessionSchema = z.strictObject({
  sessionId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(['live', 'ended', 'expired']),
  readOnly: z.boolean(),
  transcript: z.strictObject({
    lineCount: z.number().int().nonnegative(),
    userCount: z.number().int().nonnegative(),
    assistantCount: z.number().int().nonnegative(),
    toolCount: z.number().int().nonnegative(),
  }),
})
const publicSessionsSchema = z.array(publicSessionSchema)
const toolCallSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
})
const publicTranscriptLineSchema = z.strictObject({
  lineSequence: z.number().int().positive(),
  ts: z.string(),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z.array(toolCallSchema).optional(),
  toolCallId: z.string().optional(),
})
const publicTranscriptLinesSchema = z.array(publicTranscriptLineSchema)
const publicProposalSchema = z.strictObject({
  proposalId: z.string(),
  createdAt: z.string(),
  kind: z.enum(['new_arc', 'new_person', 'link']),
  summary: z.string(),
  sourceSessionId: z.string(),
})
const publicProposalsSchema = z.array(publicProposalSchema)
const bootstrapResponseSchema = z.strictObject({ authenticated: z.literal(true) })
const proposalResolutionResponseSchema = z.strictObject({
  proposalId: z.string(),
  resolution: z.enum(['accepted', 'rejected']),
})
const responseMetaSchema = z.strictObject({ nextCursor: z.string().nullable() })

function responseSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({ data, meta: responseMetaSchema })
}

async function serializeProposalResolution<T>(
  locks: Map<string, Promise<void>>,
  proposalId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(proposalId) ?? Promise.resolve()
  let release = (): void => undefined
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  locks.set(proposalId, current)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (locks.get(proposalId) === current) locks.delete(proposalId)
  }
}

function parseCanonicalOrigin(origin: string): CanonicalOrigin {
  const url = new URL(origin)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/'
  ) {
    throw new Error('canonicalOrigin must be an http origin with an explicit port')
  }
  return { origin: url.origin, host: url.host }
}

function parseRequestUrl(req: IncomingMessage): URL {
  const value = req.url ?? '/'
  const queryStart = value.indexOf('?')
  const query = queryStart < 0 ? '' : value.slice(queryStart + 1)
  if (Buffer.byteLength(query, 'utf8') > LIMITS.queryBytes) {
    throw new ApiError(414, 'request_uri_too_large', 'The request URL is too large.')
  }
  try {
    return new URL(value, 'http://request.invalid')
  } catch {
    throw new ApiError(400, 'invalid_request', 'The request is invalid.')
  }
}

function decodePath(pathname: string): string[] {
  try {
    return pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    throw new ApiError(400, 'invalid_request', 'The request is invalid.')
  }
}

function requiredId(value: string | undefined): string {
  if (!value || value.length > LIMITS.idChars) {
    throw new ApiError(400, 'invalid_request', 'The identifier is invalid.')
  }
  return value
}

function requireHost(req: IncomingMessage, host: string): void {
  if (req.headers.host !== host) {
    throw new ApiError(400, 'host_forbidden', 'The request host is not allowed.')
  }
}

function requireAuthenticatedRead(
  req: IncomingMessage,
  auth: BootstrapAuth,
  canonical: CanonicalOrigin,
): void {
  requireHost(req, canonical.host)
  if (!auth.authenticate(req.headers.cookie)) {
    throw new ApiError(401, 'unauthorized', 'Unauthorized.')
  }
}

function requireAuthenticatedWrite(
  req: IncomingMessage,
  auth: BootstrapAuth,
  canonical: CanonicalOrigin,
): void {
  requireAuthenticatedRead(req, auth, canonical)
  if (req.headers.origin !== canonical.origin) {
    throw new ApiError(403, 'origin_forbidden', 'Request origin is not allowed.')
  }
}

async function readJson(req: IncomingMessage, maxBytes = LIMITS.requestBytes): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > maxBytes) {
      throw new ApiError(413, 'request_too_large', 'The request is too large.')
    }
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ApiError(400, 'invalid_json', 'The request body must be JSON.')
  }
}

interface PageOptions<T, R extends CursorResource> {
  resource: R
  query: URLSearchParams
  revisionValue: unknown
  tuple: (record: T) => readonly unknown[]
  byteLimit: number | undefined
  fallback?: number
  maximum?: number
  recordTooLargeCode?: string
}

function pageResource<T, R extends CursorResource>(
  records: T[],
  options: PageOptions<T, R>,
): { data: T[]; nextCursor: string | null } {
  const fallback = options.fallback ?? 50
  const maximum = options.maximum ?? 200
  const limit = parsePageLimit(options.query.get('limit'), fallback, maximum)
  const revision = revisionFor(options.revisionValue)
  let start = 0
  const cursor = options.query.get('cursor')
  if (cursor !== null) {
    const decoded = decodeCursor(cursor, options.resource, revision)
    const found = records.findIndex((record) => tuplesEqual(options.tuple(record), decoded.tuple))
    if (found < 0) throw new ApiError(400, 'cursor_invalid', 'The cursor is invalid.')
    start = found + 1
  }

  const data: T[] = []
  let end = start
  while (end < records.length && data.length < limit) {
    const record = records[end]
    if (record === undefined) break
    const next = [...data, record]
    const nextEnd = end + 1
    const nextCursor =
      nextEnd < records.length ? cursorFor(options.resource, options.tuple(record), revision) : null
    if (
      options.byteLimit !== undefined &&
      Buffer.byteLength(JSON.stringify(envelope(next, nextCursor)), 'utf8') > options.byteLimit
    ) {
      if (data.length === 0) {
        throw new ApiError(
          413,
          options.recordTooLargeCode ?? 'resource_too_large',
          'A record is too large.',
        )
      }
      break
    }
    data.push(record)
    end = nextEnd
  }
  const nextCursor =
    end < records.length && data.length > 0
      ? cursorFor(options.resource, options.tuple(data.at(-1) as T), revision)
      : null
  return { data, nextCursor }
}

function cursorFor<R extends CursorResource>(
  resource: R,
  tuple: readonly unknown[],
  revision: string,
): string {
  return encodeCursor({ v: 1, resource, tuple, revision } as Cursor)
}

function tuplesEqual(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function revisionFor(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('base64url')
}

function compareDocuments(left: PublicDocumentRow, right: PublicDocumentRow): number {
  return compareTuple([left.kind, left.title, left.docId], [right.kind, right.title, right.docId])
}

function compareSessions(left: PublicSession, right: PublicSession): number {
  return compareTuple([right.createdAt, right.sessionId], [left.createdAt, left.sessionId])
}

function publicProposal(proposal: Proposal): PublicProposal {
  return {
    proposalId: proposal.id,
    createdAt: proposal.ts,
    kind: proposal.kind,
    summary: proposal.summary,
    sourceSessionId: proposal.source,
  }
}

function compareProposals(left: PublicProposal, right: PublicProposal): number {
  return compareTuple([left.createdAt, left.proposalId], [right.createdAt, right.proposalId])
}

function compareTuple(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? ''
    const b = right[index] ?? ''
    if (a < b) return -1
    if (a > b) return 1
  }
  return 0
}

function writePublicJson(
  res: ServerResponse,
  status: number,
  dataSchema: z.ZodType,
  data: unknown,
  nextCursor: string | null,
  maxBytes?: number,
): void {
  const payload = responseSchema(dataSchema).safeParse(envelope(data, nextCursor))
  if (!payload.success) {
    throw new ApiError(500, 'internal_error', 'The server could not process the request.')
  }
  writeJson(res, status, payload.data, maxBytes)
}

function writeJson(res: ServerResponse, status: number, payload: unknown, maxBytes?: number): void {
  const serialized = JSON.stringify(payload)
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (maxBytes !== undefined && bytes > maxBytes) {
    throw new ApiError(413, 'resource_too_large', 'The requested resource is too large.')
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes,
  })
  res.end(serialized)
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  return new ApiError(500, 'internal_error', 'The server could not process the request.')
}

function writeError(res: ServerResponse, error: ApiError): void {
  if (res.headersSent) return
  writeJson(res, error.status, { schemaVersion: '1', code: error.code, message: error.message })
}
