import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiClient,
  ApiHttpError,
  IncompleteStreamError,
  isTerminalEvent,
  parseStreamEvent,
  requireTerminal,
  type StreamEvent,
  transcriptLineSchema,
} from './api.js'

const thinking = (seq: number): StreamEvent => ({ schemaVersion: '1', seq, type: 'thinking' })
const text = (seq: number, value: string): StreamEvent => ({
  schemaVersion: '1',
  seq,
  type: 'text',
  text: value,
})
const mode = (seq: number, value: string): StreamEvent => ({
  schemaVersion: '1',
  seq,
  type: 'mode',
  mode: value,
})
const done = (seq: number): StreamEvent => ({ schemaVersion: '1', seq, type: 'done' })
const error = (seq: number): StreamEvent => ({
  schemaVersion: '1',
  seq,
  type: 'error',
  code: 'chat_unavailable',
  retryable: true,
  message: 'unavailable',
})

const minaRow = {
  docId: 'doc-mina',
  kind: 'person',
  title: 'Mina',
  updatedAt: '2026-08-15T12:00:00.000Z',
  readOnly: true,
}

function jsonResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response
}

function ndjsonResponse(textBody: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(textBody))
      controller.close()
    },
  })
  return { ok: true, status: 200, body } as unknown as Response
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

function stream(...events: StreamEvent[]): AsyncIterable<StreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event
    },
  }
}

describe('ApiClient request and NDJSON parsing', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('bootstraps with a credentialed POST and returns the parsed data', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { authenticated: true }, meta: { nextCursor: null } }),
    )
    const client = new ApiClient()
    await expect(client.bootstrap('launch-token')).resolves.toEqual({ authenticated: true })
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('/api/v1/auth/bootstrap')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
    expect(JSON.parse(init.body as string)).toEqual({ token: 'launch-token' })
  })

  it('creates a session with a requested mode', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          sessionId: 'session-1',
          createdAt: '2026-08-17T10:00:00.000Z',
          updatedAt: '2026-08-17T10:00:00.000Z',
          status: 'live',
          readOnly: false,
          mode: 'journal',
          transcript: { lineCount: 0, userCount: 0, assistantCount: 0, toolCount: 0 },
        },
        meta: { nextCursor: null },
      }),
    )
    const client = new ApiClient()
    await expect(client.createSession('journal')).resolves.toMatchObject({ mode: 'journal' })
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('/api/v1/sessions')
    expect(JSON.parse(init.body as string)).toEqual({ mode: 'journal' })
  })

  it('creates a session with an empty body when no mode is given', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          sessionId: 'session-1',
          createdAt: '2026-08-17T10:00:00.000Z',
          updatedAt: '2026-08-17T10:00:00.000Z',
          status: 'live',
          readOnly: false,
          transcript: { lineCount: 0, userCount: 0, assistantCount: 0, toolCount: 0 },
        },
        meta: { nextCursor: null },
      }),
    )
    const client = new ApiClient()
    await client.createSession()
    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(JSON.parse(init.body as string)).toEqual({})
  })

  it('sets the mode on a live session', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { mode: 'listen' }, meta: { nextCursor: null } }),
    )
    const client = new ApiClient()
    await expect(client.setSessionMode('session-1', 'listen')).resolves.toEqual({ mode: 'listen' })
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('/api/v1/sessions/session-1/mode')
    expect(JSON.parse(init.body as string)).toEqual({ mode: 'listen' })
  })

  it('parses the list envelope and returns data with its cursor', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [minaRow], meta: { nextCursor: 'cursor-1' } }))
    const client = new ApiClient()
    await expect(client.listDocuments()).resolves.toEqual({
      data: [minaRow],
      nextCursor: 'cursor-1',
    })
  })

  it('turns a non-ok response into an ApiHttpError with its code and message', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        schemaVersion: '1',
        code: 'resync_required',
        message: 'Resync required.',
      }),
    } as unknown as Response)
    const client = new ApiClient()
    await expect(client.listDocuments()).rejects.toMatchObject({
      status: 409,
      code: 'resync_required',
    })
  })

  it('sends the turn id and last sequence headers on a message', async () => {
    fetchMock.mockResolvedValue(ndjsonResponse(`${JSON.stringify(done(1))}\n`))
    const client = new ApiClient()
    const events = await client.message('session-1', 'turn-1', 'Hi', 2)
    await collect(events)
    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(init.method).toBe('POST')
    expect(init.headers['X-Reverie-Turn-Id']).toBe('turn-1')
    expect(init.headers['X-Reverie-Last-Sequence']).toBe('2')
    expect(JSON.parse(init.body as string)).toEqual({ message: 'Hi' })
  })

  it('parses NDJSON stream events in order', async () => {
    fetchMock.mockResolvedValue(
      ndjsonResponse(
        `${JSON.stringify(thinking(1))}\n${JSON.stringify(text(2, 'Hello'))}\n${JSON.stringify(done(3))}\n`,
      ),
    )
    const client = new ApiClient()
    const events = await client.message('session-1', 'turn-1', 'Hi')
    const collected = await collect(events)
    expect(collected).toHaveLength(3)
    expect(collected[2]).toMatchObject({ type: 'done', seq: 3 })
  })

  it('parses a mode stream event', () => {
    expect(parseStreamEvent(JSON.stringify(mode(1, 'listen')))).toEqual(mode(1, 'listen'))
  })

  it('rejects a stream event that does not match the schema', () => {
    expect(() => parseStreamEvent('{"schemaVersion":"1","seq":1,"type":"nonsense"}')).toThrow(
      ApiHttpError,
    )
  })

  it('rejects a stream that ends without a terminal event', async () => {
    const events = requireTerminal(stream(thinking(1), text(2, 'Hi')))
    await expect(collect(events)).rejects.toBeInstanceOf(IncompleteStreamError)
  })

  it('accepts a stream that ends with a terminal event', async () => {
    const events = requireTerminal(stream(thinking(1), text(2, 'Hi'), done(3)))
    await expect(collect(events)).resolves.toHaveLength(3)
  })

  it('identifies terminal events', () => {
    expect(isTerminalEvent(done(3))).toBe(true)
    expect(isTerminalEvent(error(3))).toBe(true)
    expect(isTerminalEvent(text(2, 'Hi'))).toBe(false)
  })

  it('loads the graph snapshot', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { revision: 'a'.repeat(64), nodes: [], edges: [] },
        meta: { nextCursor: null },
      }),
    )
    const client = new ApiClient()
    await expect(client.getGraphSnapshot()).resolves.toEqual({
      revision: 'a'.repeat(64),
      nodes: [],
      edges: [],
    })
  })
})

describe('transcriptLineSchema synthetic', () => {
  it('accepts a synthetic line and a line without the key', () => {
    const base = { lineSequence: 1, ts: '2026-08-17T10:00:00.000Z', role: 'user', content: 'hi' }
    expect(transcriptLineSchema.safeParse(base).success).toBe(true)
    expect(transcriptLineSchema.safeParse({ ...base, synthetic: true }).success).toBe(true)
  })

  it('still rejects synthetic: false, which the field never carries', () => {
    const base = { lineSequence: 1, ts: '2026-08-17T10:00:00.000Z', role: 'user', content: 'hi' }
    expect(transcriptLineSchema.safeParse({ ...base, synthetic: false }).success).toBe(false)
  })
})
