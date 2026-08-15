import {
  createServer,
  type IncomingHttpHeaders,
  request as nodeRequest,
  type Server,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import type {
  GraphRecord,
  PublicDocument,
  PublicDocumentRow,
  PublicGraphEdge,
  PublicGraphNode,
  PublicSession,
  SequencedGraphRecord,
  TranscriptLine,
} from '@openreverie/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type RecordEngine } from './app.js'
import { createBootstrapAuth } from './auth.js'

interface Response {
  status: number
  headers: IncomingHttpHeaders
  json: unknown
}

const sessionId = 'session_01K2XNJYABCD12345678901234'
const userLine: TranscriptLine = { ts: '2026-08-15T10:00:00.000Z', role: 'user', content: 'Hello.' }
const assistantLine: TranscriptLine = {
  ts: '2026-08-15T10:00:01.000Z',
  role: 'assistant',
  content: 'Hi.',
}

class FakeEngine implements RecordEngine {
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
    },
    {
      sessionId: 'session_01K2XNJYABCD12345678901235',
      createdAt: '2026-08-14T09:00:00.000Z',
      updatedAt: '2026-08-14T09:00:00.000Z',
      status: 'ended',
      readOnly: true,
      transcript: { lineCount: 0, userCount: 0, assistantCount: 0, toolCount: 0 },
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
