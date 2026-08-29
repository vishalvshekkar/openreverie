import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiClient,
  ApiHttpError,
  documentRowSchema,
  IncompleteStreamError,
  isTerminalEvent,
  parseStreamEvent,
  requireTerminal,
  type StreamEvent,
  sessionSchema,
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
          reflection: { state: 'not_started', attempts: 0 },
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
          reflection: { state: 'not_started', attempts: 0 },
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

  it('gets the profile', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          preferredName: 'Vish',
          pronouns: null,
          location: null,
          timezone: 'Asia/Kolkata',
          birthday: null,
          birthdayGreetings: null,
          occupation: null,
          style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
          prose: 'Some prose.',
        },
        meta: { nextCursor: null },
      }),
    )
    const client = new ApiClient()
    await expect(client.getProfile()).resolves.toMatchObject({ preferredName: 'Vish' })
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('/api/v1/profile')
    expect(init?.method).toBeUndefined()
  })

  it('updates the profile with a PATCH request', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          preferredName: 'Vish',
          pronouns: null,
          location: 'Bengaluru',
          timezone: 'Asia/Kolkata',
          birthday: null,
          birthdayGreetings: null,
          occupation: null,
          style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
          prose: 'Some prose.',
        },
        meta: { nextCursor: null },
      }),
    )
    const client = new ApiClient()
    await expect(client.updateProfile({ location: 'Bengaluru' })).resolves.toMatchObject({
      location: 'Bengaluru',
    })
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('/api/v1/profile')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(init?.body as string)).toEqual({ location: 'Bengaluru' })
  })

  it('gets settings', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { safetyMode: 'companion' }, meta: { nextCursor: null } }),
    )
    const client = new ApiClient()
    await expect(client.getSettings()).resolves.toEqual({ safetyMode: 'companion' })
    const [url] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('/api/v1/settings')
  })

  it('lists dreams', async () => {
    const row = {
      dreamId: 'dream_01A',
      date: '2026-08-20',
      period: '2026-08-20',
      hasNarrative: true,
      insightCount: 2,
    }
    fetchMock.mockResolvedValue(jsonResponse({ data: [row], meta: { nextCursor: null } }))
    const client = new ApiClient()
    await expect(client.listDreams()).resolves.toEqual([row])
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('/api/v1/dreams')
    expect(init?.method).toBeUndefined()
  })

  it('gets one dream, narrative and insights included', async () => {
    const detail = {
      dreamId: 'dream_01A',
      date: '2026-08-20',
      period: '2026-08-20',
      narrative: 'A short piece of writing.',
      insights: [
        {
          insightId: 'ins_1',
          kind: 'pattern',
          headline: 'Evenings feel heavier lately',
          claim: 'Journal entries after 8pm mention tiredness more than earlier ones.',
          confidence: 0.62,
        },
      ],
      processLog: 'seed: arc_01X\nwrote narrative\nwrote 1 insight',
    }
    fetchMock.mockResolvedValue(jsonResponse({ data: detail, meta: { nextCursor: null } }))
    const client = new ApiClient()
    await expect(client.getDream('dream_01A')).resolves.toEqual(detail)
    const [url] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('/api/v1/dreams/dream_01A')
  })

  it('sends feedback for one insight with a POST carrying the exact verdict', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { insightId: 'ins_1', verdict: 'wrong' },
        meta: { nextCursor: null },
      }),
    )
    const client = new ApiClient()
    await client.sendDreamFeedback('dream_01A', 'ins_1', 'wrong')
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('/api/v1/dreams/dream_01A/feedback')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ insightId: 'ins_1', verdict: 'wrong' })
  })

  it('includes a note in the feedback body only when one is given', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { insightId: 'ins_2', verdict: 'do_not_bring_up' },
        meta: { nextCursor: null },
      }),
    )
    const client = new ApiClient()
    await client.sendDreamFeedback('dream_01A', 'ins_2', 'do_not_bring_up', 'not relevant to me')
    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(JSON.parse(init?.body as string)).toEqual({
      insightId: 'ins_2',
      verdict: 'do_not_bring_up',
      note: 'not relevant to me',
    })
  })

  it('documentRowSchema accepts a journal row with method and entryDate', () => {
    const result = documentRowSchema.safeParse({
      docId: 'doc_01JZZZ',
      kind: 'journal',
      title: 'doc_01JZZZ',
      updatedAt: '2026-08-16T21:04:00.000Z',
      readOnly: true,
      method: 'gratitude',
      entryDate: '2026-08-16',
    })
    expect(result.success).toBe(true)
  })

  it('documentRowSchema accepts a journal row with an excerpt', () => {
    const result = documentRowSchema.safeParse({
      docId: 'doc_01JZZZ',
      kind: 'journal',
      title: 'doc_01JZZZ',
      updatedAt: '2026-08-16T21:04:00.000Z',
      readOnly: true,
      method: 'gratitude',
      entryDate: '2026-08-16',
      excerpt: 'Grateful for the quiet morning.',
    })
    expect(result.success).toBe(true)
  })

  it('documentRowSchema accepts a journaling row with neither field', () => {
    const result = documentRowSchema.safeParse({
      docId: 'doc_01JZZZ2',
      kind: 'journaling',
      title: 'doc_01JZZZ2',
      updatedAt: '2026-08-16T21:04:00.000Z',
      readOnly: true,
    })
    expect(result.success).toBe(true)
  })

  it('sessionSchema accepts status open, a stored session that exists on disk but was never reflected', () => {
    const result = sessionSchema.safeParse({
      sessionId: 'session_01JZZZ',
      createdAt: '2026-08-16T21:04:00.000Z',
      updatedAt: '2026-08-16T21:04:00.000Z',
      status: 'open',
      readOnly: true,
      transcript: { lineCount: 1, userCount: 1, assistantCount: 0, toolCount: 0 },
      reflection: { state: 'not_started', attempts: 0 },
    })
    expect(result.success).toBe(true)
  })

  it('sessionSchema accepts a reflection with attempts omitted (the registry tombstone shape)', () => {
    const result = sessionSchema.safeParse({
      sessionId: 'session_01JZZZ',
      createdAt: '2026-08-16T21:04:00.000Z',
      updatedAt: '2026-08-16T21:04:00.000Z',
      status: 'ended',
      readOnly: true,
      transcript: { lineCount: 1, userCount: 1, assistantCount: 0, toolCount: 0 },
      reflection: { state: 'in_progress' },
    })
    expect(result.success).toBe(true)
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

describe('ApiClient base URL configuration', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(jsonResponse({ data: [minaRow], meta: { nextCursor: null } }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requests a bare same-origin path when no base URL is configured, exactly as today', async () => {
    const client = new ApiClient()
    await client.listDocuments()
    const [url] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('/api/v1/documents')
  })

  it('prefixes the request with a configured base URL', async () => {
    const client = new ApiClient('https://api.reverie.example')
    await client.listDocuments()
    const [url] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('https://api.reverie.example/api/v1/documents')
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
