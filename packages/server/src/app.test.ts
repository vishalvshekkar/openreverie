import {
  createServer,
  type IncomingHttpHeaders,
  request as nodeRequest,
  type Server,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import type {
  PublicDocument,
  PublicDocumentRow,
  PublicSession,
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
  async listPendingProposals() {
    return this.proposals
  }
  async resolveProposal(id: string, resolution: 'accepted' | 'rejected'): Promise<void> {
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
              json: JSON.parse(Buffer.concat(chunks).toString('utf8')),
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
})
