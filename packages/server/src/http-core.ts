// The transport-agnostic HTTP core for the /api/v1 contract.
//
// This module imports no node builtins. It is the shared logic behind both
// entry points: createApp's node:http RequestListener (app.ts) and
// createFetchApp's Web-standard (Request) => Promise<Response> (below). A
// hosted version of this product (Reverie Cloud) runs on Cloudflare
// Workers, which have no node:http, so the request/response plumbing here
// is built entirely on Request, Response, Headers, and ReadableStream: all
// globals in the Node version this repo targets, and the same globals
// Workers, Bun, and Deno provide natively.
//
// Two things that would otherwise pull in a node builtin are injected
// instead: sha256 (via HashProvider, since this file needs a synchronous
// digest and the only synchronous digest available without node:crypto
// would mean hand rolling SHA-256) and static asset serving (via an
// optional serveStatic hook, since that needs node:fs). Everything else,
// including reading a request body with an incremental byte cap and
// streaming NDJSON events, is done with Web-standard APIs only.
//
// Route bodies are unchanged from the node:http version: they still call
// res.setHeader / res.writeHead / res.write / res.end / res.once('close', ...)
// / res.off('close', ...) / res.headersSent, just against a ResponseSink
// instead of a node:http ServerResponse. node:http's ServerResponse already
// implements every member of ResponseSink, so the node adapter in app.ts
// passes it straight through with no wrapper.
import type { ReverieConfig } from '@openreverie/core'
import {
  type Document,
  type DreamStatus,
  type DreamSummary,
  type DreamVerdict,
  EDGE_TYPES,
  foldDreamLog,
  type MemoryPaths,
  NODE_TYPES,
  type Profile,
  type ProfileSettingsPatch,
  type Proposal,
  type PublicDocument,
  type PublicDocumentRow,
  type PublicGraphEdge,
  type PublicGraphNode,
  type PublicSession,
  type PublicTranscriptLine,
  profileSettingsPatchSchema,
  readDreamLog,
  type SequencedGraphRecord,
  type StyleConfig,
} from '@openreverie/memory'
import { z } from 'zod'
import {
  ApiError,
  type Cursor,
  type CursorResource,
  canonicalJson,
  decodeCursor,
  encodeCursor,
  envelope,
  LIMITS,
  makeGraphSnapshot,
  parsePageLimit,
} from './api.js'
import type { BootstrapAuth } from './auth.js'
import type { LiveSessionRegistry, StreamEvent } from './registry.js'

const utf8 = new TextEncoder()

function byteLength(text: string): number {
  return utf8.encode(text).byteLength
}

export interface RecordEngine {
  // The MemoryPaths this engine was built over. Required, not optional:
  // the dream detail route reads feedback verdicts through this, and an
  // optional member would let a fake or a host omit it and silently
  // reproduce the bug this replaced (a route that returns 200 with every
  // verdict dropped). Reading through the engine's own paths, rather than
  // a separately constructed MemoryPaths, is what guarantees the verdicts
  // come from the same stores as the rest of the record.
  readonly memoryPaths: MemoryPaths
  listPublicDocuments(): Promise<PublicDocumentRow[]>
  getPublicDocument(docId: string): Promise<PublicDocument | null>
  listStoredSessions(): Promise<PublicSession[]>
  readTranscriptPage(sessionId: string): Promise<PublicTranscriptLine[]>
  graphSnapshot(): { nodes: PublicGraphNode[]; edges: PublicGraphEdge[] }
  readGraphHistory(): Promise<SequencedGraphRecord[]>
  docIdForPath(path: string): string | undefined
  listPendingProposals(): Promise<Proposal[]>
  resolveProposal(id: string, resolution: 'accepted' | 'rejected'): Promise<void>
  profile(): Profile
  currentStyle(): StyleConfig
  updateProfileSettings(patch: ProfileSettingsPatch): Promise<Profile>
  listDreams(): Promise<DreamSummary[]>
  readDream(dreamId: string): Promise<{
    summary: DreamSummary
    narrative?: Document
    insights: Document
    processLog: string
  } | null>
  recordDreamFeedback(args: {
    insightId: string
    verdict: DreamVerdict
    note?: string
    source: 'ui' | 'tool'
  }): Promise<boolean>
  dreamStatus(): Promise<DreamStatus>
}

// A synchronous SHA-256, injected rather than imported. Web Crypto's
// crypto.subtle.digest is the portable option but it is async only, and
// making revisionFor/graphEventRevision async would ripple into
// pageResource and every route that calls it. node:crypto's createHash is
// synchronous but is a node builtin, so it is supplied by the adapter
// instead: app.ts wires this to node:crypto for the node:http adapter, and
// a Workers or Bun or Deno host supplies its own (Workers' nodejs_compat
// ships createHash too, so this costs Reverie Cloud nothing).
export interface HashProvider {
  sha256(data: Uint8Array): Uint8Array
}

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

// Matches Buffer's 'base64url' encoding: standard base64 with the URL-safe
// alphabet substitutions and padding stripped. Built on btoa, a Web
// standard global present in Node, Workers, Bun, and Deno alike, so this
// needs no node:buffer import.
function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// The minimal node:http ResponseSink surface route bodies rely on: six
// members from the task's own audit (setHeader, writeHead, write, end,
// once('close'), headersSent) plus a seventh, off('close'), that
// writeNdjson also needs to remove its own listener once the stream ends
// normally. node:http's ServerResponse already implements every one of
// these, so the node adapter needs no wrapper class at all: a
// ServerResponse is a ResponseSink.
export interface ResponseSink {
  readonly headersSent: boolean
  setHeader(name: string, value: string): void
  writeHead(status: number, headers?: Record<string, string | number>): void
  // string covers every route body (JSON, NDJSON); Uint8Array exists only
  // for the node adapter's static file serving, which reads binary
  // content (images, fonts) off disk and must not round-trip it through a
  // string, since re-encoding arbitrary bytes as UTF-8 corrupts anything
  // outside the ASCII range.
  write(chunk: string | Uint8Array): void
  end(chunk?: string | Uint8Array): void
  once(event: 'close', listener: () => void): void
  off(event: 'close', listener: () => void): void
}

// Statuses the Fetch API requires a null body for. The graph snapshot
// route's 304 branch (writeHead(304, { etag }); end()) is the only one hit
// today; 204 and 205 are included because the Response constructor throws
// building a Response for any of the three with a non-null body, and this
// sink has no other way to know a route intends an empty body until it
// sees the status.
const NULL_BODY_STATUSES = new Set([204, 205, 304])

// The Web-standard ResponseSink. The property that makes token-by-token
// streaming survive this refactor lives here: writeHead resolves
// responseReady immediately, with the ReadableStream's controller already
// captured, so a consumer already reading the Response body sees each
// later write() as soon as it happens. An implementation that instead
// buffered every write() and only constructed the Response at end() would
// pass any test that just checks the final body, and would silently turn
// streaming into batch delivery, which is the one thing P1-1 exists to
// prevent.
export class WebResponseSink implements ResponseSink {
  readonly responseReady: Promise<Response>
  private resolveResponse!: (response: Response) => void
  private readonly headers = new Headers()
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined
  private readonly closeListeners = new Set<() => void>()
  private cancelled = false
  private ended = false
  private sent = false

  constructor() {
    this.responseReady = new Promise<Response>((resolve) => {
      this.resolveResponse = resolve
    })
  }

  get headersSent(): boolean {
    return this.sent
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name, value)
  }

  writeHead(status: number, headers?: Record<string, string | number>): void {
    if (this.sent) return
    this.sent = true
    if (headers) {
      for (const [key, value] of Object.entries(headers)) this.headers.set(key, String(value))
    }
    if (NULL_BODY_STATUSES.has(status)) {
      this.resolveResponse(new Response(null, { status, headers: this.headers }))
      return
    }
    const sink = this
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        sink.controller = controller
      },
      // Fires when the consumer stops reading: response.body.cancel(), a
      // reader's own .cancel(), or (on a real host) the client
      // disconnecting. This is the Web-standard equivalent of node:http's
      // 'close' event, and is how writeNdjson's existing
      // res.once('close', ...) wiring keeps working unmodified: it is
      // registered against this sink's own once()/off(), and this cancel
      // callback is what drives it.
      cancel() {
        sink.cancelled = true
        for (const listener of [...sink.closeListeners]) listener()
      },
    })
    this.resolveResponse(new Response(stream, { status, headers: this.headers }))
  }

  write(chunk: string | Uint8Array): void {
    if (!this.controller || this.cancelled || this.ended) return
    this.controller.enqueue(typeof chunk === 'string' ? utf8.encode(chunk) : chunk)
  }

  end(chunk?: string | Uint8Array): void {
    if (this.ended) return
    if (chunk !== undefined) this.write(chunk)
    this.ended = true
    if (this.controller && !this.cancelled) {
      try {
        this.controller.close()
      } catch {
        // Already closed or errored by the consumer cancelling between the
        // write above and this call; nothing further to do.
      }
    }
  }

  once(event: 'close', listener: () => void): void {
    if (event === 'close') this.closeListeners.add(listener)
  }

  off(event: 'close', listener: () => void): void {
    if (event === 'close') this.closeListeners.delete(listener)
  }
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

// Deps handle() needs, bundled into one object rather than kept as a long
// positional parameter list now that there are two callers (the node:http
// adapter and createFetchApp below) building it from two different shaped
// public deps types.
interface HandleDeps {
  engine: RecordEngine
  auth: BootstrapAuth
  canonical: CanonicalOrigin
  writeOriginPolicy: 'required' | 'allow-missing'
  proposalResolutionLocks: Map<string, Promise<void>>
  registry: LiveSessionRegistry | undefined
  config: ReverieConfig | undefined
  hash: HashProvider
  // Static asset serving needs node:fs, so it is never implemented here.
  // Both entry points pass it through untouched: undefined when there is
  // nothing to serve (the common case for a Workers deployment), or a
  // node:fs backed implementation from the node adapter.
  serveStatic: ((sink: ResponseSink, pathname: string) => Promise<void>) | undefined
  // Gates POST /api/v1/auth/bootstrap. Undefined means the route is not
  // mounted at all: no match, no cookie, a plain 404 (or 401 first, if the
  // caller is unauthenticated, since the route sits before the auth check
  // only when it exists). This follows serveStatic's own shape: presence
  // decides whether the feature exists, not a flag next to an
  // always-mounted route. The node adapter always supplies this (built
  // from its own deps.auth), so self-hosted behavior is unchanged; a
  // Workers-style host that authenticates its own way simply never passes
  // it, and never exposes an unauthenticated cookie-issuing endpoint by
  // default. Only 'exchange' is needed here, not the full BootstrapAuth,
  // since this route never calls authenticate().
  bootstrap: Pick<BootstrapAuth, 'exchange'> | undefined
}

export async function handle(
  request: Request,
  sink: ResponseSink,
  deps: HandleDeps,
): Promise<void> {
  const {
    engine,
    auth,
    canonical,
    writeOriginPolicy,
    proposalResolutionLocks,
    registry,
    config,
    hash,
    serveStatic,
    bootstrap,
  } = deps
  const parsed = parseRequestUrl(request)
  const path = decodePath(parsed.pathname)
  const method = request.method

  if (
    bootstrap &&
    path.length === 4 &&
    path.join('/') === 'api/v1/auth/bootstrap' &&
    method === 'POST'
  ) {
    requireHost(request, canonical.host)
    const body = bootstrapSchema.safeParse(await readJson(request))
    if (!body.success) throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    const session = bootstrap.exchange(body.data.token)
    sink.setHeader('set-cookie', `reverie_session=${session}; HttpOnly; SameSite=Strict; Path=/`)
    writePublicJson(sink, 200, bootstrapResponseSchema, { authenticated: true }, null)
    return
  }

  if (path[0] !== 'api') {
    if (serveStatic) {
      await serveStatic(sink, parsed.pathname)
      return
    }
    throw new ApiError(404, 'not_found', 'The requested resource was not found.')
  }

  if (path[1] !== 'v1') {
    throw new ApiError(404, 'not_found', 'The requested resource was not found.')
  }

  if (method === 'GET' || method === 'HEAD') {
    requireAuthenticatedRead(request, auth, canonical)
  } else {
    requireAuthenticatedWrite(request, auth, canonical, writeOriginPolicy)
  }

  if (method === 'GET' && path.length === 4 && path[2] === 'graph' && path[3] === 'snapshot') {
    const snapshot = makeGraphSnapshot(engine.graphSnapshot())
    ensureGraphSnapshotResponseSize(snapshot)
    const etag = `"${snapshot.revision}"`
    if (request.headers.get('if-none-match') === etag) {
      sink.writeHead(304, { etag })
      sink.end()
      return
    }
    sink.setHeader('etag', etag)
    writePublicJson(sink, 200, publicGraphSnapshotSchema, snapshot, null, LIMITS.graphPageBytes)
    return
  }

  if (method === 'GET' && path.length === 4 && path[2] === 'graph' && path[3] === 'events') {
    const events = (await engine.readGraphHistory()).map((event) => publicGraphEvent(event, engine))
    const page = pageResource(events, {
      resource: 'graph_events',
      query: parsed.searchParams,
      revisionValue: events,
      revision: graphEventRevision(events, hash),
      tuple: (event) => [event.sequence],
      byteLimit: LIMITS.graphPageBytes,
      recordByteLimit: LIMITS.graphEventBytes,
      recordTooLargeCode: 'record_too_large',
      cursorParam: 'after',
      fallback: 500,
      maximum: 2000,
      hash,
    })
    writePublicJson(
      sink,
      200,
      publicGraphEventsSchema,
      page.data,
      page.nextCursor,
      LIMITS.graphPageBytes,
    )
    return
  }

  if (method === 'GET' && path.length === 3 && path[2] === 'documents') {
    const documents = (await engine.listPublicDocuments()).sort(compareDocuments)
    const page = pageResource(documents, {
      resource: 'documents',
      query: parsed.searchParams,
      revisionValue: documents.map((document) => [document.kind, document.title, document.docId]),
      tuple: (document) => [document.kind, document.title, document.docId],
      byteLimit: undefined,
      hash,
    })
    writePublicJson(sink, 200, publicDocumentRowsSchema, page.data, page.nextCursor)
    return
  }

  if (method === 'GET' && path.length === 4 && path[2] === 'documents') {
    const docId = requiredId(path[3])
    const storedDocument = await engine.getPublicDocument(docId)
    if (!storedDocument)
      throw new ApiError(404, 'not_found', 'The requested resource was not found.')
    const document = storedDocument
    if (byteLength(document.body) > LIMITS.documentBytes) {
      throw new ApiError(413, 'resource_too_large', 'The requested resource is too large.')
    }
    writePublicJson(sink, 200, publicDocumentSchema, document, null)
    return
  }

  if (method === 'GET' && path.length === 3 && path[2] === 'sessions') {
    const byId = new Map(
      (await engine.listStoredSessions()).map((session) => [session.sessionId, session]),
    )
    for (const session of registry?.liveSessions() ?? []) byId.set(session.sessionId, session)
    const sessions = [...byId.values()].sort(compareSessions)
    const page = pageResource(sessions, {
      resource: 'sessions',
      query: parsed.searchParams,
      revisionValue: sessions.map((session) => [session.createdAt, session.sessionId]),
      tuple: (session) => [session.createdAt, session.sessionId],
      byteLimit: undefined,
      hash,
    })
    writePublicJson(sink, 200, publicSessionsSchema, page.data, page.nextCursor)
    return
  }

  if (method === 'GET' && path.length === 4 && path[2] === 'sessions') {
    const sessionId = requiredId(path[3])
    const session =
      registry?.getLiveSession(sessionId) ??
      (await engine.listStoredSessions()).find((item) => item.sessionId === sessionId)
    if (!session) throw new ApiError(404, 'not_found', 'The requested resource was not found.')
    writePublicJson(sink, 200, publicSessionSchema, session, null)
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
      hash,
    })
    writePublicJson(
      sink,
      200,
      publicTranscriptLinesSchema,
      page.data,
      page.nextCursor,
      LIMITS.transcriptPageBytes,
    )
    return
  }

  if (registry && method === 'POST' && path.length === 3 && path[2] === 'sessions') {
    const raw = await readJsonOrEmpty(request)
    const body = createSessionSchema.safeParse(raw)
    if (!body.success) throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    const session = await registry.create(
      body.data.mode === undefined ? {} : { mode: body.data.mode },
    )
    writePublicJson(sink, 201, createSessionResponseSchema, session, null)
    return
  }

  if (
    registry &&
    method === 'POST' &&
    path.length === 5 &&
    path[2] === 'sessions' &&
    path[4] === 'message'
  ) {
    const sessionId = requiredId(path[3])
    const turnId = requiredTurnId(request.headers.get('x-reverie-turn-id'))
    const after = parseLastSequence(request.headers.get('x-reverie-last-sequence'))
    const body = messageSchema.safeParse(await readJson(request))
    if (!body.success) throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    if (byteLength(body.data.message) > LIMITS.messageBytes) {
      throw new ApiError(413, 'message_too_large', 'The message is too large.')
    }
    await writeNdjson(sink, registry.message(sessionId, turnId, body.data, after))
    return
  }

  if (
    registry &&
    method === 'GET' &&
    path.length === 5 &&
    path[2] === 'sessions' &&
    path[4] === 'events'
  ) {
    const sessionId = requiredId(path[3])
    const after = parseLastSequence(request.headers.get('x-reverie-last-sequence'))
    await writeNdjson(sink, registry.events(sessionId, after))
    return
  }

  if (
    registry &&
    method === 'POST' &&
    path.length === 5 &&
    path[2] === 'sessions' &&
    path[4] === 'end'
  ) {
    const sessionId = requiredId(path[3])
    const session = await registry.end(sessionId)
    writePublicJson(sink, 200, publicSessionSchema, session, null)
    return
  }

  if (
    registry &&
    method === 'POST' &&
    path.length === 5 &&
    path[2] === 'sessions' &&
    path[4] === 'mode'
  ) {
    const sessionId = requiredId(path[3])
    const body = sessionModeSchema.safeParse(await readJson(request))
    if (!body.success) throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    const result = await registry.setMode(sessionId, body.data.mode)
    writePublicJson(sink, 200, sessionModeResponseSchema, result, null)
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
      hash,
    })
    writePublicJson(
      sink,
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
    const body = proposalResolutionSchema.safeParse(await readJson(request))
    if (!body.success) throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    await serializeProposalResolution(proposalResolutionLocks, proposalId, async () => {
      const pending = await engine.listPendingProposals()
      if (!pending.some((proposal) => proposal.id === proposalId)) {
        throw new ApiError(404, 'not_found', 'The requested resource was not found.')
      }
      await engine.resolveProposal(proposalId, body.data.resolution)
    })
    writePublicJson(
      sink,
      200,
      proposalResolutionResponseSchema,
      { proposalId, resolution: body.data.resolution },
      null,
    )
    return
  }

  if (method === 'GET' && path.length === 3 && path[2] === 'profile') {
    writePublicJson(
      sink,
      200,
      publicProfileSchema,
      publicProfile(engine.profile(), engine.currentStyle()),
      null,
    )
    return
  }

  if (method === 'PATCH' && path.length === 3 && path[2] === 'profile') {
    const body = profileSettingsPatchSchema.safeParse(await readJson(request))
    // An unrecognized key in a file the user may hand-edit is probably
    // intentional; an unrecognized key arriving over HTTP is probably a
    // mistake or an attempt. So the file schema passes them through and this
    // one rejects the whole body rather than applying it in part.
    if (!body.success) throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    const profile = await engine.updateProfileSettings(body.data)
    writePublicJson(
      sink,
      200,
      publicProfileSchema,
      publicProfile(profile, engine.currentStyle()),
      null,
    )
    return
  }

  if (method === 'GET' && path.length === 3 && path[2] === 'settings') {
    // Exactly one field. No memory folder path, no config file path, no
    // model names, and above all nothing from the provider block. There is
    // no PATCH: safety mode is not settable over HTTP, for the same reason
    // it stays in config.toml.
    const safetyMode = config?.safety.mode
    if (safetyMode === undefined) {
      throw new ApiError(404, 'not_found', 'The requested resource was not found.')
    }
    writePublicJson(sink, 200, publicSettingsSchema, { safetyMode }, null)
    return
  }

  if (method === 'GET' && path.length === 3 && path[2] === 'dreams') {
    const dreams = await engine.listDreams()
    const rows = dreams.map(publicDreamRow)
    writePublicJson(sink, 200, publicDreamRowsSchema, rows, null)
    return
  }

  // Ordered before the generic dream-detail route below: without the
  // path[3] === 'status' check, that route's own path.length === 4 match
  // would treat "status" as a dreamId and 404 it via requiredId/readDream.
  if (method === 'GET' && path.length === 4 && path[2] === 'dreams' && path[3] === 'status') {
    const status = await engine.dreamStatus()
    writePublicJson(sink, 200, dreamStatusSchema, publicDreamStatus(status), null)
    return
  }

  if (method === 'GET' && path.length === 4 && path[2] === 'dreams') {
    const dreamId = requiredId(path[3])
    const dream = await engine.readDream(dreamId)
    if (!dream) throw new ApiError(404, 'not_found', 'The requested resource was not found.')
    const verdicts = await dreamFeedbackVerdicts(engine)
    writePublicJson(sink, 200, publicDreamDetailSchema, publicDreamDetail(dream, verdicts), null)
    return
  }

  if (method === 'POST' && path.length === 5 && path[2] === 'dreams' && path[4] === 'feedback') {
    requiredId(path[3])
    const body = dreamFeedbackRequestSchema.safeParse(await readJson(request))
    if (!body.success) throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    const recorded = await engine.recordDreamFeedback({
      insightId: body.data.insightId,
      verdict: body.data.verdict,
      ...(body.data.note !== undefined ? { note: body.data.note } : {}),
      source: 'ui',
    })
    if (!recorded) throw new ApiError(404, 'not_found', 'The requested resource was not found.')
    writePublicJson(
      sink,
      200,
      dreamFeedbackResponseSchema,
      { insightId: body.data.insightId, verdict: body.data.verdict },
      null,
    )
    return
  }

  throw new ApiError(404, 'not_found', 'The requested resource was not found.')
}

const bootstrapSchema = z.strictObject({ token: z.string() })
const proposalResolutionSchema = z.strictObject({ resolution: z.enum(['accepted', 'rejected']) })
const messageSchema = z.strictObject({ message: z.string() })
const documentKindSchema = z.enum([
  'constitution',
  'realm',
  'arc',
  'summary',
  'rollup_daily',
  'rollup_weekly',
  'person',
  'journal',
  'journaling',
])
const publicDocumentRowSchema = z.strictObject({
  docId: z.string(),
  kind: documentKindSchema,
  title: z.string(),
  updatedAt: z.string(),
  readOnly: z.literal(true),
  method: z.string().optional(),
  entryDate: z.string().optional(),
  excerpt: z.string().optional(),
  recordedAt: z.string().optional(),
})
const publicDocumentRowsSchema = z.array(publicDocumentRowSchema)
const publicDocumentSchema = publicDocumentRowSchema.extend({ body: z.string() })
const publicSessionSchema = z.strictObject({
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
const createSessionResponseSchema = publicSessionSchema.extend({
  initialGreetingStreamUrl: z.string().optional(),
})
const publicSessionsSchema = z.array(publicSessionSchema)
const createSessionSchema = z.strictObject({ mode: z.string().optional() })
const sessionModeSchema = z.strictObject({ mode: z.string() })
const sessionModeResponseSchema = z.strictObject({ mode: z.string() })
const toolCallSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
})
const publicTranscriptLineSchema = z.strictObject({
  lineSequence: z.number().int().positive(),
  ts: z.string(),
  utcOffsetMinutes: z.number().optional(),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z.array(toolCallSchema).optional(),
  toolCallId: z.string().optional(),
  synthetic: z.literal(true).optional(),
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
// Derived from @openreverie/memory's NODE_TYPES/EDGE_TYPES rather than
// hand copied. server is allowed to depend on memory (server -> core ->
// memory is a permitted downward direction), so this schema cannot drift
// from the real graph vocabulary the way a second hand written literal
// list could. See graph-vocabulary-parity.test.ts for the guard that
// would catch it if a future edit undoes this derivation.
// Exported only so graph-vocabulary-parity.test.ts can assert this schema
// stays derived from @openreverie/memory's NODE_TYPES/EDGE_TYPES, not so
// any route handler needs it directly.
export const graphNodeTypeSchema = z.enum(NODE_TYPES)
export const graphEdgeTypeSchema = z.enum(EDGE_TYPES)
const publicGraphNodeSchema = z.strictObject({
  id: z.string(),
  type: graphNodeTypeSchema,
  label: z.string(),
  docId: z.string().optional(),
  assertedAt: z.string(),
})
const publicGraphEdgeSchema = z.strictObject({
  key: z.string(),
  type: graphEdgeTypeSchema,
  from: z.string(),
  to: z.string(),
  confidence: z.number().min(0).max(1),
  confirmed: z.boolean(),
  sourceSessionId: z.string().optional(),
  assertedAt: z.string(),
})
const publicGraphSnapshotSchema = z.strictObject({
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  nodes: z.array(publicGraphNodeSchema),
  edges: z.array(publicGraphEdgeSchema),
})
const publicGraphEventSchema = z.union([
  z.strictObject({
    sequence: z.number().int().positive(),
    op: z.literal('assert'),
    kind: z.literal('node'),
    assertedAt: z.string(),
    node: publicGraphNodeSchema,
  }),
  z.strictObject({
    sequence: z.number().int().positive(),
    op: z.literal('retract'),
    kind: z.literal('node'),
    assertedAt: z.string(),
    nodeId: z.string(),
  }),
  z.strictObject({
    sequence: z.number().int().positive(),
    op: z.literal('assert'),
    kind: z.literal('edge'),
    assertedAt: z.string(),
    edge: publicGraphEdgeSchema,
  }),
  z.strictObject({
    sequence: z.number().int().positive(),
    op: z.literal('retract'),
    kind: z.literal('edge'),
    assertedAt: z.string(),
    edgeKey: z.string(),
  }),
])
const publicGraphEventsSchema = z.array(publicGraphEventSchema)
const bootstrapResponseSchema = z.strictObject({ authenticated: z.literal(true) })
const proposalResolutionResponseSchema = z.strictObject({
  proposalId: z.string(),
  resolution: z.enum(['accepted', 'rejected']),
})
const publicProfileSchema = z.strictObject({
  preferredName: z.string().nullable(),
  pronouns: z.string().nullable(),
  location: z.string().nullable(),
  timezone: z.string().nullable(),
  birthday: z.string().nullable(),
  birthdayGreetings: z.boolean().nullable(),
  occupation: z.string().nullable(),
  style: z.strictObject({
    engagement: z.string(),
    tone: z.string(),
    orientation: z.string(),
  }),
  prose: z.string(),
  dreams: z
    .strictObject({
      voice: z.enum(['first', 'second', 'third']).optional(),
      openerMention: z.boolean().optional(),
      promptSection: z.boolean().optional(),
    })
    .optional(),
})
const publicSettingsSchema = z.strictObject({
  safetyMode: z.enum(['companion', 'firewall']),
})
const dreamVerdictSchema = z.enum(['right', 'wrong', 'do_not_bring_up'])
const publicDreamRowSchema = z.strictObject({
  dreamId: z.string(),
  date: z.string(),
  period: z.string(),
  hasNarrative: z.boolean(),
  insightCount: z.number().int().nonnegative(),
})
const publicDreamRowsSchema = z.array(publicDreamRowSchema)
const dreamInsightKindSchema = z.enum([
  'pattern',
  'change_over_time',
  'connection',
  'open_question',
  'strength',
])
const publicDreamInsightSchema = z.strictObject({
  insightId: z.string(),
  kind: dreamInsightKindSchema,
  headline: z.string(),
  claim: z.string(),
  confidence: z.number().min(0).max(1),
  verdict: dreamVerdictSchema.optional(),
})
const publicDreamDetailSchema = z.strictObject({
  dreamId: z.string(),
  date: z.string(),
  period: z.string(),
  narrative: z.string().optional(),
  insights: z.array(publicDreamInsightSchema),
  processLog: z.string(),
})
const dreamFeedbackRequestSchema = z.strictObject({
  insightId: z.string(),
  verdict: dreamVerdictSchema,
  note: z.string().optional(),
})
// The feedback endpoint's own response body is not part of the shared HTTP
// contract (only its request body is), so this mirrors the established
// resolve-and-echo-back convention already used for proposal resolution
// rather than inventing a new shape.
const dreamFeedbackResponseSchema = z.strictObject({
  insightId: z.string(),
  verdict: dreamVerdictSchema,
})

// Backs the web Dreams tab's status panel and answers the question the
// 2026-08-25 dreaming investigation found had no answer anywhere: whether
// dreaming is on, whether it can run right now, and why the last real
// attempt did not produce a dream, if there was one.
const dreamAttemptOutcomeSchema = z.enum(['aborted', 'failed'])
const publicDreamAttemptSchema = z.strictObject({
  ts: z.string(),
  trigger: z.string(),
  outcome: dreamAttemptOutcomeSchema,
  reason: z.string(),
})
const dreamStatusSchema = z.strictObject({
  configured: z.boolean(),
  enabled: z.boolean(),
  cadence: z.enum(['daily', 'weekly']),
  model: z.string().optional(),
  period: z.string(),
  periodCovered: z.boolean(),
  reflectedSessionCount: z.number().int().nonnegative(),
  minReflectedSessions: z.number().int().nonnegative(),
  reflectedFloorMet: z.boolean(),
  due: z.boolean(),
  lastAttempt: publicDreamAttemptSchema.optional(),
})
function publicDreamStatus(status: DreamStatus): z.infer<typeof dreamStatusSchema> {
  return {
    configured: status.configured,
    enabled: status.enabled,
    cadence: status.cadence,
    ...(status.model !== undefined ? { model: status.model } : {}),
    period: status.period,
    periodCovered: status.periodCovered,
    reflectedSessionCount: status.reflectedSessionCount,
    minReflectedSessions: status.minReflectedSessions,
    reflectedFloorMet: status.reflectedFloorMet,
    due: status.due,
    ...(status.lastAttempt
      ? {
          lastAttempt: {
            ts: status.lastAttempt.ts,
            trigger: status.lastAttempt.trigger,
            outcome: status.lastAttempt.outcome,
            reason: status.lastAttempt.reason,
          },
        }
      : {}),
  }
}

// Built from the whitelist, key by key, never by serializing the loaded
// object. profile.md's own schema passes unknown keys through, so a
// hand-added or forward-written key can exist in the file; this endpoint
// does not echo it. timezoneSource is deliberately absent: it says how
// confident the zone is, which is an implementation detail rather than a
// setting.
function publicProfile(profile: Profile, style: StyleConfig): z.infer<typeof publicProfileSchema> {
  const meta = profile.meta
  return {
    preferredName: meta.preferredName ?? null,
    pronouns: meta.pronouns ?? null,
    location: meta.location ?? null,
    timezone: meta.timezone ?? null,
    birthday: meta.birthday ?? null,
    birthdayGreetings: meta.birthdayGreetings ?? null,
    occupation: meta.occupation ?? null,
    style: {
      engagement: style.engagement,
      tone: style.tone,
      orientation: style.orientation,
    },
    prose: profile.body,
    ...(meta.dreams
      ? {
          dreams: {
            voice: meta.dreams.voice,
            openerMention: meta.dreams.openerMention,
            promptSection: meta.dreams.promptSection,
          },
        }
      : {}),
  }
}
function publicDreamRow(dream: DreamSummary): z.infer<typeof publicDreamRowSchema> {
  return {
    dreamId: dream.dreamId,
    date: dream.date,
    period: dream.period,
    hasNarrative: dream.hasNarrative,
    insightCount: dream.insightCount,
  }
}

// insight.md's frontmatter carries whatever a dream run wrote, and a dream
// directory can be partial (see engineDreams.ts's own comments on this): a
// malformed or missing entry inside meta.insights is dropped rather than
// thrown, the same tolerance readDreamById already applies one level up at
// the file level.
function publicDreamInsights(
  insightsDoc: Document,
  verdicts: Map<string, DreamVerdict>,
): z.infer<typeof publicDreamInsightSchema>[] {
  const raw = insightsDoc.meta.insights
  if (!Array.isArray(raw)) return []
  const insights: z.infer<typeof publicDreamInsightSchema>[] = []
  for (const entry of raw) {
    const candidate = entry as Record<string, unknown>
    const parsed = publicDreamInsightSchema.omit({ verdict: true }).safeParse({
      insightId: candidate.id,
      kind: candidate.kind,
      headline: candidate.headline,
      claim: candidate.claim,
      confidence: candidate.confidence,
    })
    if (!parsed.success) continue
    const verdict = verdicts.get(parsed.data.insightId)
    insights.push({ ...parsed.data, ...(verdict !== undefined ? { verdict } : {}) })
  }
  return insights
}

function publicDreamDetail(
  dream: { summary: DreamSummary; narrative?: Document; insights: Document; processLog: string },
  verdicts: Map<string, DreamVerdict>,
): z.infer<typeof publicDreamDetailSchema> {
  return {
    dreamId: dream.summary.dreamId,
    date: dream.summary.date,
    period: dream.summary.period,
    ...(dream.narrative ? { narrative: dream.narrative.body } : {}),
    insights: publicDreamInsights(dream.insights, verdicts),
    processLog: dream.processLog,
  }
}

// Feedback verdicts live only in the append-only dream log, not in
// insight.md itself: a written insight is a record, feedback on it is a
// separate, later event. engine.readDream does not carry them, so this
// reads the log directly the same way the CLI's `reverie dream --show`
// already does, through readDreamLog and foldDreamLog: both host-agnostic
// (they take a MemoryPaths and read through whatever AppendOnlyStore it
// was built over, per P0-1).
//
// The MemoryPaths comes from engine.memoryPaths, not from a dependency
// this function or its caller could be handed separately. This used to
// take an optional MemoryPaths as a HandleDeps member, defaulted by the
// node adapter (app.ts) from config when a caller did not supply one. That
// had two problems: a host that forgot to pass the dep got the same
// silent failure this was meant to fix (a 200 with every verdict
// dropped), and nothing stopped a host from passing a MemoryPaths built
// over different stores than its engine, which would read verdicts from
// somewhere other than where the rest of the dream record comes from.
// Reading through the engine's own paths makes both mistakes impossible:
// there is only one MemoryPaths in play, the one the engine was already
// built over, so every host gets verdicts and no host can wire them
// inconsistently.
//
// The try below tolerates only what the CLI's own equivalent tolerates: a
// dream log that has never been written, cannot be read, or fails to
// parse. Any of those still means the dream detail response must succeed,
// just without verdicts.
async function dreamFeedbackVerdicts(engine: RecordEngine): Promise<Map<string, DreamVerdict>> {
  try {
    const records = await readDreamLog(engine.memoryPaths)
    const state = foldDreamLog(records)
    const verdicts = new Map<string, DreamVerdict>()
    for (const [insightId, record] of state.feedback) verdicts.set(insightId, record.verdict)
    return verdicts
  } catch {
    return new Map()
  }
}

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
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw new Error('canonicalOrigin must be an origin only')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    !/^https?:\/\/[^/?#]+\/?$/i.test(origin)
  ) {
    throw new Error('canonicalOrigin must be an origin only')
  }
  return { origin: url.origin, host: url.host }
}

// A Web-standard Request always carries a full, already-parsed absolute
// URL in request.url, unlike node:http's IncomingMessage.url (path and
// query only). Building that Request is the node adapter's job (app.ts);
// by the time one reaches here, a URL that fails to parse is not a
// possibility this function needs to guard against, only the 414 check
// below, which node:http's IncomingMessage.url path never gave for free
// either.
function parseRequestUrl(request: Request): URL {
  const url = new URL(request.url)
  if (byteLength(url.search.replace(/^\?/, '')) > LIMITS.queryBytes) {
    throw new ApiError(414, 'request_uri_too_large', 'The request URL is too large.')
  }
  return url
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

function requiredTurnId(value: string | null): string {
  if (
    value === null ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new ApiError(400, 'invalid_request', 'The turn identifier is invalid.')
  }
  return value
}

function parseLastSequence(value: string | null): number | undefined {
  if (value === null) return undefined
  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, 'invalid_request', 'The replay sequence is invalid.')
  }
  const sequence = Number(value)
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new ApiError(400, 'invalid_request', 'The replay sequence is invalid.')
  }
  return sequence
}

function requireHost(request: Request, host: string): void {
  if (request.headers.get('host') !== host) {
    throw new ApiError(400, 'host_forbidden', 'The request host is not allowed.')
  }
}

function requireAuthenticatedRead(
  request: Request,
  auth: BootstrapAuth,
  canonical: CanonicalOrigin,
): void {
  requireHost(request, canonical.host)
  if (!auth.authenticate(request.headers.get('cookie') ?? undefined)) {
    throw new ApiError(401, 'unauthorized', 'Unauthorized.')
  }
}

function requireAuthenticatedWrite(
  request: Request,
  auth: BootstrapAuth,
  canonical: CanonicalOrigin,
  originPolicy: HandleDeps['writeOriginPolicy'],
): void {
  requireAuthenticatedRead(request, auth, canonical)
  const origin = request.headers.get('origin')
  if (
    (originPolicy === 'required' && origin === null) ||
    (origin !== null && origin !== canonical.origin)
  ) {
    throw new ApiError(403, 'origin_forbidden', 'Request origin is not allowed.')
  }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

// Preserves the incremental byte cap the node:http version had: bytes are
// counted as the body streams in, and a request over the limit is rejected
// with a 413 while still reading, not after buffering the whole thing.
// Reading via request.text() first and checking the length afterward is
// not equivalent (it is exactly the change this function's own tests
// falsify): a hostile oversized body would be fully buffered in memory
// before ever being rejected.
async function readJson(request: Request, maxBytes = LIMITS.requestBytes): Promise<unknown> {
  const chunks: Uint8Array[] = []
  let bytes = 0
  const reader = request.body?.getReader()
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > maxBytes) {
          await reader.cancel('request_too_large').catch(() => undefined)
          throw new ApiError(413, 'request_too_large', 'The request is too large.')
        }
        chunks.push(value)
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // Already released by the cancel() above.
      }
    }
  }
  try {
    return JSON.parse(new TextDecoder('utf-8').decode(concatChunks(chunks, bytes)))
  } catch {
    throw new ApiError(400, 'invalid_json', 'The request body must be JSON.')
  }
}

// POST /api/v1/sessions has always been callable with no body, and still
// is. An empty body means an empty object, not a parse error.
async function readJsonOrEmpty(request: Request): Promise<unknown> {
  try {
    return await readJson(request)
  } catch (error) {
    if (error instanceof ApiError && error.code === 'invalid_json') return {}
    throw error
  }
}

interface PageOptions<T, R extends CursorResource> {
  resource: R
  query: URLSearchParams
  revisionValue: unknown
  tuple: (record: T) => readonly unknown[]
  byteLimit: number | undefined
  recordByteLimit?: number
  fallback?: number
  maximum?: number
  recordTooLargeCode?: string
  cursorParam?: string
  revision?: string
  hash: HashProvider
}

function pageResource<T, R extends CursorResource>(
  records: T[],
  options: PageOptions<T, R>,
): { data: T[]; nextCursor: string | null } {
  const fallback = options.fallback ?? 50
  const maximum = options.maximum ?? 200
  const limit = parsePageLimit(options.query.get('limit'), fallback, maximum)
  const revision = options.revision ?? revisionFor(options.revisionValue, options.hash)
  let start = 0
  const cursor = options.query.get(options.cursorParam ?? 'cursor')
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
    if (
      options.recordByteLimit !== undefined &&
      byteLength(JSON.stringify(record)) > options.recordByteLimit
    ) {
      throw new ApiError(
        413,
        options.recordTooLargeCode ?? 'record_too_large',
        'A record is too large.',
      )
    }
    const next = [...data, record]
    const nextEnd = end + 1
    const nextCursor =
      nextEnd < records.length ? cursorFor(options.resource, options.tuple(record), revision) : null
    if (
      options.byteLimit !== undefined &&
      byteLength(JSON.stringify(envelope(next, nextCursor))) > options.byteLimit
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

function revisionFor(value: unknown, hash: HashProvider): string {
  return toBase64Url(hash.sha256(utf8.encode(JSON.stringify(value))))
}

type PublicGraphEvent =
  | {
      sequence: number
      op: 'assert'
      kind: 'node'
      assertedAt: string
      node: PublicGraphNode
    }
  | { sequence: number; op: 'retract'; kind: 'node'; assertedAt: string; nodeId: string }
  | {
      sequence: number
      op: 'assert'
      kind: 'edge'
      assertedAt: string
      edge: PublicGraphEdge
    }
  | { sequence: number; op: 'retract'; kind: 'edge'; assertedAt: string; edgeKey: string }

function publicGraphEvent(event: SequencedGraphRecord, engine: RecordEngine): PublicGraphEvent {
  const { sequence, record } = event
  if ('node' in record) {
    return record.op === 'assert'
      ? {
          sequence,
          op: 'assert',
          kind: 'node',
          assertedAt: record.ts,
          node: publicNodeRecord(record, engine),
        }
      : { sequence, op: 'retract', kind: 'node', assertedAt: record.ts, nodeId: record.node }
  }
  return record.op === 'assert'
    ? {
        sequence,
        op: 'assert',
        kind: 'edge',
        assertedAt: record.ts,
        edge: publicEdgeRecord(record),
      }
    : {
        sequence,
        op: 'retract',
        kind: 'edge',
        assertedAt: record.ts,
        edgeKey: `${record.edge}:${record.from}:${record.to}`,
      }
}

function publicNodeRecord(
  record: Extract<SequencedGraphRecord['record'], { node: string }>,
  engine: RecordEngine,
): PublicGraphNode {
  const docId = record.doc ? engine.docIdForPath(record.doc) : undefined
  return {
    id: record.node,
    type: record.type,
    label: record.label,
    ...(docId ? { docId } : {}),
    assertedAt: record.ts,
  }
}

function publicEdgeRecord(
  record: Extract<SequencedGraphRecord['record'], { edge: string }>,
): PublicGraphEdge {
  return {
    key: `${record.edge}:${record.from}:${record.to}`,
    type: record.edge,
    from: record.from,
    to: record.to,
    confidence: record.confidence,
    confirmed: record.confirmed,
    ...(record.source ? { sourceSessionId: record.source } : {}),
    assertedAt: record.ts,
  }
}

function graphEventRevision(events: PublicGraphEvent[], hash: HashProvider): string {
  return toHex(hash.sha256(utf8.encode(canonicalJson(events))))
}

function ensureGraphSnapshotResponseSize(snapshot: {
  revision: string
  nodes: PublicGraphNode[]
  edges: PublicGraphEdge[]
}): void {
  if (byteLength(JSON.stringify(envelope(snapshot, null))) > LIMITS.graphPageBytes) {
    throw new ApiError(413, 'graph_snapshot_too_large', 'The graph snapshot is too large.')
  }
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
  sink: ResponseSink,
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
  writeJson(sink, status, payload.data, maxBytes)
}

function writeJson(sink: ResponseSink, status: number, payload: unknown, maxBytes?: number): void {
  const serialized = JSON.stringify(payload)
  const bytes = byteLength(serialized)
  if (maxBytes !== undefined && bytes > maxBytes) {
    throw new ApiError(413, 'resource_too_large', 'The requested resource is too large.')
  }
  sink.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes,
  })
  sink.end(serialized)
}

async function writeNdjson(sink: ResponseSink, events: AsyncIterable<StreamEvent>): Promise<void> {
  const iterator = events[Symbol.asyncIterator]()
  let first: IteratorResult<StreamEvent>
  try {
    first = await iterator.next()
  } catch (error) {
    await iterator.return?.()
    throw error
  }

  sink.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' })
  let closed = false
  const onClose = (): void => {
    closed = true
    void iterator.return?.()
  }
  sink.once('close', onClose)
  try {
    if (!first.done && !closed) sink.write(`${JSON.stringify(first.value)}\n`)
    while (!closed) {
      const next = await iterator.next()
      if (next.done) break
      sink.write(`${JSON.stringify(next.value)}\n`)
    }
    if (!closed) sink.end()
  } finally {
    sink.off('close', onClose)
    await iterator.return?.()
  }
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  return new ApiError(500, 'internal_error', 'The server could not process the request.')
}

function writeError(sink: ResponseSink, error: ApiError): void {
  if (sink.headersSent) return
  writeJson(sink, error.status, { schemaVersion: '1', code: error.code, message: error.message })
}

// The Web-standard entry point: what a Cloudflare Workers style host calls
// directly, and what a self-hosted Bun or Deno process could call too.
// deps.hash and deps.serveStatic are exactly the two seams item 4 and the
// HashProvider comment above exist for: everything else needed to answer
// an /api/v1 request is already Web-standard.
//
// deps.bootstrap is opt-in and absent by default here, unlike the node
// adapter (app.ts), which always supplies it. A host that authenticates
// its own way never gets an unauthenticated cookie-issuing endpoint unless
// it deliberately asks for one. There is no equivalent memoryPaths dep:
// deps.engine already carries a MemoryPaths (RecordEngine.memoryPaths),
// and dreamFeedbackVerdicts reads through that, so every host gets dream
// feedback verdicts read from the same stores as the rest of the record,
// with nothing extra to wire up.
export interface FetchAppDeps {
  engine: RecordEngine
  auth: BootstrapAuth
  config?: ReverieConfig
  canonicalOrigin?: string
  origin?: string
  writeOriginPolicy: HandleDeps['writeOriginPolicy']
  registry?: LiveSessionRegistry
  hash: HashProvider
  serveStatic?: (sink: ResponseSink, pathname: string) => Promise<void>
  bootstrap?: Pick<BootstrapAuth, 'exchange'>
}

export function createFetchApp(deps: FetchAppDeps): (request: Request) => Promise<Response> {
  const canonical = parseCanonicalOrigin(deps.origin ?? deps.canonicalOrigin ?? '')
  const proposalResolutionLocks = new Map<string, Promise<void>>()
  const handleDeps: HandleDeps = {
    engine: deps.engine,
    auth: deps.auth,
    canonical,
    writeOriginPolicy: deps.writeOriginPolicy,
    proposalResolutionLocks,
    registry: deps.registry,
    config: deps.config,
    hash: deps.hash,
    serveStatic: deps.serveStatic,
    bootstrap: deps.bootstrap,
  }
  return (request: Request): Promise<Response> => {
    const sink = new WebResponseSink()
    void handle(request, sink, handleDeps).catch((error: unknown) => {
      writeError(sink, toApiError(error))
    })
    return sink.responseReady
  }
}

export type { CanonicalOrigin, HandleDeps }
export { parseCanonicalOrigin, toApiError, writeError, writeJson, writeNdjson, writePublicJson }
