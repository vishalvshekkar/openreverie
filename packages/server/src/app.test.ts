import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingHttpHeaders,
  request as nodeRequest,
  type Server,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultCrisisResources, type ReverieConfig } from '@openreverie/core'
import type {
  Document,
  DreamStatus,
  DreamSummary,
  DreamVerdict,
  EngineSearchResult,
  GraphRecord,
  MemoryPaths,
  Profile,
  ProfileSettingsPatch,
  PublicDocument,
  PublicDocumentRow,
  PublicGraphEdge,
  PublicGraphNode,
  PublicSession,
  SequencedGraphRecord,
  StyleConfig,
  TranscriptLine,
} from '@openreverie/memory'
import {
  appendDreamLog,
  type EngineDeps,
  MemoryEngine,
  memoryPaths,
  nodeStores,
  resolveStyle,
  writeProfile,
} from '@openreverie/memory'
import { FakeChatProvider, FakeEmbeddingProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type RecordEngine } from './app.js'
import { createBootstrapAuth } from './auth.js'
import { LiveSessionRegistry } from './registry.js'

interface Response {
  status: number
  headers: IncomingHttpHeaders
  json: unknown
}

const sessionId = 'session_01K2XNJYABCD12345678901234'
const userLine: TranscriptLine = {
  ts: '2026-08-15T10:00:00.000Z',
  utcOffsetMinutes: 330,
  role: 'user',
  content: 'Hello.',
}
const assistantLine: TranscriptLine = {
  ts: '2026-08-15T10:00:01.000Z',
  role: 'assistant',
  content: 'Hi.',
}

class FakeEngine implements RecordEngine {
  // Most tests in this file never touch dream feedback verdicts, so the
  // default points at a directory nothing ever writes to: readDreamLog
  // fails to find it, dreamFeedbackVerdicts' own catch treats that as "no
  // verdicts yet", same as before this file needed a real MemoryPaths at
  // all. The "dream detail merges feedback verdicts" suite below passes
  // its own paths, built over the same temp directory its dream log
  // fixture is written to.
  readonly memoryPaths: MemoryPaths

  constructor(paths: MemoryPaths = memoryPaths('/fake/memory-not-a-real-directory', nodeStores())) {
    this.memoryPaths = paths
  }

  documents: PublicDocument[] = [
    {
      docId: 'doc_one',
      kind: 'person',
      title: 'Mina',
      updatedAt: '2026-08-15T10:00:00.000Z',
      readOnly: true,
      body: 'Mina.',
    },
    {
      docId: 'doc_large',
      kind: 'person',
      title: 'Large',
      updatedAt: '2026-08-15T10:00:00.000Z',
      readOnly: true,
      body: 'x'.repeat(4 * 1024 * 1024 + 1),
    },
  ]
  sessions: PublicSession[] = [
    {
      sessionId,
      createdAt: '2026-08-15T09:00:00.000Z',
      updatedAt: '2026-08-15T10:00:01.000Z',
      status: 'ended',
      readOnly: true,
      transcript: { lineCount: 2, userCount: 1, assistantCount: 1, toolCount: 0 },
      reflection: { state: 'reflected', attempts: 1 },
    },
    {
      sessionId: 'session_01K2XNJYABCD12345678901235',
      createdAt: '2026-08-14T09:00:00.000Z',
      updatedAt: '2026-08-14T09:00:00.000Z',
      status: 'ended',
      readOnly: true,
      transcript: { lineCount: 0, userCount: 0, assistantCount: 0, toolCount: 0 },
      reflection: { state: 'reflected', attempts: 1 },
    },
  ]
  lines: TranscriptLine[] = [userLine, assistantLine]
  snapshot: { nodes: PublicGraphNode[]; edges: PublicGraphEdge[] } = {
    nodes: [
      { id: 'person_1', type: 'person', label: 'Mina', assertedAt: '2026-08-15T10:00:00.000Z' },
      { id: 'item_1', type: 'item', label: 'Notebook', assertedAt: '2026-08-15T10:00:00.000Z' },
    ],
    edges: [
      {
        key: 'in:item_1:realm_1',
        type: 'in',
        from: 'item_1',
        to: 'realm_1',
        confidence: 0.8,
        confirmed: true,
        assertedAt: '2026-08-15T10:00:01.000Z',
      },
    ],
  }
  history: SequencedGraphRecord[] = [
    {
      sequence: 1,
      record: {
        ts: '2026-08-15T10:00:00.000Z',
        op: 'assert',
        node: 'person_1',
        type: 'person',
        label: 'Mina',
      },
    },
    {
      sequence: 2,
      record: {
        ts: '2026-08-15T10:00:01.000Z',
        op: 'retract',
        node: 'person_1',
        type: 'person',
        label: 'Mina',
      },
    },
    {
      sequence: 3,
      record: {
        ts: '2026-08-15T10:00:02.000Z',
        op: 'assert',
        edge: 'in',
        from: 'item_1',
        to: 'realm_1',
        confidence: 0.8,
        confirmed: true,
      },
    },
  ]
  proposals = [
    {
      id: 'prop_1',
      ts: '2026-08-15T08:00:00.000Z',
      kind: 'link' as const,
      summary: 'A legacy link.',
      payload: {},
      source: sessionId,
    },
  ]
  resolved: string[] = []
  resolveCalls = 0
  private resolutionGate: Promise<void> | undefined
  private releaseResolutionGate: (() => void) | undefined

  pauseProposalResolution(): void {
    this.resolutionGate = new Promise<void>((resolve) => {
      this.releaseResolutionGate = resolve
    })
  }

  resumeProposalResolution(): void {
    this.releaseResolutionGate?.()
  }

  async listPublicDocuments(): Promise<PublicDocumentRow[]> {
    return this.documents.map(({ body: _body, ...row }) => row)
  }
  async getPublicDocument(id: string): Promise<PublicDocument | null> {
    return this.documents.find((document) => document.docId === id) ?? null
  }
  async listStoredSessions(): Promise<PublicSession[]> {
    return this.sessions
  }
  async readTranscriptPage(id: string): Promise<(TranscriptLine & { lineSequence: number })[]> {
    if (!this.sessions.some((session) => session.sessionId === id)) throw new Error('missing')
    return this.lines.map((line, index) => ({ lineSequence: index + 1, ...line }))
  }
  graphSnapshot(): { nodes: PublicGraphNode[]; edges: PublicGraphEdge[] } {
    return this.snapshot
  }
  async readGraphHistory(): Promise<SequencedGraphRecord[]> {
    return this.history
  }
  docIdForPath(_path: string): string | undefined {
    return undefined
  }
  async listPendingProposals() {
    return this.proposals
  }
  async resolveProposal(id: string, resolution: 'accepted' | 'rejected'): Promise<void> {
    this.resolveCalls += 1
    await this.resolutionGate
    this.resolved.push(`${id}:${resolution}`)
    this.proposals = this.proposals.filter((proposal) => proposal.id !== id)
  }
  renamePublicDocument(id: string, title: string): void {
    const document = this.documents.find((item) => item.docId === id)
    if (document) document.title = title
  }

  profileState: Profile = { meta: { id: 'profile_fake' }, body: '' }

  profile(): Profile {
    return this.profileState
  }

  currentStyle(): StyleConfig {
    return resolveStyle(this.profileState.meta.style)
  }

  async updateProfileSettings(patch: ProfileSettingsPatch): Promise<Profile> {
    const meta: Profile['meta'] = { ...this.profileState.meta }
    const mutableMeta: Record<string, unknown> = meta
    for (const key of [
      'preferredName',
      'pronouns',
      'location',
      'timezone',
      'birthday',
      'occupation',
      'birthdayGreetings',
    ] as const) {
      const value = patch[key]
      if (value === undefined) continue
      if (value === null) {
        delete mutableMeta[key]
      } else {
        mutableMeta[key] = value
      }
    }
    if (patch.style !== undefined) meta.style = { ...(meta.style ?? {}), ...patch.style }
    if (patch.timezone !== undefined) meta.timezoneSource = 'user-confirmed'
    this.profileState = { meta, body: patch.prose ?? this.profileState.body }
    return this.profileState
  }

  dreams: DreamSummary[] = [
    {
      dreamId: 'dream_full',
      date: '2026-08-20',
      period: '2026-08-20',
      hasNarrative: true,
      insightCount: 2,
      dir: '/fake/dreams/dream_full',
    },
    {
      dreamId: 'dream_partial',
      date: '2026-08-21',
      period: '2026-08-21',
      hasNarrative: false,
      insightCount: 0,
      dir: '/fake/dreams/dream_partial',
    },
  ]
  dreamDetails = new Map<
    string,
    { summary: DreamSummary; narrative?: Document; insights: Document; processLog: string }
  >([
    [
      'dream_full',
      {
        summary: this.dreams[0] as DreamSummary,
        narrative: {
          path: '/fake/dreams/dream_full/dream.md',
          meta: { id: 'dream_full' },
          body: 'A narrative about the week.',
        },
        insights: {
          path: '/fake/dreams/dream_full/insight.md',
          meta: {
            id: 'ins_doc',
            insights: [
              {
                id: 'ins_1',
                kind: 'pattern',
                headline: 'A recurring pattern',
                claim: 'Something happened more than once.',
                confidence: 0.7,
                evidence: [{ doc: 'doc_one' }],
              },
              // Malformed on purpose: no headline. This is the tolerance
              // case for an interrupted or hand-edited insight.md; it must
              // be dropped, not turned into a 500.
              {
                id: 'ins_broken',
                kind: 'pattern',
                claim: 'Missing a headline.',
                confidence: 0.5,
                evidence: [],
              },
            ],
          },
          body: '## A recurring pattern (ins_1)\n\nSomething happened more than once.',
        },
        processLog: '{"event":"dream_started"}\n{"event":"dream_finished"}\n',
      },
    ],
    [
      'dream_partial',
      {
        // A tone-withheld or interrupted dream: insight.md exists, no
        // dream.md, and no insights survived. narrative is legitimately
        // absent, not a bug.
        summary: this.dreams[1] as DreamSummary,
        insights: {
          path: '/fake/dreams/dream_partial/insight.md',
          meta: { id: 'ins_doc_partial', insights: [] },
          body: '',
        },
        processLog: '',
      },
    ],
  ])
  feedbackCalls: {
    insightId: string
    verdict: DreamVerdict
    note?: string
    source: 'ui' | 'tool'
  }[] = []
  feedbackKnownInsightIds = new Set(['ins_1'])

  async listDreams(): Promise<DreamSummary[]> {
    return this.dreams
  }

  async readDream(dreamId: string): Promise<{
    summary: DreamSummary
    narrative?: Document
    insights: Document
    processLog: string
  } | null> {
    return this.dreamDetails.get(dreamId) ?? null
  }

  async recordDreamFeedback(args: {
    insightId: string
    verdict: DreamVerdict
    note?: string
    source: 'ui' | 'tool'
  }): Promise<boolean> {
    this.feedbackCalls.push(args)
    return this.feedbackKnownInsightIds.has(args.insightId)
  }

  dreamStatusValue: DreamStatus = {
    configured: false,
    enabled: false,
    cadence: 'daily',
    triggers: { afterSession: false, onStart: false, serverTimer: false },
    model: undefined,
    timezone: 'UTC',
    period: '2026-08-25',
    periodCovered: false,
    reflectedSessionCount: 0,
    minReflectedSessions: 5,
    reflectedFloorMet: false,
    due: false,
  }

  async dreamStatus(): Promise<DreamStatus> {
    return this.dreamStatusValue
  }

  // Search itself is exercised end to end through fetch-app.test.ts's
  // GET /api/v1/search suite, against the same shared route logic
  // (http-core.ts's handle). This stub only needs to satisfy
  // RecordEngine.search so this file, which never calls it, keeps
  // compiling.
  async search(): Promise<EngineSearchResult> {
    return { documents: [], nodes: [] }
  }
}

describe('record browsing app', () => {
  let server: Server
  let origin: string
  let host: string
  let port: number
  let cookie: string
  let engine: FakeEngine

  beforeEach(async () => {
    engine = new FakeEngine()
    server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    port = address.port
    host = `127.0.0.1:${port}`
    origin = `http://${host}`
    const { token, auth } = createBootstrapAuth({
      origin,
      now: () => 0,
      randomBytes: () => Buffer.alloc(32, 7),
    })
    server.removeAllListeners('request')
    server.on('request', createApp({ engine, auth, canonicalOrigin: origin }))
    const response = await request('POST', '/api/v1/auth/bootstrap', { token }, { host })
    cookie = response.headers['set-cookie']?.[0]?.split(';', 1)[0] ?? ''
  })

  afterEach(async () => {
    server.closeAllConnections()
    if (!server.listening) return
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })

  function authenticated(overrides: Record<string, string> = {}): Record<string, string> {
    return { host, cookie, ...overrides }
  }

  function request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const text =
      body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = nodeRequest(
        {
          hostname: '127.0.0.1',
          port,
          method,
          path,
          agent: false,
          headers: {
            connection: 'close',
            ...(text === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }),
            ...headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              json: (() => {
                const body = Buffer.concat(chunks).toString('utf8')
                return body === '' ? null : JSON.parse(body)
              })(),
            }),
          )
        },
      )
      req.on('error', reject)
      req.end(text)
    })
  }

  function getJson(path: string, headers = authenticated()): Promise<Response> {
    return request('GET', path, undefined, headers)
  }

  it('exchanges a launch token once, cleans access to authenticated reads, and rejects replay generically', async () => {
    const { token, auth } = createBootstrapAuth({
      origin,
      now: () => 0,
      randomBytes: () => Buffer.alloc(32, 7),
    })
    const first = await requestWithAuth('POST', '/api/v1/auth/bootstrap', { token }, { host }, auth)
    expect(first.status).toBe(200)
    expect(first.headers['set-cookie']?.[0]).toContain('HttpOnly')
    const replay = await requestWithAuth(
      'POST',
      '/api/v1/auth/bootstrap',
      { token },
      { host },
      auth,
    )
    expect(replay).toMatchObject({
      status: 401,
      json: { schemaVersion: '1', code: 'unauthorized', message: 'Unauthorized.' },
    })
  })

  it('requires exact Host and exact Origin only for state changes', async () => {
    await expect(
      getJson('/api/v1/documents', authenticated({ host: 'localhost:4312' })),
    ).resolves.toMatchObject({ status: 400 })
    await expect(getJson('/api/v1/documents', authenticated({ host }))).resolves.toMatchObject({
      status: 200,
    })
    await expect(
      request(
        'POST',
        '/api/v1/proposals/prop_1/resolve',
        { resolution: 'rejected' },
        authenticated(),
      ),
    ).resolves.toMatchObject({ status: 403 })
    await expect(
      request(
        'POST',
        '/api/v1/proposals/prop_1/resolve',
        { resolution: 'rejected' },
        authenticated({ origin }),
      ),
    ).resolves.toMatchObject({ status: 200 })
  })

  it('reports settings as not found when the app was built without a config', async () => {
    // createApp({ engine, auth, canonicalOrigin: origin }) in this file's own
    // beforeEach passes no config, deliberately: config is optional on
    // CreateAppDeps, and the settings route must not fabricate a default
    // safety mode nor use a non-null assertion to paper over the absence.
    await expect(getJson('/api/v1/settings')).resolves.toMatchObject({ status: 404 })
  })

  it('enforces read resource bounds and cursor pagination without partial records', async () => {
    const page = (await getJson('/api/v1/sessions?limit=1')) as Response & {
      json: { data: unknown[]; meta: { nextCursor: string } }
    }
    expect(page.json.data).toHaveLength(1)
    expect(page.json.meta.nextCursor).toEqual(expect.any(String))
    await expect(
      getJson(`/api/v1/sessions?cursor=${encodeURIComponent(page.json.meta.nextCursor)}&limit=1`),
    ).resolves.toMatchObject({ status: 200 })
    await expect(getJson('/api/v1/documents/doc_large')).resolves.toMatchObject({
      status: 413,
      json: { code: 'resource_too_large' },
    })
    await expect(
      getJson(`/api/v1/sessions/${sessionId}/transcript?limit=1000`),
    ).resolves.toMatchObject({ status: 200 })
  })

  it('returns one canonical folded snapshot with stable SHA-256 revision and 304 ETag', async () => {
    const first = (await getJson('/api/v1/graph/snapshot')) as Response & {
      json: { data: { revision: string; nodes: unknown[]; edges: unknown[] } }
    }
    expect(first.json.data).toMatchObject({
      revision: /^[0-9a-f]{64}$/,
      nodes: expect.any(Array),
      edges: expect.any(Array),
    })
    expect(first.json.data.nodes).toMatchObject([{ id: 'item_1' }, { id: 'person_1' }])
    expect(first.headers.etag).toBe(`"${first.json.data.revision}"`)
    engine.snapshot.nodes.reverse()
    const second = (await getJson('/api/v1/graph/snapshot')) as Response & {
      json: { data: { revision: string } }
    }
    expect(second.json.data.revision).toBe(first.json.data.revision)
    await expect(
      request(
        'GET',
        '/api/v1/graph/snapshot',
        undefined,
        authenticated({ 'if-none-match': first.headers.etag as string }),
      ),
    ).resolves.toMatchObject({ status: 304, json: null })
  })

  it('serves a snapshot containing a commitment node and a waits_on edge instead of 500ing', async () => {
    // Regression guard for the bug this task fixes: writePublicJson
    // validates the server's own outbound response against
    // publicGraphSnapshotSchema, and that schema's node/edge type enums
    // used to be a hand copied list that fell out of sync with
    // @openreverie/memory's NodeType/EdgeType the moment 'commitment' and
    // 'waits_on' were added there. A stale copy makes this request 500
    // for any user with a single commitment in their graph.
    engine.snapshot = {
      nodes: [
        {
          id: 'commitment_1',
          type: 'commitment',
          label: 'See Nightfall with Arjun',
          assertedAt: '2026-08-15T10:00:00.000Z',
        },
      ],
      edges: [
        {
          key: 'waits_on:commitment_1:entity_1',
          type: 'waits_on',
          from: 'commitment_1',
          to: 'entity_1',
          confidence: 1,
          confirmed: true,
          assertedAt: '2026-08-15T10:00:00.000Z',
        },
      ],
    }

    const response = (await getJson('/api/v1/graph/snapshot')) as Response & {
      json: { data: { nodes: unknown[]; edges: unknown[] } }
    }

    expect(response.status).toBe(200)
    expect(response.json.data.nodes).toMatchObject([{ id: 'commitment_1', type: 'commitment' }])
    expect(response.json.data.edges).toMatchObject([{ type: 'waits_on' }])
  })

  it('preserves asserts and retracts in append sequence even when they are dangling', async () => {
    const response = (await getJson('/api/v1/graph/events?limit=2')) as Response & {
      json: { data: unknown[]; meta: { nextCursor: string } }
    }

    expect(response.json.data).toEqual([
      expect.objectContaining({
        sequence: 1,
        op: 'assert',
        kind: 'node',
        node: expect.objectContaining({ id: 'person_1' }),
      }),
      expect.objectContaining({ sequence: 2, op: 'retract', kind: 'node', nodeId: 'person_1' }),
    ])
    expect(response.json.meta.nextCursor).toEqual(expect.any(String))
  })

  it('rejects a graph-event cursor after the raw append history changes', async () => {
    const first = (await getJson('/api/v1/graph/events?limit=1')) as Response & {
      json: { meta: { nextCursor: string } }
    }
    const anotherAssert: GraphRecord = {
      ts: '2026-08-15T10:00:03.000Z',
      op: 'assert',
      node: 'person_2',
      type: 'person',
      label: 'Noor',
    }
    engine.history.push({ sequence: 4, record: anotherAssert })

    await expect(
      getJson(`/api/v1/graph/events?after=${encodeURIComponent(first.json.meta.nextCursor)}`),
    ).resolves.toMatchObject({ status: 400, json: { code: 'cursor_invalid' } })
  })

  it('fails rather than truncating an oversized graph snapshot or one oversized event', async () => {
    const large = 'x'.repeat(8 * 1024 * 1024)
    engine.snapshot = {
      nodes: [
        { id: 'person_1', type: 'person', label: large, assertedAt: '2026-08-15T10:00:00.000Z' },
      ],
      edges: [],
    }
    await expect(getJson('/api/v1/graph/snapshot')).resolves.toMatchObject({
      status: 413,
      json: { code: 'graph_snapshot_too_large' },
    })

    engine.history = [
      {
        sequence: 1,
        record: {
          ts: '2026-08-15T10:00:00.000Z',
          op: 'assert',
          node: 'person_1',
          type: 'person',
          label: 'x'.repeat(256 * 1024),
        },
      },
    ]
    await expect(getJson('/api/v1/graph/events')).resolves.toMatchObject({
      status: 413,
      json: { code: 'record_too_large' },
    })
  })

  it.each(['%', Buffer.from('{', 'utf8').toString('base64url')])(
    'returns 400 cursor_invalid for malformed documents cursor %j',
    async (cursor) => {
      await expect(
        getJson(`/api/v1/documents?cursor=${encodeURIComponent(cursor)}`),
      ).resolves.toMatchObject({
        status: 400,
        json: { schemaVersion: '1', code: 'cursor_invalid' },
      })
    },
  )

  it('returns 400 cursor_invalid for a stale document revision', async () => {
    const first = (await getJson('/api/v1/documents?limit=1')) as Response & {
      json: { data: PublicDocumentRow[]; meta: { nextCursor: string } }
    }
    const document = first.json.data.at(0)
    if (!document) throw new Error('expected a document')
    engine.renamePublicDocument(document.docId, 'Changed title')
    await expect(
      getJson(`/api/v1/documents?cursor=${encodeURIComponent(first.json.meta.nextCursor)}`),
    ).resolves.toMatchObject({ status: 400, json: { code: 'cursor_invalid' } })
  })

  it('returns the specified status for each request, identifier, query, and page bound', async () => {
    await expect(
      request('POST', '/api/v1/auth/bootstrap', 'x'.repeat(256 * 1024 + 1), {
        host,
        'content-type': 'application/json',
      }),
    ).resolves.toMatchObject({ status: 413 })
    await expect(getJson(`/api/v1/documents?x=${'a'.repeat(8193)}`)).resolves.toMatchObject({
      status: 414,
    })
    await expect(getJson(`/api/v1/documents/${'a'.repeat(257)}`)).resolves.toMatchObject({
      status: 400,
    })
    await expect(getJson('/api/v1/proposals?limit=201')).resolves.toMatchObject({ status: 400 })
    await expect(getJson('/api/v1/sessions?limit=0')).resolves.toMatchObject({ status: 400 })
  })

  it('returns durable transcript lines in append order with one-based lineSequence values', async () => {
    const response = (await getJson(`/api/v1/sessions/${sessionId}/transcript`)) as Response & {
      json: { data: unknown[] }
    }
    expect(response.json.data).toEqual([
      { lineSequence: 1, ...userLine },
      { lineSequence: 2, ...assistantLine },
    ])
  })

  it('serves an unreflected stored session as status open instead of failing response validation', async () => {
    engine.sessions[0] = { ...engine.sessions[0], status: 'open' } as unknown as PublicSession
    await expect(getJson('/api/v1/sessions')).resolves.toMatchObject({ status: 200 })
  })

  it('serializes concurrent proposal resolutions so only one can materialize a pending proposal', async () => {
    engine.pauseProposalResolution()
    const first = request(
      'POST',
      '/api/v1/proposals/prop_1/resolve',
      { resolution: 'accepted' },
      authenticated({ origin }),
    )
    const second = request(
      'POST',
      '/api/v1/proposals/prop_1/resolve',
      { resolution: 'accepted' },
      authenticated({ origin }),
    )

    await waitForResolveCall()
    await new Promise<void>((resolve) => setImmediate(resolve))
    engine.resumeProposalResolution()

    const responses = await Promise.all([first, second])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 404])
    expect(engine.resolveCalls).toBe(1)
    expect(engine.resolved).toEqual(['prop_1:accepted'])
  })

  it('rejects unexpected and malformed public projections before serializing them', async () => {
    engine.documents[0] = {
      ...engine.documents[0],
      filesystemPath: '/private/reverie/people/mina.md',
    } as PublicDocument
    const unexpectedDocument = await getJson('/api/v1/documents')
    expect(unexpectedDocument).toMatchObject({
      status: 500,
      json: {
        schemaVersion: '1',
        code: 'internal_error',
        message: 'The server could not process the request.',
      },
    })
    expect(JSON.stringify(unexpectedDocument.json)).not.toContain('/private/reverie')

    const { filesystemPath: _filesystemPath, ...document } = engine
      .documents[0] as PublicDocument & {
      filesystemPath: string
    }
    engine.documents[0] = { ...document, body: 42 } as unknown as PublicDocument
    await expect(getJson('/api/v1/documents/doc_one')).resolves.toMatchObject({
      status: 500,
      json: { code: 'internal_error' },
    })

    engine.sessions[0] = {
      ...engine.sessions[0],
      transcript: { ...engine.sessions[0]?.transcript, lineCount: 'two' },
    } as unknown as PublicSession
    await expect(getJson('/api/v1/sessions')).resolves.toMatchObject({
      status: 500,
      json: { code: 'internal_error' },
    })

    engine.lines[0] = {
      ...engine.lines[0],
      filesystemPath: '/private/reverie/sessions/transcript.jsonl',
    } as TranscriptLine
    await expect(getJson(`/api/v1/sessions/${sessionId}/transcript`)).resolves.toMatchObject({
      status: 500,
      json: { code: 'internal_error' },
    })

    engine.proposals[0] = { ...engine.proposals[0], kind: 'unsupported' } as never
    await expect(getJson('/api/v1/proposals')).resolves.toMatchObject({
      status: 500,
      json: { code: 'internal_error' },
    })
  })

  it('a journal document round-trips method and entryDate through GET /api/v1/documents and the single-document route', async () => {
    engine.documents.push({
      docId: 'doc_01JZZZ',
      kind: 'journal',
      title: 'doc_01JZZZ',
      updatedAt: '2026-08-16T21:04:00.000Z',
      readOnly: true,
      method: 'gratitude',
      entryDate: '2026-08-16',
      body: 'Grateful for the quiet morning.\n',
    })
    const listResponse = (await getJson('/api/v1/documents')) as Response & {
      json: { data: Array<{ docId: string; method?: string; entryDate?: string }> }
    }
    const listRow = listResponse.json.data.find((row) => row.docId === 'doc_01JZZZ')
    expect(listRow?.method).toBe('gratitude')
    expect(listRow?.entryDate).toBe('2026-08-16')

    const oneResponse = (await getJson('/api/v1/documents/doc_01JZZZ')) as Response & {
      json: { data: { method?: string; entryDate?: string } }
    }
    expect(oneResponse.json.data.method).toBe('gratitude')
    expect(oneResponse.json.data.entryDate).toBe('2026-08-16')
  })

  it('a journal document round-trips its excerpt through GET /api/v1/documents and the single-document route', async () => {
    engine.documents.push({
      docId: 'doc_01JZZZ',
      kind: 'journal',
      title: 'doc_01JZZZ',
      updatedAt: '2026-08-16T21:04:00.000Z',
      readOnly: true,
      method: 'gratitude',
      entryDate: '2026-08-16',
      excerpt: 'Grateful for the quiet morning.',
      body: 'Grateful for the quiet morning.\n',
    })
    const listResponse = (await getJson('/api/v1/documents')) as Response & {
      json: { data: Array<{ docId: string; excerpt?: string }> }
    }
    const listRow = listResponse.json.data.find((row) => row.docId === 'doc_01JZZZ')
    expect(listRow?.excerpt).toBe('Grateful for the quiet morning.')

    const oneResponse = (await getJson('/api/v1/documents/doc_01JZZZ')) as Response & {
      json: { data: { excerpt?: string } }
    }
    expect(oneResponse.json.data.excerpt).toBe('Grateful for the quiet morning.')
  })

  it('lists dreams as dreamId, date, period, hasNarrative, insightCount rows', async () => {
    const response = (await getJson('/api/v1/dreams')) as Response & {
      json: {
        data: {
          dreamId: string
          date: string
          period: string
          hasNarrative: boolean
          insightCount: number
        }[]
      }
    }
    expect(response.status).toBe(200)
    expect(response.json.data).toEqual([
      {
        dreamId: 'dream_full',
        date: '2026-08-20',
        period: '2026-08-20',
        hasNarrative: true,
        insightCount: 2,
      },
      {
        dreamId: 'dream_partial',
        date: '2026-08-21',
        period: '2026-08-21',
        hasNarrative: false,
        insightCount: 0,
      },
    ])
  })

  it('reads back a full dream with narrative, insights, and process log, dropping a malformed insight', async () => {
    const response = (await getJson('/api/v1/dreams/dream_full')) as Response & {
      json: {
        data: {
          dreamId: string
          date: string
          period: string
          narrative?: string
          insights: {
            insightId: string
            kind: string
            headline: string
            claim: string
            confidence: number
          }[]
          processLog: string
        }
      }
    }
    expect(response.status).toBe(200)
    expect(response.json.data.dreamId).toBe('dream_full')
    expect(response.json.data.narrative).toBe('A narrative about the week.')
    expect(response.json.data.processLog).toBe(
      '{"event":"dream_started"}\n{"event":"dream_finished"}\n',
    )
    // Two insights were written to insight.md; only the well-formed one
    // survives. This is the tolerance the endpoint owes a partial or
    // hand-edited insight.md, not a 500.
    expect(response.json.data.insights).toEqual([
      {
        insightId: 'ins_1',
        kind: 'pattern',
        headline: 'A recurring pattern',
        claim: 'Something happened more than once.',
        confidence: 0.7,
      },
    ])
  })

  it('reads back a partial dream (no narrative) without a 500', async () => {
    const response = (await getJson('/api/v1/dreams/dream_partial')) as Response & {
      json: { data: { narrative?: string; insights: unknown[] } }
    }
    expect(response.status).toBe(200)
    expect(response.json.data.narrative).toBeUndefined()
    expect(response.json.data.insights).toEqual([])
  })

  it('answers 404 for a dream id engine.readDream does not know', async () => {
    const response = await getJson('/api/v1/dreams/dream_missing')
    expect(response.status).toBe(404)
  })

  // The dream status route is registered ahead of the generic
  // /dreams/:dreamId route specifically so "status" is never mistaken for
  // a dream id (Defect 2, 2026-08-25 dreaming investigation: this is what
  // the web Dreams tab reads to show why the last attempt did not produce
  // a dream).
  it('reports dream status: enabled, cadence, model, period coverage, and the last failure reason', async () => {
    engine.dreamStatusValue = {
      configured: true,
      enabled: true,
      cadence: 'daily',
      triggers: { afterSession: true, onStart: true, serverTimer: true },
      model: 'gpt-5.6-luna',
      timezone: 'UTC',
      period: '2026-08-25',
      periodCovered: false,
      reflectedSessionCount: 46,
      minReflectedSessions: 5,
      reflectedFloorMet: true,
      due: true,
      lastAttempt: {
        ts: '2026-08-25T02:00:00.000Z',
        type: 'attempt',
        period: '2026-08-25',
        trigger: 'onStart',
        outcome: 'failed',
        reason: 'openai: HTTP 400: Function tools with reasoning_effort are not supported',
      },
    }

    const response = (await getJson('/api/v1/dreams/status')) as Response & {
      json: {
        data: {
          configured: boolean
          enabled: boolean
          cadence: string
          model?: string
          periodCovered: boolean
          reflectedSessionCount: number
          minReflectedSessions: number
          due: boolean
          lastAttempt?: { trigger: string; outcome: string; reason: string }
        }
      }
    }

    expect(response.status).toBe(200)
    expect(response.json.data.configured).toBe(true)
    expect(response.json.data.enabled).toBe(true)
    expect(response.json.data.model).toBe('gpt-5.6-luna')
    expect(response.json.data.periodCovered).toBe(false)
    expect(response.json.data.reflectedSessionCount).toBe(46)
    expect(response.json.data.due).toBe(true)
    expect(response.json.data.lastAttempt).toEqual({
      ts: '2026-08-25T02:00:00.000Z',
      trigger: 'onStart',
      outcome: 'failed',
      reason: 'openai: HTTP 400: Function tools with reasoning_effort are not supported',
    })
  })

  it('reports dream status with no lastAttempt field at all when there has never been one', async () => {
    engine.dreamStatusValue = {
      configured: true,
      enabled: false,
      cadence: 'daily',
      triggers: { afterSession: true, onStart: true, serverTimer: true },
      model: undefined,
      timezone: 'UTC',
      period: '2026-08-25',
      periodCovered: false,
      reflectedSessionCount: 0,
      minReflectedSessions: 5,
      reflectedFloorMet: false,
      due: false,
    }

    const response = (await getJson('/api/v1/dreams/status')) as Response & {
      json: { data: Record<string, unknown> }
    }

    expect(response.status).toBe(200)
    expect(Object.hasOwn(response.json.data, 'lastAttempt')).toBe(false)
    expect(Object.hasOwn(response.json.data, 'model')).toBe(false)
  })

  it("does not confuse the literal dream id 'status' with the status route", async () => {
    // The generic dream-detail route is method GET, path length 4; the
    // status route matches that same shape when path[3] === 'status'. A
    // real dream whose id happened to be literally "status" would be
    // unreachable through GET /dreams/:id, but that id shape (dream_<ulid>)
    // never occurs in practice, and the alternative (checking path[3] only
    // after failing to parse a dream) would make the status route's own
    // behavior depend on engine.readDream's failure mode. This test pins
    // the deliberate choice: the status route always wins the ambiguity.
    engine.dreamStatusValue = { ...engine.dreamStatusValue, enabled: true }
    const response = (await getJson('/api/v1/dreams/status')) as Response & {
      json: { data: { enabled: boolean } }
    }
    expect(response.json.data.enabled).toBe(true)
  })

  it('records feedback with source ui and echoes it back, 404 for an unknown insight', async () => {
    const ok = (await request(
      'POST',
      '/api/v1/dreams/dream_full/feedback',
      { insightId: 'ins_1', verdict: 'right', note: 'yes, that tracks' },
      authenticated({ origin }),
    )) as Response & { json: { data: { insightId: string; verdict: string } } }
    expect(ok.status).toBe(200)
    expect(ok.json.data).toEqual({ insightId: 'ins_1', verdict: 'right' })
    expect(engine.feedbackCalls).toEqual([
      { insightId: 'ins_1', verdict: 'right', note: 'yes, that tracks', source: 'ui' },
    ])

    const missing = await request(
      'POST',
      '/api/v1/dreams/dream_full/feedback',
      { insightId: 'ins_unknown', verdict: 'wrong' },
      authenticated({ origin }),
    )
    expect(missing.status).toBe(404)
  })

  it('rejects a feedback body with a bad verdict or a missing insightId before calling the engine', async () => {
    const badVerdict = await request(
      'POST',
      '/api/v1/dreams/dream_full/feedback',
      { insightId: 'ins_1', verdict: 'maybe' },
      authenticated({ origin }),
    )
    expect(badVerdict.status).toBe(400)

    const missingId = await request(
      'POST',
      '/api/v1/dreams/dream_full/feedback',
      { verdict: 'right' },
      authenticated({ origin }),
    )
    expect(missingId.status).toBe(400)
    expect(engine.feedbackCalls).toEqual([])
  })

  async function requestWithAuth(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
    auth: ReturnType<typeof createBootstrapAuth>['auth'],
  ): Promise<Response> {
    server.removeAllListeners('request')
    server.on('request', createApp({ engine, auth, canonicalOrigin: origin }))
    return request(method, path, body, headers)
  }

  async function waitForResolveCall(): Promise<void> {
    while (engine.resolveCalls === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
})

describe('dream detail merges feedback verdicts from the dream log', () => {
  // engine.readDream never carries feedback (it lives only in the
  // append-only dream log, recorded later than the insight itself), so the
  // dream detail route reads the log directly through engine.memoryPaths,
  // the same way `reverie dream --show` already does on the CLI side. This
  // exercises that merge against a real dream log file, not a stub, with
  // FakeEngine's memoryPaths pointed at the same temp directory the
  // fixture below writes into.
  let server: Server
  let memoryDir: string
  let engine: FakeEngine
  let host: string
  let cookie: string

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), 'openreverie-dream-verdict-'))
    engine = new FakeEngine(memoryPaths(memoryDir, nodeStores()))
    const config: ReverieConfig = liveConfig(memoryDir)
    server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    host = `127.0.0.1:${address.port}`
    const origin = `http://${host}`
    const { token, auth } = createBootstrapAuth({
      origin,
      now: () => 0,
      randomBytes: () => Buffer.alloc(32, 5),
    })
    server.on('request', createApp({ engine, auth, canonicalOrigin: origin, config }))
    const bootstrap = await dreamVerdictRequest(
      host,
      'POST',
      '/api/v1/auth/bootstrap',
      { token },
      {},
    )
    cookie = bootstrap.headers['set-cookie']?.[0]?.split(';', 1)[0] ?? ''
  })

  afterEach(async () => {
    server.closeAllConnections()
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
    await rm(memoryDir, { recursive: true, force: true })
  })

  it('attaches a verdict to the insight it belongs to, and no verdict to one never given feedback', async () => {
    const paths = memoryPaths(memoryDir, nodeStores())
    await mkdir(paths.dreamsDir, { recursive: true })
    await appendDreamLog(paths, [
      {
        ts: '2026-08-22T00:00:00.000Z',
        type: 'feedback',
        insight: 'ins_1',
        dream: 'dream_full',
        verdict: 'right',
        source: 'ui',
      },
    ])
    const response = await dreamVerdictRequest(
      host,
      'GET',
      '/api/v1/dreams/dream_full',
      undefined,
      {
        cookie,
      },
    )
    expect(response.status).toBe(200)
    const insights = (
      response.json as { data: { insights: { insightId: string; verdict?: string }[] } }
    ).data.insights
    expect(insights).toEqual([
      {
        insightId: 'ins_1',
        kind: 'pattern',
        headline: 'A recurring pattern',
        claim: 'Something happened more than once.',
        confidence: 0.7,
        verdict: 'right',
      },
    ])
  })

  it('omits verdict rather than failing when the dream log has nothing for that insight', async () => {
    const response = await dreamVerdictRequest(
      host,
      'GET',
      '/api/v1/dreams/dream_full',
      undefined,
      {
        cookie,
      },
    )
    expect(response.status).toBe(200)
    const insights = (
      response.json as { data: { insights: { insightId: string; verdict?: string }[] } }
    ).data.insights
    expect(insights[0]?.verdict).toBeUndefined()
  })

  it('omits verdicts rather than 500ing when the dream log itself is corrupt', async () => {
    // A crash mid-append, or a hand-edited file, can leave dreams/log.jsonl
    // holding a line that is not valid JSON. Reading dream detail must still
    // succeed for a person in that state, just without any verdicts.
    const paths = memoryPaths(memoryDir, nodeStores())
    await mkdir(paths.dreamsDir, { recursive: true })
    await writeFile(paths.dreamLog, 'not valid json\n', 'utf8')

    const response = await dreamVerdictRequest(
      host,
      'GET',
      '/api/v1/dreams/dream_full',
      undefined,
      {
        cookie,
      },
    )
    expect(response.status).toBe(200)
    const insights = (
      response.json as { data: { insights: { insightId: string; verdict?: string }[] } }
    ).data.insights
    expect(insights[0]?.verdict).toBeUndefined()
  })

  function dreamVerdictRequest(
    reqHost: string,
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<Response> {
    const text = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = nodeRequest(
        {
          hostname: '127.0.0.1',
          port: Number(reqHost.split(':')[1]),
          method,
          path,
          agent: false,
          headers: {
            host: reqHost,
            connection: 'close',
            ...(text === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }),
            ...headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => {
            const responseBody = Buffer.concat(chunks).toString('utf8')
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              json: responseBody === '' ? null : JSON.parse(responseBody),
            })
          })
        },
      )
      req.on('error', reject)
      req.end(text)
    })
  }
})

describe('live session HTTP routes', () => {
  let server: Server
  let memoryDir: string
  let engine: MemoryEngine
  let host: string
  let origin: string
  let cookie: string

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), 'openreverie-live-app-'))
    const chat = new FakeChatProvider([
      { text: '', toolCalls: [] },
      { text: 'Reply.', toolCalls: [] },
    ])
    const deps: EngineDeps = {
      chat,
      embeddings: new FakeEmbeddingProvider(),
      reflectionModel: 'fake-reflect',
      embeddingModel: 'fake-embed',
      timezone: 'UTC',
    }
    engine = await MemoryEngine.open(memoryDir, deps, { maintenance: false })
    server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    host = `127.0.0.1:${address.port}`
    origin = `http://${host}`
    const { token, auth } = createBootstrapAuth({
      origin,
      now: () => 0,
      randomBytes: () => Buffer.alloc(32, 3),
    })
    const registry = new LiveSessionRegistry({
      engine,
      config: liveConfig(memoryDir),
      chat,
      providerAvailable: true,
      maxReplayEvents: 1,
      now: () => 0,
    })
    server.on('request', createApp({ engine, auth, canonicalOrigin: origin, registry }))
    const bootstrap = await liveRequest('POST', '/api/v1/auth/bootstrap', { token }, { host })
    cookie = bootstrap.headers['set-cookie']?.[0]?.split(';', 1)[0] ?? ''
  })

  afterEach(async () => {
    server.closeAllConnections()
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
    await engine.close()
    await rm(memoryDir, { recursive: true, force: true })
  })

  it('returns 409 resync_required JSON for a missing replay sequence instead of NDJSON', async () => {
    const created = await liveRequest(
      'POST',
      '/api/v1/sessions',
      undefined,
      authenticated({ origin }),
    )
    expect(created.status).toBe(201)
    const createdJson = created.json as { data: { sessionId: string } }
    const id = createdJson.data.sessionId

    const first = await liveRequest(
      'POST',
      `/api/v1/sessions/${id}/message`,
      { message: 'again' },
      authenticated({ origin, 'x-reverie-turn-id': 'turn-1' }),
    )
    expect(first.headers['content-type']).toContain('application/x-ndjson')

    const replay = await liveRequest(
      'POST',
      `/api/v1/sessions/${id}/message`,
      { message: 'again' },
      authenticated({ origin, 'x-reverie-turn-id': 'turn-1', 'x-reverie-last-sequence': '0' }),
    )
    expect(replay).toMatchObject({
      status: 409,
      json: { schemaVersion: '1', code: 'resync_required' },
    })
    expect(replay.headers['content-type']).toContain('application/json')
  })

  it('POST .../end returns 200 with reflection: in_progress and attempts omitted, validated by publicSessionSchema at the HTTP boundary (R4)', async () => {
    const created = await liveRequest(
      'POST',
      '/api/v1/sessions',
      undefined,
      authenticated({ origin }),
    )
    const id = (created.json as { data: { sessionId: string } }).data.sessionId

    // The response body itself is proof enough that http-core.ts's
    // publicSessionSchema (a z.strictObject) accepts this shape: were
    // `attempts` required there, writePublicJson's own .parse() call
    // would throw before this request ever got a body back.
    const ended = await liveRequest(
      'POST',
      `/api/v1/sessions/${id}/end`,
      undefined,
      authenticated({ origin }),
    )
    expect(ended.status).toBe(200)
    const json = ended.json as {
      data: { status: string; reflection: Record<string, unknown> }
    }
    expect(json.data.status).toBe('ended')
    expect(json.data.reflection).toEqual({ state: 'in_progress' })
    expect('attempts' in json.data.reflection).toBe(false)
  })

  describe('session mode endpoints', () => {
    it('starts a session in a requested mode', async () => {
      const response = await liveRequest(
        'POST',
        '/api/v1/sessions',
        { mode: 'journal' },
        authenticated({ origin }),
      )
      expect(response.status).toBe(201)
      const json = response.json as { data: { mode: string } }
      expect(json.data.mode).toBe('journal')
    })

    it('starts in general when no mode is given', async () => {
      const response = await liveRequest(
        'POST',
        '/api/v1/sessions',
        undefined,
        authenticated({ origin }),
      )
      const json = response.json as { data: { mode: string } }
      expect(json.data.mode).toBe('general')
    })

    it('sets the mode on a live session', async () => {
      const created = await liveRequest(
        'POST',
        '/api/v1/sessions',
        undefined,
        authenticated({ origin }),
      )
      const sessionId = (created.json as { data: { sessionId: string } }).data.sessionId
      const response = await liveRequest(
        'POST',
        `/api/v1/sessions/${sessionId}/mode`,
        { mode: 'listen' },
        authenticated({ origin }),
      )
      expect(response.status).toBe(200)
      expect((response.json as { data: unknown }).data).toEqual({ mode: 'listen' })
    })

    it('reports the current mode on a live session so a reload recovers it', async () => {
      const created = await liveRequest(
        'POST',
        '/api/v1/sessions',
        undefined,
        authenticated({ origin }),
      )
      const sessionId = (created.json as { data: { sessionId: string } }).data.sessionId
      await liveRequest(
        'POST',
        `/api/v1/sessions/${sessionId}/mode`,
        { mode: 'listen' },
        authenticated({ origin }),
      )
      const fetched = await liveRequest(
        'GET',
        `/api/v1/sessions/${sessionId}`,
        undefined,
        authenticated(),
      )
      expect((fetched.json as { data: { mode: string } }).data.mode).toBe('listen')
    })

    it('rejects an unknown mode with 400', async () => {
      const created = await liveRequest(
        'POST',
        '/api/v1/sessions',
        undefined,
        authenticated({ origin }),
      )
      const sessionId = (created.json as { data: { sessionId: string } }).data.sessionId
      const response = await liveRequest(
        'POST',
        `/api/v1/sessions/${sessionId}/mode`,
        { mode: 'moody' },
        authenticated({ origin }),
      )
      expect(response.status).toBe(400)
    })

    it('returns 404 for a session that is not live', async () => {
      const response = await liveRequest(
        'POST',
        '/api/v1/sessions/session_nope/mode',
        { mode: 'listen' },
        authenticated({ origin }),
      )
      expect([404, 409]).toContain(response.status)
    })

    it('marks a mode set from the browser as synthetic in the transcript', async () => {
      const created = await liveRequest(
        'POST',
        '/api/v1/sessions',
        undefined,
        authenticated({ origin }),
      )
      const sessionId = (created.json as { data: { sessionId: string } }).data.sessionId
      await liveRequest(
        'POST',
        `/api/v1/sessions/${sessionId}/mode`,
        { mode: 'listen' },
        authenticated({ origin }),
      )
      const transcript = await liveRequest(
        'GET',
        `/api/v1/sessions/${sessionId}/transcript`,
        undefined,
        authenticated(),
      )
      const lines = (transcript.json as { data: { content: string; synthetic?: boolean }[] }).data
      const modeLine = lines.find((line) => line.content === '/mode listen')
      expect(modeLine?.synthetic).toBe(true)
    })
  })

  describe('session creation greet option', () => {
    it('omits initialGreetingStreamUrl and lets the first message run immediately when greet is false', async () => {
      const created = await liveRequest(
        'POST',
        '/api/v1/sessions',
        { greet: false },
        authenticated({ origin }),
      )
      expect(created.status).toBe(201)
      const createdJson = created.json as {
        data: { sessionId: string; initialGreetingStreamUrl?: string }
      }
      expect(createdJson.data.initialGreetingStreamUrl).toBeUndefined()

      const response = await liveRequest(
        'POST',
        `/api/v1/sessions/${createdJson.data.sessionId}/message`,
        { message: 'hi' },
        authenticated({ origin, 'x-reverie-turn-id': 'turn-1' }),
      )
      expect(response.status).toBe(200)
      expect(response.headers['content-type']).toContain('application/x-ndjson')
    })

    it('sets initialGreetingStreamUrl when greet is true, same as when it is omitted', async () => {
      const created = await liveRequest(
        'POST',
        '/api/v1/sessions',
        { greet: true },
        authenticated({ origin }),
      )
      expect(created.status).toBe(201)
      const createdJson = created.json as { data: { initialGreetingStreamUrl?: string } }
      expect(createdJson.data.initialGreetingStreamUrl).toBeDefined()
    })

    it('rejects a non-boolean greet field with 400', async () => {
      const response = await liveRequest(
        'POST',
        '/api/v1/sessions',
        { greet: 'no' },
        authenticated({ origin }),
      )
      expect(response.status).toBe(400)
    })
  })

  function authenticated(overrides: Record<string, string> = {}): Record<string, string> {
    return { host, cookie, ...overrides }
  }

  function liveRequest(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<{ status: number; headers: IncomingHttpHeaders; json: unknown; body: string }> {
    const text = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const request = nodeRequest(
        {
          hostname: '127.0.0.1',
          port: Number(host.split(':')[1]),
          method,
          path,
          agent: false,
          headers: {
            connection: 'close',
            ...(text === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }),
            ...headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => {
            const responseBody = Buffer.concat(chunks).toString('utf8')
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: responseBody,
              json:
                responseBody === '' ||
                !response.headers['content-type']?.includes('application/json')
                  ? null
                  : JSON.parse(responseBody),
            })
          })
        },
      )
      request.on('error', reject)
      request.end(text)
    })
  }
})

describe('profile and settings endpoints', () => {
  let server: Server
  let memoryDir: string
  let engine: MemoryEngine
  let host: string
  let origin: string
  let cookie: string
  let profilePath: string

  async function boot(apiKey = 'test'): Promise<void> {
    memoryDir = await mkdtemp(join(tmpdir(), 'openreverie-profile-app-'))
    profilePath = memoryPaths(memoryDir, nodeStores()).profile
    const deps: EngineDeps = {
      chat: new FakeChatProvider([]),
      embeddings: new FakeEmbeddingProvider(),
      reflectionModel: 'fake-reflect',
      embeddingModel: 'fake-embed',
      timezone: 'UTC',
    }
    engine = await MemoryEngine.open(memoryDir, deps, { maintenance: false })
    const config: ReverieConfig = { ...liveConfig(memoryDir), provider: { name: 'openai', apiKey } }
    server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    host = `127.0.0.1:${address.port}`
    origin = `http://${host}`
    const { token, auth } = createBootstrapAuth({
      origin,
      now: () => 0,
      randomBytes: () => Buffer.alloc(32, 9),
    })
    server.on('request', createApp({ engine, auth, canonicalOrigin: origin, config }))
    const bootstrap = await request('POST', '/api/v1/auth/bootstrap', { token }, { host })
    cookie = bootstrap.headers['set-cookie']?.[0]?.split(';', 1)[0] ?? ''
  }

  beforeEach(() => boot())

  afterEach(async () => {
    server.closeAllConnections()
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
    await engine.close()
    await rm(memoryDir, { recursive: true, force: true })
  })

  function authenticated(overrides: Record<string, string> = {}): Record<string, string> {
    return { host, cookie, ...overrides }
  }

  function request(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<{ status: number; headers: IncomingHttpHeaders; json: unknown }> {
    const text = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = nodeRequest(
        {
          hostname: '127.0.0.1',
          port: Number(host.split(':')[1]),
          method,
          path,
          agent: false,
          headers: {
            connection: 'close',
            ...(text === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }),
            ...headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => {
            const responseBody = Buffer.concat(chunks).toString('utf8')
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              json: responseBody === '' ? null : JSON.parse(responseBody),
            })
          })
        },
      )
      req.on('error', reject)
      req.end(text)
    })
  }

  describe('profile endpoints', () => {
    it('returns exactly the whitelisted shape, with nulls for unset fields', async () => {
      const response = await request('GET', '/api/v1/profile', undefined, authenticated())
      expect(response.status).toBe(200)
      const data = (response.json as { data: Record<string, unknown> }).data
      expect(Object.keys(data).sort()).toEqual(
        [
          'birthday',
          'birthdayGreetings',
          'location',
          'occupation',
          'preferredName',
          'pronouns',
          'prose',
          'style',
          'timezone',
        ].sort(),
      )
      expect(data.preferredName).toBeNull()
      expect(data.style).toEqual({ engagement: 'balanced', tone: 'warm', orientation: 'listening' })
    })

    it('does not echo a hand-added key from profile.md', async () => {
      await engine.updateProfileSettings({ preferredName: 'Vish' })
      const current = engine.profile()
      await writeProfile(memoryPaths(memoryDir, nodeStores()), {
        ...current,
        meta: { ...current.meta, favouriteTea: 'assam' },
      })
      const response = await request('GET', '/api/v1/profile', undefined, authenticated())
      const data = (response.json as { data: Record<string, unknown> }).data
      expect('favouriteTea' in data).toBe(false)
      expect(current.meta.id).toBeDefined()
    })

    it('never exposes timezoneSource', async () => {
      const response = await request('GET', '/api/v1/profile', undefined, authenticated())
      const data = (response.json as { data: Record<string, unknown> }).data
      expect('timezoneSource' in data).toBe(false)
    })

    it('writes a patch and returns the same shape', async () => {
      const response = await request(
        'PATCH',
        '/api/v1/profile',
        { preferredName: 'Vish', style: { tone: 'direct' } },
        authenticated({ origin }),
      )
      expect(response.status).toBe(200)
      const data = (
        response.json as { data: Record<string, unknown> & { style: { tone: string } } }
      ).data
      expect(data.preferredName).toBe('Vish')
      expect(data.style.tone).toBe('direct')
    })

    // The web Settings Dreams section sends { dreams: { voice } },
    // { dreams: { openerMention } }, and { dreams: { promptSection } }
    // one field at a time. Before this fix, profileSettingsPatchSchema had
    // no dreams key at all, so every one of those PATCHes came back 400.
    it('accepts a dreams patch and returns it on the next GET', async () => {
      const patchResponse = await request(
        'PATCH',
        '/api/v1/profile',
        { dreams: { voice: 'second' } },
        authenticated({ origin }),
      )
      expect(patchResponse.status).toBe(200)

      const getResponse = await request('GET', '/api/v1/profile', undefined, authenticated())
      expect(getResponse.status).toBe(200)
      const data = (getResponse.json as { data: { dreams?: { voice?: string } } }).data
      expect(data.dreams?.voice).toBe('second')
    })

    it('marks a timezone typed into settings as confirmed', async () => {
      await request(
        'PATCH',
        '/api/v1/profile',
        { timezone: 'Asia/Kolkata' },
        authenticated({ origin }),
      )
      expect(engine.profile().meta.timezoneSource).toBe('user-confirmed')
    })

    it('rejects an unknown key with 400 and writes nothing', async () => {
      const before = await readFile(profilePath, 'utf8')
      const response = await request(
        'PATCH',
        '/api/v1/profile',
        { nickname: 'V' },
        authenticated({ origin }),
      )
      expect(response.status).toBe(400)
      expect(await readFile(profilePath, 'utf8')).toEqual(before)
    })

    it('rejects infrastructure keys with 400', async () => {
      for (const body of [
        { provider: { apiKey: 'sk-leak' } },
        { safety: { mode: 'firewall' } },
        { models: { chat: 'gpt-5' } },
        { memoryDir: '/tmp/elsewhere' },
      ]) {
        const response = await request('PATCH', '/api/v1/profile', body, authenticated({ origin }))
        expect(response.status).toBe(400)
      }
    })

    it('requires write auth for PATCH /api/v1/profile', async () => {
      const response = await request(
        'PATCH',
        '/api/v1/profile',
        { preferredName: 'V' },
        authenticated(),
      )
      expect(response.status).toBe(403)
    })
  })

  describe('settings endpoint', () => {
    it('returns exactly one field', async () => {
      const response = await request('GET', '/api/v1/settings', undefined, authenticated())
      expect(response.status).toBe(200)
      expect((response.json as { data: unknown }).data).toEqual({ safetyMode: 'companion' })
    })

    it('has no write route: PATCH and POST are 404', async () => {
      expect(
        (await request('PATCH', '/api/v1/settings', {}, authenticated({ origin }))).status,
      ).toBe(404)
      expect(
        (await request('POST', '/api/v1/settings', {}, authenticated({ origin }))).status,
      ).toBe(404)
    })
  })
})

// By value, not by field name. A field-name assertion would not catch a
// nested key or an accidental spread of the config object.
describe('the API key is never reachable', () => {
  const SENTINEL = 'sk-sentinel-must-never-appear-anywhere'
  let server: Server
  let memoryDir: string
  let engine: MemoryEngine
  let host: string
  let origin: string
  let cookie: string
  let sessionId: string

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), 'openreverie-sentinel-app-'))
    const chat = new FakeChatProvider([{ text: '', toolCalls: [] }])
    const deps: EngineDeps = {
      chat,
      embeddings: new FakeEmbeddingProvider(),
      reflectionModel: 'fake-reflect',
      embeddingModel: 'fake-embed',
      timezone: 'UTC',
    }
    engine = await MemoryEngine.open(memoryDir, deps, { maintenance: false })
    sessionId = await engine.startSession(new Date('2026-08-15T09:00:00.000Z'))
    await engine.appendTranscript(sessionId, {
      ts: '2026-08-15T09:00:00.000Z',
      role: 'user',
      content: 'Hello.',
    })
    const config: ReverieConfig = {
      ...liveConfig(memoryDir),
      provider: { name: 'openai', apiKey: SENTINEL },
    }
    server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    host = `127.0.0.1:${address.port}`
    origin = `http://${host}`
    const { token, auth } = createBootstrapAuth({
      origin,
      now: () => 0,
      randomBytes: () => Buffer.alloc(32, 11),
    })
    const registry = new LiveSessionRegistry({
      engine,
      config,
      chat,
      providerAvailable: true,
      maxReplayEvents: 1,
      now: () => 0,
    })
    server.on('request', createApp({ engine, auth, canonicalOrigin: origin, registry, config }))
    const bootstrap = await request('POST', '/api/v1/auth/bootstrap', { token }, { host })
    cookie = bootstrap.headers['set-cookie']?.[0]?.split(';', 1)[0] ?? ''
  })

  afterEach(async () => {
    server.closeAllConnections()
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
    await engine.close()
    await rm(memoryDir, { recursive: true, force: true })
  })

  function authenticated(overrides: Record<string, string> = {}): Record<string, string> {
    return { host, cookie, ...overrides }
  }

  function request(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<{ status: number; headers: IncomingHttpHeaders; json: unknown }> {
    const text = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = nodeRequest(
        {
          hostname: '127.0.0.1',
          port: Number(host.split(':')[1]),
          method,
          path,
          agent: false,
          headers: {
            connection: 'close',
            ...(text === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }),
            ...headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => {
            const responseBody = Buffer.concat(chunks).toString('utf8')
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              json: responseBody === '' ? null : JSON.parse(responseBody),
            })
          })
        },
      )
      req.on('error', reject)
      req.end(text)
    })
  }

  it('appears in no response body from any endpoint', async () => {
    const calls: [string, string][] = [
      ['GET', '/api/v1/profile'],
      ['GET', '/api/v1/settings'],
      ['GET', '/api/v1/documents'],
      ['GET', '/api/v1/sessions'],
      ['GET', '/api/v1/proposals'],
      ['GET', '/api/v1/graph/snapshot'],
      ['GET', `/api/v1/sessions/${sessionId}/transcript`],
    ]
    for (const [method, path] of calls) {
      const response = await request(method, path, undefined, authenticated())
      expect(JSON.stringify(response.json), `${method} ${path}`).not.toContain(SENTINEL)
    }

    const patched = await request(
      'PATCH',
      '/api/v1/profile',
      { preferredName: 'V' },
      authenticated({ origin }),
    )
    expect(JSON.stringify(patched.json)).not.toContain(SENTINEL)

    const created = await request('POST', '/api/v1/sessions', undefined, authenticated({ origin }))
    expect(JSON.stringify(created.json)).not.toContain(SENTINEL)
    const createdSessionId = (created.json as { data: { sessionId: string } }).data.sessionId

    const moded = await request(
      'POST',
      `/api/v1/sessions/${createdSessionId}/mode`,
      { mode: 'listen' },
      authenticated({ origin }),
    )
    expect(JSON.stringify(moded.json)).not.toContain(SENTINEL)
  })
})

function liveConfig(memoryDir: string): ReverieConfig {
  return {
    memoryDir,
    provider: { name: 'openai', apiKey: 'test' },
    models: { chat: 'fake-chat', reflection: 'fake-reflect', embeddings: 'fake-embed' },
    safety: { mode: 'companion', resources: defaultCrisisResources },
    dreaming: {
      enabled: false,
      cadence: 'daily',
      triggers: { afterSession: true, onStart: true, serverTimer: true },
      maxToolCalls: 10,
    },
  }
}
