import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ReverieConfig } from '@openreverie/core'
import {
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

export interface RecordEngine {
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
}

export interface CreateAppDeps {
  engine: RecordEngine
  auth: BootstrapAuth
  config?: ReverieConfig
  canonicalOrigin?: string
  origin?: string
  registry?: LiveSessionRegistry
  staticDir?: string
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
  const canonical = parseCanonicalOrigin(deps.origin ?? deps.canonicalOrigin ?? '')
  const proposalResolutionLocks = new Map<string, Promise<void>>()
  return (req, res) => {
    void handle(
      req,
      res,
      deps.engine,
      deps.auth,
      canonical,
      proposalResolutionLocks,
      deps.registry,
      deps.staticDir,
      deps.config,
    ).catch((error: unknown) => {
      writeError(res, toApiError(error))
    })
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  engine: RecordEngine,
  auth: BootstrapAuth,
  canonical: CanonicalOrigin,
  proposalResolutionLocks: Map<string, Promise<void>>,
  registry: LiveSessionRegistry | undefined,
  staticDir: string | undefined,
  config: ReverieConfig | undefined,
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

  if (path[0] !== 'api') {
    if (staticDir) {
      await serveStatic(res, staticDir, parsed.pathname)
      return
    }
    throw new ApiError(404, 'not_found', 'The requested resource was not found.')
  }

  if (path[1] !== 'v1') {
    throw new ApiError(404, 'not_found', 'The requested resource was not found.')
  }

  if (method === 'GET' || method === 'HEAD') {
    requireAuthenticatedRead(req, auth, canonical)
  } else {
    requireAuthenticatedWrite(req, auth, canonical)
  }

  if (method === 'GET' && path.length === 4 && path[2] === 'graph' && path[3] === 'snapshot') {
    const snapshot = makeGraphSnapshot(engine.graphSnapshot())
    ensureGraphSnapshotResponseSize(snapshot)
    const etag = `"${snapshot.revision}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag })
      res.end()
      return
    }
    res.setHeader('etag', etag)
    writePublicJson(res, 200, publicGraphSnapshotSchema, snapshot, null, LIMITS.graphPageBytes)
    return
  }

  if (method === 'GET' && path.length === 4 && path[2] === 'graph' && path[3] === 'events') {
    const events = (await engine.readGraphHistory()).map((event) => publicGraphEvent(event, engine))
    const page = pageResource(events, {
      resource: 'graph_events',
      query: parsed.searchParams,
      revisionValue: events,
      revision: graphEventRevision(events),
      tuple: (event) => [event.sequence],
      byteLimit: LIMITS.graphPageBytes,
      recordByteLimit: LIMITS.graphEventBytes,
      recordTooLargeCode: 'record_too_large',
      cursorParam: 'after',
      fallback: 500,
      maximum: 2000,
    })
    writePublicJson(
      res,
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
    })
    writePublicJson(res, 200, publicSessionsSchema, page.data, page.nextCursor)
    return
  }

  if (method === 'GET' && path.length === 4 && path[2] === 'sessions') {
    const sessionId = requiredId(path[3])
    const session =
      registry?.getLiveSession(sessionId) ??
      (await engine.listStoredSessions()).find((item) => item.sessionId === sessionId)
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

  if (registry && method === 'POST' && path.length === 3 && path[2] === 'sessions') {
    const raw = await readJsonOrEmpty(req)
    const body = createSessionSchema.safeParse(raw)
    if (!body.success) throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    const session = await registry.create(
      body.data.mode === undefined ? {} : { mode: body.data.mode },
    )
    writePublicJson(res, 201, createSessionResponseSchema, session, null)
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
    const turnId = requiredTurnId(req.headers['x-reverie-turn-id'])
    const after = parseLastSequence(req.headers['x-reverie-last-sequence'])
    const body = messageSchema.safeParse(await readJson(req))
    if (!body.success) throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    if (Buffer.byteLength(body.data.message, 'utf8') > LIMITS.messageBytes) {
      throw new ApiError(413, 'message_too_large', 'The message is too large.')
    }
    await writeNdjson(res, registry.message(sessionId, turnId, body.data, after))
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
    const after = parseLastSequence(req.headers['x-reverie-last-sequence'])
    await writeNdjson(res, registry.events(sessionId, after))
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
    writePublicJson(res, 200, publicSessionSchema, session, null)
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
    const body = sessionModeSchema.safeParse(await readJson(req))
    if (!body.success) throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    const result = await registry.setMode(sessionId, body.data.mode)
    writePublicJson(res, 200, sessionModeResponseSchema, result, null)
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

  if (method === 'GET' && path.length === 3 && path[2] === 'profile') {
    writePublicJson(
      res,
      200,
      publicProfileSchema,
      publicProfile(engine.profile(), engine.currentStyle()),
      null,
    )
    return
  }

  if (method === 'PATCH' && path.length === 3 && path[2] === 'profile') {
    const body = profileSettingsPatchSchema.safeParse(await readJson(req))
    // An unrecognized key in a file the user may hand-edit is probably
    // intentional; an unrecognized key arriving over HTTP is probably a
    // mistake or an attempt. So the file schema passes them through and this
    // one rejects the whole body rather than applying it in part.
    if (!body.success) throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    const profile = await engine.updateProfileSettings(body.data)
    writePublicJson(
      res,
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
    writePublicJson(res, 200, publicSettingsSchema, { safetyMode }, null)
    return
  }

  throw new ApiError(404, 'not_found', 'The requested resource was not found.')
}

const staticContentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

async function serveStatic(
  res: ServerResponse,
  staticDir: string,
  pathname: string,
): Promise<void> {
  const decoded = decodeURIComponent(pathname)
  const requested = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const extension = extname(requested).toLowerCase()
  const contentType = staticContentTypes[extension]

  if (requested !== 'index.html' && extension === '') {
    await serveStatic(res, staticDir, '/')
    return
  }
  if (contentType === undefined)
    throw new ApiError(404, 'not_found', 'The requested resource was not found.')

  try {
    const file = await resolveStaticFile(staticDir, requested)
    const contents = await readFile(file)
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': contents.byteLength,
      ...(requested === 'index.html' ? { 'cache-control': 'no-store' } : {}),
    })
    res.end(contents)
  } catch (error) {
    if (!isMissingFile(error)) throw error
    throw new ApiError(404, 'not_found', 'The requested resource was not found.')
  }
}

async function resolveStaticFile(staticDir: string, requested: string): Promise<string> {
  const realStaticDir = await realpath(staticDir)
  const candidate = resolve(realStaticDir, requested)
  if (!isWithinDirectory(realStaticDir, candidate)) {
    throw new ApiError(404, 'not_found', 'The requested resource was not found.')
  }

  const realFile = await realpath(candidate)
  if (!isWithinDirectory(realStaticDir, realFile)) {
    throw new ApiError(404, 'not_found', 'The requested resource was not found.')
  }
  return realFile
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const path = relative(directory, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
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
const graphNodeTypeSchema = z.enum(['realm', 'arc', 'item', 'session', 'person', 'entity'])
const graphEdgeTypeSchema = z.enum(['part_of', 'in', 'from', 'involves', 'relates_to'])
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
})
const publicSettingsSchema = z.strictObject({
  safetyMode: z.enum(['companion', 'firewall']),
})

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

function requiredTurnId(value: string | string[] | undefined): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new ApiError(400, 'invalid_request', 'The turn identifier is invalid.')
  }
  return value
}

function parseLastSequence(value: string | string[] | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ApiError(400, 'invalid_request', 'The replay sequence is invalid.')
  }
  const sequence = Number(value)
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new ApiError(400, 'invalid_request', 'The replay sequence is invalid.')
  }
  return sequence
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

// POST /api/v1/sessions has always been callable with no body, and still
// is. An empty body means an empty object, not a parse error.
async function readJsonOrEmpty(req: IncomingMessage): Promise<unknown> {
  try {
    return await readJson(req)
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
}

function pageResource<T, R extends CursorResource>(
  records: T[],
  options: PageOptions<T, R>,
): { data: T[]; nextCursor: string | null } {
  const fallback = options.fallback ?? 50
  const maximum = options.maximum ?? 200
  const limit = parsePageLimit(options.query.get('limit'), fallback, maximum)
  const revision = options.revision ?? revisionFor(options.revisionValue)
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
      Buffer.byteLength(JSON.stringify(record), 'utf8') > options.recordByteLimit
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

function graphEventRevision(events: PublicGraphEvent[]): string {
  return createHash('sha256').update(canonicalJson(events), 'utf8').digest('hex')
}

function ensureGraphSnapshotResponseSize(snapshot: {
  revision: string
  nodes: PublicGraphNode[]
  edges: PublicGraphEdge[]
}): void {
  if (Buffer.byteLength(JSON.stringify(envelope(snapshot, null)), 'utf8') > LIMITS.graphPageBytes) {
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

async function writeNdjson(res: ServerResponse, events: AsyncIterable<StreamEvent>): Promise<void> {
  const iterator = events[Symbol.asyncIterator]()
  let first: IteratorResult<StreamEvent>
  try {
    first = await iterator.next()
  } catch (error) {
    await iterator.return?.()
    throw error
  }

  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' })
  let closed = false
  const onClose = (): void => {
    closed = true
    void iterator.return?.()
  }
  res.once('close', onClose)
  try {
    if (!first.done && !closed) res.write(`${JSON.stringify(first.value)}\n`)
    while (!closed) {
      const next = await iterator.next()
      if (next.done) break
      res.write(`${JSON.stringify(next.value)}\n`)
    }
    if (!closed) res.end()
  } finally {
    res.off('close', onClose)
    await iterator.return?.()
  }
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  return new ApiError(500, 'internal_error', 'The server could not process the request.')
}

function writeError(res: ServerResponse, error: ApiError): void {
  if (res.headersSent) return
  writeJson(res, error.status, { schemaVersion: '1', code: error.code, message: error.message })
}
