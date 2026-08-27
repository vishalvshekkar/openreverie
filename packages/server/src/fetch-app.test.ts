// Tests for createFetchApp, the Web-standard (Request) => Promise<Response>
// entry point added by P1-1. app.test.ts already exercises the full
// /api/v1 contract end to end through the node:http adapter (createApp);
// these tests exist to prove the OTHER entry point works, and in
// particular to prove the one property that is easy to break silently:
// writeNdjson's replacement streams incrementally through a
// ReadableStream rather than buffering every event and returning a
// completed Response. A naive accumulate-then-respond implementation would
// pass every other test in this file and in app.test.ts; only the slow
// generator test below can catch it, which is why it asserts on timing
// via a gate promise rather than on the final body.
import { createHash } from 'node:crypto'
import {
  appendDreamLog,
  type Document,
  type MemoryPaths,
  memoryPaths,
  memoryStores,
} from '@openreverie/memory'
import { describe, expect, it } from 'vitest'
import type { BootstrapAuth } from './auth.js'
import {
  createFetchApp,
  type FetchAppDeps,
  type HashProvider,
  type RecordEngine,
} from './http-core.js'
import type { LiveSessionRegistry, StreamEvent } from './registry.js'

const origin = 'http://127.0.0.1:4321'
const host = '127.0.0.1:4321'
const validCookie = 'reverie_session=valid'

const hash: HashProvider = {
  sha256: (data) => new Uint8Array(createHash('sha256').update(data).digest()),
}

const auth: BootstrapAuth = {
  exchange: () => 'issued-session',
  authenticate: (cookie) => cookie === validCookie,
}

// Every stub needs a memoryPaths now that RecordEngine.memoryPaths is
// required. Tests that do not care about dream feedback verdicts get an
// in-memory store nothing ever writes to; readDreamLog against it fails to
// find a log, and dreamFeedbackVerdicts' own catch turns that into "no
// verdicts yet". Tests that do care override it explicitly.
function defaultStubPaths(): MemoryPaths {
  return memoryPaths('/stub-memory-unused', memoryStores())
}

function stubEngine(overrides: Partial<RecordEngine> = {}): RecordEngine {
  return {
    memoryPaths: defaultStubPaths(),
    listPublicDocuments: async () => [],
    getPublicDocument: async () => null,
    listStoredSessions: async () => [],
    readTranscriptPage: async () => [],
    graphSnapshot: () => ({ nodes: [], edges: [] }),
    readGraphHistory: async () => [],
    docIdForPath: () => undefined,
    listPendingProposals: async () => [],
    resolveProposal: async () => undefined,
    profile: () => ({ meta: { id: 'p1' }, body: '' }),
    currentStyle: () => ({ engagement: 'balanced', tone: 'warm', orientation: 'balanced' }),
    updateProfileSettings: async () => ({ meta: { id: 'p1' }, body: '' }),
    listDreams: async () => [],
    readDream: async () => null,
    recordDreamFeedback: async () => false,
    dreamStatus: async () => ({
      configured: false,
      enabled: false,
      cadence: 'daily',
      triggers: { afterSession: false, onStart: false, serverTimer: false },
      model: undefined,
      timezone: 'UTC',
      period: '2026-08-27',
      periodCovered: false,
      reflectedSessionCount: 0,
      minReflectedSessions: 0,
      reflectedFloorMet: false,
      due: false,
    }),
    ...overrides,
  }
}

function buildApp(deps: Partial<FetchAppDeps> = {}): (request: Request) => Promise<Response> {
  // bootstrap defaults to on here so the rest of this file's tests, which
  // predate the opt-in gate, keep exercising the route they always did.
  // The 'bootstrap route is opt-in' describe block below overrides this
  // back to undefined to test the gate itself.
  return createFetchApp({ engine: stubEngine(), auth, origin, hash, bootstrap: auth, ...deps })
}

function authedGet(path: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request(`${origin}${path}`, {
    method: 'GET',
    headers: { host, cookie: validCookie, ...extraHeaders },
  })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('createFetchApp', () => {
  it('answers a JSON route with the same envelope shape the node adapter produces', async () => {
    const app = buildApp()
    const response = await app(authedGet('/api/v1/profile'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = (await response.json()) as { data: { preferredName: string | null } }
    expect(body.data.preferredName).toBeNull()
  })

  it('answers an unmatched route with the standard 404 error envelope', async () => {
    const app = buildApp()
    const response = await app(authedGet('/api/v1/does-not-exist'))
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body).toEqual({
      schemaVersion: '1',
      code: 'not_found',
      message: 'The requested resource was not found.',
    })
  })

  it('serves a 304 with a null body when if-none-match matches the graph snapshot etag', async () => {
    const app = buildApp()
    const first = await app(authedGet('/api/v1/graph/snapshot'))
    expect(first.status).toBe(200)
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()

    const second = await app(
      authedGet('/api/v1/graph/snapshot', { 'if-none-match': etag as string }),
    )
    expect(second.status).toBe(304)
    expect(second.headers.get('etag')).toBe(etag)
    expect(second.body).toBeNull()
  })

  it('rejects an oversized request body before the (here, endless) stream ever ends', async () => {
    // app.test.ts's own 413 test sends a big-but-finite body, so it cannot
    // tell an incremental cap from one that buffers the whole request and
    // only checks the length afterward: both return 413 for a body that
    // eventually ends. This body never ends. A reader that counts bytes as
    // they arrive and throws mid-stream stops after a handful of chunks;
    // one that reads until the stream closes first would wait for a
    // stream that never closes, and this test would time out.
    let pulls = 0
    const chunk = new Uint8Array(64 * 1024)
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(chunk)
      },
    })
    const request = new Request(`${origin}/api/v1/auth/bootstrap`, {
      method: 'POST',
      headers: { host, 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: string })

    const app = buildApp()
    const response = await app(request)
    expect(response.status).toBe(413)
    const responseBody = (await response.json()) as { code: string }
    expect(responseBody.code).toBe('request_too_large')
    // LIMITS.requestBytes is 256KB; 64KB chunks cross it on the 5th pull.
    // A generous upper bound (not an exact pull count) keeps this from
    // being a brittle assertion on buffering internals while still ruling
    // out "read until the stream closes".
    expect(pulls).toBeLessThan(20)
  })

  describe('NDJSON streaming', () => {
    function fakeRegistry(
      events: (sessionId: string, after?: number) => AsyncIterable<StreamEvent>,
    ): LiveSessionRegistry {
      // Only .events() is reached by GET /api/v1/sessions/:id/events, the
      // route these tests exercise, so a narrow duck-typed fake stands in
      // for the real class rather than constructing a full engine, chat
      // provider, and registry the way app.test.ts's live-session suite
      // does for its own, broader purposes.
      return { events } as unknown as LiveSessionRegistry
    }

    it('delivers the first NDJSON line to the consumer before a slow generator produces the second', async () => {
      const gate = deferred<void>()
      let secondEventProduced = false
      async function* slowEvents(): AsyncGenerator<StreamEvent> {
        yield { schemaVersion: '1', seq: 1, type: 'text', text: 'first' }
        await gate.promise
        secondEventProduced = true
        yield { schemaVersion: '1', seq: 2, type: 'done' }
      }

      const app = buildApp({ registry: fakeRegistry(() => slowEvents()) })
      const response = await app(authedGet('/api/v1/sessions/sess1/events'))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/x-ndjson')

      const reader = response.body?.getReader()
      if (!reader) throw new Error('expected a streamed body')
      const decoder = new TextDecoder()

      const firstRead = await reader.read()
      expect(firstRead.done).toBe(false)
      expect(decoder.decode(firstRead.value)).toContain('"seq":1')
      // The generator has not been allowed to produce its second event yet:
      // the first line above only reached the consumer because writeHead
      // resolved the Response with the stream still open, not because the
      // whole stream had already been buffered and completed.
      expect(secondEventProduced).toBe(false)

      gate.resolve()
      const secondRead = await reader.read()
      expect(decoder.decode(secondRead.value)).toContain('"seq":2')
      expect(secondEventProduced).toBe(true)
    })

    it('stops the generator when the consumer cancels the stream', async () => {
      // A hand-rolled AsyncIterable rather than an async function* here:
      // a real generator serializes concurrent calls to its own next() and
      // return(), so a return() invoked while a next() call is already
      // in flight (writeNdjson's while loop starts its next iterator.next()
      // immediately after writing the first event, before the consumer
      // ever gets to cancel anything) queues behind that in-flight step and
      // only takes effect once its own internal await happens to settle:
      // an orthogonal fact about how JS generators schedule themselves,
      // unrelated to whether the ResponseSink's own cancel wiring is
      // correct. Plugging that generator-queuing behavior directly into a
      // never-resolving gate would make this test depend on machinery this
      // task does not own. What this test needs to prove instead is
      // narrower and exactly what writeNdjson's res.once('close') handler
      // promises: cancelling the stream calls the iterator's own return().
      // A plain object's return() runs the moment it is called, so it is
      // the direct way to observe that call happening.
      let nextCalls = 0
      let returnCalled = false
      const gate = deferred<void>()
      const iterable: AsyncIterable<StreamEvent> = {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<StreamEvent>> {
              nextCalls += 1
              if (nextCalls === 1) {
                return {
                  done: false,
                  value: { schemaVersion: '1', seq: 1, type: 'text', text: 'first' },
                }
              }
              await gate.promise
              return { done: false, value: { schemaVersion: '1', seq: 2, type: 'done' } }
            },
            async return(): Promise<IteratorResult<StreamEvent>> {
              returnCalled = true
              return { done: true, value: undefined }
            },
          }
        },
      }

      const app = buildApp({ registry: fakeRegistry(() => iterable) })
      const response = await app(authedGet('/api/v1/sessions/sess1/events'))
      const reader = response.body?.getReader()
      if (!reader) throw new Error('expected a streamed body')
      await reader.read()
      expect(returnCalled).toBe(false)

      await reader.cancel('client disconnected')
      expect(returnCalled).toBe(true)
      gate.resolve()
    })
  })
})

describe('bootstrap route is opt-in', () => {
  // Undefined here is not the same as "the route is mounted but fails":
  // these tests prove it is genuinely absent, by comparing its behavior
  // directly against a path that has never existed
  // (/api/v1/no-such-route), in both auth states, rather than trusting a
  // bare status code.
  function bootstrapRequest(extraHeaders: Record<string, string> = {}): Request {
    return new Request(`${origin}/api/v1/auth/bootstrap`, {
      method: 'POST',
      headers: { host, 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify({ token: 'whatever' }),
    })
  }

  function noSuchRouteRequest(extraHeaders: Record<string, string> = {}): Request {
    return new Request(`${origin}/api/v1/no-such-route`, {
      method: 'POST',
      headers: { host, 'content-type': 'application/json', ...extraHeaders },
      body: '{}',
    })
  }

  it('mounts the route and issues a cookie exactly as before when a bootstrap dep is supplied', async () => {
    const app = createFetchApp({ engine: stubEngine(), auth, origin, hash, bootstrap: auth })
    const response = await app(bootstrapRequest())
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('reverie_session=issued-session')
    const body = (await response.json()) as { data: { authenticated: boolean } }
    expect(body.data.authenticated).toBe(true)
  })

  it('without a bootstrap dep, an unauthenticated caller gets the same 401 as any other unauthenticated write, not a route-specific error', async () => {
    const app = createFetchApp({ engine: stubEngine(), auth, origin, hash })
    const response = await app(bootstrapRequest())
    const control = await app(noSuchRouteRequest())
    expect(response.status).toBe(401)
    expect(response.status).toBe(control.status)
    expect(await response.json()).toEqual(await control.json())
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('without a bootstrap dep, an authenticated caller gets the same 404 a genuinely unknown route gets, not an auth error that happens to look similar', async () => {
    const app = createFetchApp({ engine: stubEngine(), auth, origin, hash })
    const authedHeaders = { cookie: validCookie, origin }
    const response = await app(bootstrapRequest(authedHeaders))
    const control = await app(noSuchRouteRequest(authedHeaders))
    expect(response.status).toBe(404)
    expect(response.status).toBe(control.status)
    expect(await response.json()).toEqual(await control.json())
    expect(response.headers.get('set-cookie')).toBeNull()
  })
})

describe("dream feedback verdicts are read through the engine's own memory paths", () => {
  // http-core.ts used to build its own MemoryPaths here via
  // memoryPaths(config.memoryDir, nodeStores()), no matter what store the
  // host actually gave its engine. Now dreamFeedbackVerdicts reads through
  // engine.memoryPaths, so there is no separate dep left to inject: the
  // paths always come from whatever store the engine itself carries. This
  // engine fixture never carries feedback through readDream (see
  // http-core.ts's own comment on why); the point of these two tests is
  // that the verdict comes from the engine's own memoryPaths, in-memory
  // here, not a real filesystem this test never touches, and that two
  // engines with different stores never bleed into each other.
  function dreamEngine(paths: MemoryPaths): RecordEngine {
    return stubEngine({
      memoryPaths: paths,
      readDream: async (dreamId) =>
        dreamId === 'dream_full'
          ? {
              summary: {
                dreamId: 'dream_full',
                date: '2026-08-20',
                period: '2026-08-20',
                hasNarrative: false,
                insightCount: 1,
                dir: '/fake/dreams/dream_full',
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
                    },
                  ],
                },
                body: '',
              } as Document,
              processLog: '',
            }
          : null,
    })
  }

  it('surfaces a verdict recorded through the engine-supplied stores, with no real filesystem involved', async () => {
    const paths = memoryPaths('/virtual-memory', memoryStores())
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

    const app = createFetchApp({ engine: dreamEngine(paths), auth, origin, hash })
    const response = await app(authedGet('/api/v1/dreams/dream_full'))
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: { insights: { insightId: string; verdict?: string }[] }
    }
    expect(body.data.insights).toEqual([
      expect.objectContaining({ insightId: 'ins_1', verdict: 'right' }),
    ])
  })

  it('reads verdicts from whichever store the calling engine carries, never a shared or ambient one', async () => {
    // FetchAppDeps has no memoryPaths field to inject any more (removed
    // with the dep this describe block is named for), so the only way
    // this response's verdict could come from anywhere other than
    // dreamEngine's own paths is a bug that reaches past deps.engine
    // entirely, for example a module-level default or a stray
    // memoryPaths(root, nodeStores()) construction like the one this
    // change removed. Two engines, two distinct in-memory stores, one
    // with the feedback recorded and one without, prove there is no such
    // leak: each app's response reflects only the store its own engine
    // was built over.
    const pathsWithVerdict = memoryPaths('/virtual-memory-a', memoryStores())
    await appendDreamLog(pathsWithVerdict, [
      {
        ts: '2026-08-22T00:00:00.000Z',
        type: 'feedback',
        insight: 'ins_1',
        dream: 'dream_full',
        verdict: 'right',
        source: 'ui',
      },
    ])
    const pathsWithoutVerdict = memoryPaths('/virtual-memory-b', memoryStores())

    const appWithVerdict = createFetchApp({
      engine: dreamEngine(pathsWithVerdict),
      auth,
      origin,
      hash,
    })
    const appWithoutVerdict = createFetchApp({
      engine: dreamEngine(pathsWithoutVerdict),
      auth,
      origin,
      hash,
    })

    const withVerdict = await appWithVerdict(authedGet('/api/v1/dreams/dream_full'))
    const withoutVerdict = await appWithoutVerdict(authedGet('/api/v1/dreams/dream_full'))
    const bodyWithVerdict = (await withVerdict.json()) as {
      data: { insights: { insightId: string; verdict?: string }[] }
    }
    const bodyWithoutVerdict = (await withoutVerdict.json()) as {
      data: { insights: { insightId: string; verdict?: string }[] }
    }
    expect(bodyWithVerdict.data.insights[0]?.verdict).toBe('right')
    expect(bodyWithoutVerdict.data.insights[0]?.verdict).toBeUndefined()
  })
})
