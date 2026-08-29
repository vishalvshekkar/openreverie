import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_DEPLOYMENT_CONTEXT,
  defaultCrisisResources,
  type PersonaOptions,
  type ReverieConfig,
} from '@openreverie/core'
import {
  applyReflection,
  type EngineDeps,
  MemoryEngine,
  memoryPaths,
  nodeStores,
  type ReflectionOutput,
  SessionStore,
} from '@openreverie/memory'
import {
  type ChatEvent,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  FakeChatProvider,
  FakeEmbeddingProvider,
  ProviderUnavailableError,
} from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api.js'
import {
  DEFAULT_IDLE_SWEEP_INTERVAL_MS,
  DEFAULT_REGISTRY_LIMITS,
  DREAM_SWEEP_INTERVAL,
  LiveSessionRegistry,
  type RegistryScheduler,
  type StreamEvent,
} from './registry.js'

const THIRTY_MINUTES = 30 * 60 * 1000

let dir: string
let engine: MemoryEngine
let fakeChat: ControlledChatProvider

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openreverie-live-registry-'))
  fakeChat = new ControlledChatProvider()
  engine = await MemoryEngine.open(dir, engineDeps(fakeChat), { maintenance: false })
})

afterEach(async () => {
  await engine.close()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
})

describe('LiveSessionRegistry', () => {
  it('reconnects an overlapping same-body retry without duplicate model or transcript work', async () => {
    const registry = createRegistry()
    const session = await registry.create()
    const firstPromise = collect(
      registry.message(session.sessionId, 'turn-1', { message: 'hello' }),
    )
    await fakeChat.waitUntilStreamStarted()
    const retryPromise = collect(
      registry.message(session.sessionId, 'turn-1', { message: 'hello' }, 0),
    )
    expect(fakeChat.calls).toHaveLength(1)
    fakeChat.releaseText('hello back')
    fakeChat.finish()
    const [first, retry] = await Promise.all([firstPromise, retryPromise])
    expect(first.map((event) => event.type)).toEqual(['thinking', 'text', 'done'])
    expect(retry).toEqual(first)
    expect(fakeChat.calls).toHaveLength(1)
    expect(await engine.readTranscript(session.sessionId)).toHaveLength(2)
  })

  it('threads LiveSessionRegistryOptions.persona into every AgentSession it creates', async () => {
    const registry = createRegistry({
      persona: { deploymentContext: 'A hosted deployment claim, registry-level.' },
    })
    const session = await registry.create()
    const promise = collect(registry.message(session.sessionId, 'turn-1', { message: 'hello' }))
    await fakeChat.waitUntilStreamStarted()
    fakeChat.releaseText('hi')
    fakeChat.finish()
    await promise

    expect(fakeChat.calls[0]?.system).toContain('A hosted deployment claim, registry-level.')
    expect(fakeChat.calls[0]?.system).not.toContain(DEFAULT_DEPLOYMENT_CONTEXT)
  })

  it('omitting persona keeps the default deployment claim for every AgentSession it creates', async () => {
    const registry = createRegistry()
    const session = await registry.create()
    const promise = collect(registry.message(session.sessionId, 'turn-1', { message: 'hello' }))
    await fakeChat.waitUntilStreamStarted()
    fakeChat.releaseText('hi')
    fakeChat.finish()
    await promise

    expect(fakeChat.calls[0]?.system).toContain(DEFAULT_DEPLOYMENT_CONTEXT)
  })

  it('rejects a distinct overlapping turn while the first controlled stream is active', async () => {
    const registry = createRegistry()
    const { sessionId } = await registry.create()
    const firstPromise = collect(registry.message(sessionId, 'turn-1', { message: 'one' }))
    await fakeChat.waitUntilStreamStarted()
    await expect(
      collect(registry.message(sessionId, 'turn-2', { message: 'two' })),
    ).rejects.toMatchObject({
      status: 409,
      code: 'turn_in_progress',
    })
    expect(fakeChat.calls).toHaveLength(1)
    fakeChat.finish()
    await firstPromise
  })

  it('rejects a reused turn ID with different canonical message bytes', async () => {
    const registry = createRegistry()
    const { sessionId } = await registry.create()
    fakeChat.enqueueText('answer')
    await collect(registry.message(sessionId, 'turn-1', { message: 'one' }))
    await expect(
      collect(registry.message(sessionId, 'turn-1', { message: 'two' })),
    ).rejects.toMatchObject({
      status: 409,
      code: 'idempotency_conflict',
    })
    expect(fakeChat.calls).toHaveLength(1)
  })

  it('enforces the eighth-live-session and configured turn limits', async () => {
    const registry = createRegistry({ providerAvailable: false })
    await Promise.all(Array.from({ length: 8 }, () => registry.create()))
    await expect(registry.create()).rejects.toMatchObject({ status: 429, code: 'session_capacity' })
    expect(DEFAULT_REGISTRY_LIMITS.maxTurns).toBe(4096)

    const turnLimited = createRegistry({ providerAvailable: false, maxTurns: 2 })
    const session = await turnLimited.create()
    await collect(turnLimited.message(session.sessionId, 'turn-1', { message: 'one' }))
    await collect(turnLimited.message(session.sessionId, 'turn-2', { message: 'two' }))
    await expect(
      collect(turnLimited.message(session.sessionId, 'turn-3', { message: 'three' })),
    ).rejects.toMatchObject({ status: 409, code: 'session_turn_limit' })
  })

  it('does not rerun an event-count-evicted replay or append another transcript', async () => {
    const registry = createRegistry({ maxReplayEvents: 2, maxReplayBytes: 1024 * 1024 })
    const { sessionId } = await registry.create()
    fakeChat.enqueueText('answer')
    await collect(registry.message(sessionId, 'turn-1', { message: 'one' }))
    await expect(
      collect(registry.message(sessionId, 'turn-1', { message: 'one' }, 0)),
    ).rejects.toMatchObject({
      status: 409,
      code: 'resync_required',
    })
    expect(fakeChat.calls).toHaveLength(1)
    expect(await engine.readTranscript(sessionId)).toHaveLength(2)
  })

  it('does not rerun a byte-cap-evicted replay or append another transcript', async () => {
    const registry = createRegistry({ maxReplayEvents: 256, maxReplayBytes: 180 })
    const { sessionId } = await registry.create()
    fakeChat.enqueueText('x'.repeat(96))
    await collect(registry.message(sessionId, 'turn-1', { message: 'one' }))
    await expect(
      collect(registry.message(sessionId, 'turn-1', { message: 'one' }, 0)),
    ).rejects.toMatchObject({
      status: 409,
      code: 'resync_required',
    })
    expect(fakeChat.calls).toHaveLength(1)
    expect(await engine.readTranscript(sessionId)).toHaveLength(2)
  })

  it('retains bounded ended and expired tombstones so writes distinguish read-only sessions from unknown IDs', async () => {
    const registry = createRegistry({ providerAvailable: false })
    const ended = await registry.create()
    await registry.end(ended.sessionId)
    await expect(
      collect(registry.message(ended.sessionId, 'turn-ended', { message: 'again' })),
    ).rejects.toMatchObject({ status: 409, code: 'session_ended' })
    await expect(
      collect(registry.message('session_unknown', 'turn-unknown', { message: 'again' })),
    ).rejects.toMatchObject({ status: 404 })
    const expiring = await registry.create()
    registry.sweep(THIRTY_MINUTES + 1)
    await expect(
      collect(registry.message(expiring.sessionId, 'turn-expired', { message: 'again' })),
    ).rejects.toMatchObject({ status: 409, code: 'session_expired' })
    await new Promise<void>((resolve) => setImmediate(resolve))
  })

  it('rejects a write against a stored-but-unreflected session with session_not_live, distinct from session_ended for a reflected one', async () => {
    const registry = createRegistry({ providerAvailable: false })
    const paths = memoryPaths(dir, nodeStores())

    const unreflected = await SessionStore.start(paths, new Date('2026-08-14T12:00:00.000Z'))
    await unreflected.appendLine(paths, {
      ts: '2026-08-14T12:00:00.000Z',
      role: 'user',
      content: 'Interrupted before reflection ran, never seen by this registry.',
    })

    const reflected = await SessionStore.start(paths, new Date('2026-08-14T13:00:00.000Z'))
    await reflected.appendLine(paths, {
      ts: '2026-08-14T13:00:00.000Z',
      role: 'user',
      content: 'Reflected on directly, never seen by this registry.',
    })
    await applyReflection(
      paths,
      emptyReflectionOutput('Reflected already.'),
      reflected.sessionId,
      [],
      new Date('2026-08-14T13:00:00.000Z'),
      new Map(),
      async () => {},
      'UTC',
    )

    await expect(
      collect(registry.message(unreflected.sessionId, 'turn-unreflected', { message: 'again' })),
    ).rejects.toMatchObject({ status: 409, code: 'session_not_live' })
    await expect(
      collect(registry.message(reflected.sessionId, 'turn-reflected', { message: 'again' })),
    ).rejects.toMatchObject({ status: 409, code: 'session_ended' })

    await expect(registry.end(unreflected.sessionId)).rejects.toMatchObject({
      status: 409,
      code: 'session_not_live',
    })
    await expect(registry.end(reflected.sessionId)).rejects.toMatchObject({
      status: 409,
      code: 'session_ended',
    })
  })

  it('expires inactive sessions through its scheduler and releases capacity without a manual sweep', async () => {
    let now = 0
    const scheduler = new FakeScheduler()
    const registry = createRegistry({
      providerAvailable: false,
      now: () => now,
      scheduler,
    })
    await Promise.all(Array.from({ length: 8 }, () => registry.create()))
    await expect(registry.create()).rejects.toMatchObject({ status: 429, code: 'session_capacity' })

    now = THIRTY_MINUTES + 1
    scheduler.runAll()

    await expect(registry.create()).resolves.toMatchObject({ status: 'live', readOnly: false })
  })

  it('cancels its scheduled sweep callback when closed', async () => {
    const scheduler = new FakeScheduler()
    const registry = createRegistry({ providerAvailable: false, scheduler })
    await registry.create()

    await registry.close()

    expect(scheduler.runAll()).toBe(0)
  })

  it('schedules the dream trigger on its own thirty-minute interval, fires it a specific number of times, then fires zero more after close', async () => {
    const scheduler = new FakeScheduler()
    let calls = 0
    const dreamTrigger = async (): Promise<void> => {
      calls += 1
    }
    const registry = createRegistry({ providerAvailable: false, scheduler, dreamTrigger })

    expect(scheduler.intervals().filter((ms) => ms === DREAM_SWEEP_INTERVAL)).toHaveLength(1)

    scheduler.runAll()
    await flushMicrotasks()
    expect(calls).toBe(1)

    scheduler.runAll()
    await flushMicrotasks()
    expect(calls).toBe(2)

    await registry.close()

    expect(scheduler.runAll()).toBe(0)
    expect(calls).toBe(2)
  })

  it('schedules exactly two timers, at their documented default intervals, when idleSweep and dreamSweep are both omitted', () => {
    const scheduler = new FakeScheduler()
    createRegistry({ providerAvailable: false, scheduler })

    expect([...scheduler.intervals()].sort((a, b) => a - b)).toEqual(
      [DEFAULT_IDLE_SWEEP_INTERVAL_MS, DREAM_SWEEP_INTERVAL].sort((a, b) => a - b),
    )
  })

  it('schedules no idle timer at all when idleSweep is false, leaving the dream timer scheduled', () => {
    const scheduler = new FakeScheduler()
    createRegistry({ providerAvailable: false, scheduler, idleSweep: false })

    expect(scheduler.intervals()).toEqual([DREAM_SWEEP_INTERVAL])
  })

  it('schedules no dream timer at all when dreamSweep is false, leaving the idle timer scheduled', () => {
    const scheduler = new FakeScheduler()
    createRegistry({ providerAvailable: false, scheduler, dreamSweep: false })

    expect(scheduler.intervals()).toEqual([DEFAULT_IDLE_SWEEP_INTERVAL_MS])
  })

  it('never calls scheduler.schedule at all when both idleSweep and dreamSweep are false, not schedule-then-cancel', () => {
    const schedule = vi.fn((): (() => void) => () => {})
    createRegistry({
      providerAvailable: false,
      scheduler: { schedule },
      idleSweep: false,
      dreamSweep: false,
    })

    expect(schedule).not.toHaveBeenCalled()
  })

  it('closes cleanly when both idleSweep and dreamSweep are false and nothing was ever scheduled', async () => {
    const registry = createRegistry({
      providerAvailable: false,
      scheduler: new FakeScheduler(),
      idleSweep: false,
      dreamSweep: false,
    })

    await expect(registry.close()).resolves.toBeUndefined()
  })

  it('expires a session at a custom idleSweep.idleTimeoutMs instead of the default thirty minutes', async () => {
    let now = 0
    const customTimeout = 5 * 60 * 1000
    const registry = createRegistry({
      providerAvailable: false,
      now: () => now,
      idleSweep: { idleTimeoutMs: customTimeout },
    })
    const session = await registry.create()

    now = customTimeout - 1
    registry.sweep(now)
    expect(registry.getLiveSession(session.sessionId)).toBeDefined()

    now = customTimeout + 1
    registry.sweep(now)
    expect(registry.getLiveSession(session.sessionId)).toBeUndefined()
    await expect(
      collect(
        registry.message(session.sessionId, 'turn-after-custom-timeout', { message: 'again' }),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'session_expired' })
  })

  it('aborts a stalled greeting at a custom greetingTimeoutMs instead of the default 20 seconds', async () => {
    vi.useFakeTimers()
    try {
      const hangingChat: ChatProvider = {
        name: 'hanging',
        async complete() {
          throw new Error('not used in this test')
        },
        stream() {
          return (async function* () {
            await new Promise<never>(() => {
              // Never resolves: simulates a provider that stalls forever.
            })
          })()
        },
      }
      const registry = createRegistry({ chat: hangingChat, greetingTimeoutMs: 5_000 })
      const session = await registry.create()

      // If greetingTimeoutMs were ignored in favor of the hardcoded 20
      // second default, live.greeting would still be pending at this
      // point, and registry.end() below (which awaits live.greeting
      // before doing anything else) would hang until vitest's own test
      // timeout rather than resolve.
      await vi.advanceTimersByTimeAsync(5_001)

      const result = await registry.end(session.sessionId)
      expect(result.status).toBe('ended')
      expect(await engine.readTranscript(session.sessionId)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('contains a dream trigger that rejects or throws synchronously, without breaking the sweep beside it', async () => {
    let now = 0
    const scheduler = new FakeScheduler()
    let mode: 'reject' | 'throw' = 'reject'
    const dreamTrigger = (): Promise<void> => {
      if (mode === 'throw') throw new Error('dream failed synchronously')
      return Promise.reject(new Error('dream failed'))
    }
    const registry = createRegistry({
      providerAvailable: false,
      now: () => now,
      scheduler,
      dreamTrigger,
    })
    const session = await registry.create()

    expect(() => scheduler.runAll()).not.toThrow()
    await flushMicrotasks()

    mode = 'throw'
    expect(() => scheduler.runAll()).not.toThrow()
    await flushMicrotasks()

    // The sweep scheduled beside the failing dream trigger must still run
    // normally: expiring the session proves the timer loop is intact.
    now = THIRTY_MINUTES + 1
    scheduler.runAll()
    await expect(
      collect(registry.message(session.sessionId, 'turn-after-failure', { message: 'again' })),
    ).rejects.toMatchObject({ status: 409, code: 'session_expired' })
  })

  it('keeps only recent expired sessions in the tombstone cache', async () => {
    let now = 0
    const scheduler = new FakeScheduler()
    const registry = createRegistry({
      providerAvailable: false,
      maxLiveSessions: 65,
      now: () => now,
      scheduler,
    })
    const sessions = [] as Awaited<ReturnType<LiveSessionRegistry['create']>>[]
    for (let index = 0; index < 65; index += 1) {
      const session = await registry.create()
      sessions.push(session)
    }
    now = THIRTY_MINUTES + 1
    scheduler.runAll()

    // sessions[0] was evicted from the tombstone cache above, so this falls
    // through to the disk fallback (findStoredSession, backed by
    // engine.listStoredSessions()). Before R4, that fallback reported
    // session_not_live here, on the reasoning that a session swept for
    // inactivity had never actually been reflected yet, so status read
    // 'open'. That reasoning no longer holds: sweep() calls
    // live.agent.end() for every one of these sessions, which durably
    // records a reflection attempt (packages/memory/src/reflectionLog.ts)
    // before any model call, and R4 changed listStoredSessions() so any
    // recorded attempt already means status: 'ended', not 'open'
    // (a deliberately ended session must never look resumable). So the
    // fallback now correctly reports session_ended here too, the same
    // code a still-cached tombstone would give, and the two paths can no
    // longer be told apart by error code alone. What still distinguishes
    // real eviction from a cache hit is whether the disk fallback ran at
    // all: requireLive returns straight from a cached tombstone without
    // ever calling engine.listStoredSessions(), so a spy on that method is
    // what proves session0 truly fell through to it.
    const listSpy = vi.spyOn(engine, 'listStoredSessions')

    await expect(
      collect(registry.message(sessions[0]?.sessionId ?? '', 'turn-oldest', { message: 'again' })),
    ).rejects.toMatchObject({ status: 409, code: 'session_ended' })
    expect(listSpy).toHaveBeenCalled()
    const fallbackListing = await (listSpy.mock.results.at(-1)?.value as ReturnType<
      MemoryEngine['listStoredSessions']
    >)
    expect(fallbackListing.some((s) => s.sessionId === sessions[0]?.sessionId)).toBe(true)

    listSpy.mockClear()
    await expect(
      collect(registry.message(sessions[1]?.sessionId ?? '', 'turn-next', { message: 'again' })),
    ).rejects.toMatchObject({ status: 409, code: 'session_expired' })
    // A cache hit resolves straight from the tombstone map: it never calls
    // engine.listStoredSessions() at all, unlike session0's fallback above.
    expect(listSpy).not.toHaveBeenCalled()

    listSpy.mockClear()
    await expect(
      collect(registry.message(sessions[64]?.sessionId ?? '', 'turn-newest', { message: 'again' })),
    ).rejects.toMatchObject({ status: 409, code: 'session_expired' })
    expect(listSpy).not.toHaveBeenCalled()
  }, 15_000)

  it('returns one safe terminal chat_unavailable event when the provider is absent', async () => {
    const registry = createRegistry({ providerAvailable: false })
    const session = await registry.create()
    const events = await collect(
      registry.message(session.sessionId, 'turn-unavailable', { message: 'Are you there?' }),
    )
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'error', code: 'chat_unavailable', retryable: true }),
      ]),
    )
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1)
  })

  it('reports a runtime typed provider outage as chat_unavailable', async () => {
    const registry = createRegistry({ chat: new RuntimeUnavailableChatProvider() })
    const session = await registry.create()

    const events = await collect(
      registry.message(session.sessionId, 'turn-unavailable', { message: 'Are you there?' }),
    )

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      code: 'chat_unavailable',
      retryable: true,
    })
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1)
  })

  it('finishes a turn on the default background hook even after the consumer stops pulling events', async () => {
    const registry = createRegistry()
    const { sessionId } = await registry.create()

    // Take exactly the first event, the way a dropped HTTP connection would
    // read one chunk and then never call next() again. Nothing downstream
    // of this iterator drives the turn forward from here.
    const iterator = registry
      .message(sessionId, 'turn-1', { message: 'hello' })
      [Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value).toMatchObject({ type: 'thinking' })

    await fakeChat.waitUntilStreamStarted()
    fakeChat.releaseText('hello back')
    fakeChat.finish()

    // Nobody is reading the abandoned iterator anymore, so the only way
    // this transcript line appears is the detached runTurn itself finishing.
    let transcript = await engine.readTranscript(sessionId)
    for (let attempt = 0; attempt < 50 && transcript.length < 2; attempt += 1) {
      await flushMicrotasks()
      transcript = await engine.readTranscript(sessionId)
    }
    expect(transcript).toHaveLength(2)

    // The turn is no longer active, so a second turn can start. The
    // transcript write above lands inside AgentSession.send(), a tick
    // before runTurn's own finally block clears activeTurnId, so retry
    // past that narrow gap instead of asserting on the first attempt.
    let secondTurn: StreamEvent[] | undefined
    for (let attempt = 0; attempt < 50 && secondTurn === undefined; attempt += 1) {
      try {
        secondTurn = await collect(registry.message(sessionId, 'turn-2', { message: 'again' }))
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'turn_in_progress') throw error
        await flushMicrotasks()
      }
    }
    expect(secondTurn).toBeDefined()
  })

  it('hands turn generation and the initial greeting to a custom runBackground hook instead of a bare void', async () => {
    const received: Promise<unknown>[] = []
    const registry = createRegistry({
      runBackground: (work) => {
        received.push(work)
      },
    })
    const { sessionId } = await registry.create()
    expect(received).toHaveLength(1)
    await expect(received[0]).resolves.toBeUndefined()

    fakeChat.enqueueText('answer')
    await collect(registry.message(sessionId, 'turn-1', { message: 'one' }))
    expect(received).toHaveLength(2)
    await expect(received[1]).resolves.toBeUndefined()
  })

  it('end() resolves while reflection is still running, having handed the reflection promise to runBackground', async () => {
    const received: Promise<unknown>[] = []
    const registry = createRegistry({
      runBackground: (work) => {
        received.push(work)
      },
    })
    const { sessionId } = await registry.create()
    fakeChat.enqueueText('answer')
    await collect(registry.message(sessionId, 'turn-1', { message: 'one' }))
    // The greeting and the one turn above, both already settled.
    expect(received).toHaveLength(2)

    let resolveEndSession: (() => void) | undefined
    vi.spyOn(engine, 'endSession').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveEndSession = resolve
        }),
    )

    const result = await registry.end(sessionId)
    expect(result.status).toBe('ended')
    // end() reached runBackground with the reflection promise even though
    // engine.endSession has not resolved yet.
    expect(received).toHaveLength(3)

    let reflectionSettled = false
    received[2]?.then(() => {
      reflectionSettled = true
    })
    await flushMicrotasks()
    expect(reflectionSettled).toBe(false)

    resolveEndSession?.()
    await received[2]
    expect(reflectionSettled).toBe(true)
  })

  it('create() reports reflection not_started with zero attempts, before endSession has ever run', async () => {
    const registry = createRegistry()
    const session = await registry.create()
    expect(session.reflection).toEqual({ state: 'not_started', attempts: 0 })
  })

  it("end()'s returned and tombstoned session reports reflection in_progress with attempts omitted, since the registry cannot synchronously know the durable count once reflection has been handed off", async () => {
    const registry = createRegistry()
    const { sessionId } = await registry.create()

    const result = await registry.end(sessionId)

    expect(result.reflection).toEqual({ state: 'in_progress' })
    expect('attempts' in result.reflection).toBe(false)

    // The cached tombstone (a second end() call against a session no
    // longer live returns it verbatim) must carry the same value, not
    // just the immediate return.
    const tombstoned = await registry.end(sessionId)
    expect(tombstoned.reflection).toEqual({ state: 'in_progress' })
  })

  it("sweep()'s expired tombstone likewise reports reflection in_progress with attempts omitted", async () => {
    let now = 0
    const scheduler = new FakeScheduler()
    const registry = createRegistry({ providerAvailable: false, now: () => now, scheduler })
    const { sessionId } = await registry.create()

    now = THIRTY_MINUTES + 1
    scheduler.runAll()

    // Reading the now-expired tombstone back through end(): its early
    // branch returns the cached tombstone verbatim once a session is no
    // longer live, without touching the durable engine at all, so this is
    // stable regardless of whether the detached reflection sweep() started
    // has resolved yet.
    const tombstoned = await registry.end(sessionId)
    expect(tombstoned.status).toBe('expired')
    expect(tombstoned.reflection).toEqual({ state: 'in_progress' })
    expect('attempts' in tombstoned.reflection).toBe(false)
  })

  it('waits for an in-flight turn to finish writing before computing the transcript counts it returns', async () => {
    const registry = createRegistry()
    const { sessionId } = await registry.create()

    const iterator = registry
      .message(sessionId, 'turn-1', { message: 'hello' })
      [Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value).toMatchObject({ type: 'thinking' })

    await fakeChat.waitUntilStreamStarted()

    let settled = false
    const endPromise = registry.end(sessionId).then((result) => {
      settled = true
      return result
    })

    // The turn is still mid-stream (blocked in the controlled provider), so
    // end() must not have resolved yet: it has to wait for the send chain
    // to drain before it can even hand reflection off, let alone compute
    // the transcript counts it returns.
    await flushMicrotasks()
    expect(settled).toBe(false)

    fakeChat.releaseText('hello back')
    fakeChat.finish()

    const result = await endPromise
    expect(settled).toBe(true)
    expect(result.transcript).toEqual({
      lineCount: 2,
      userCount: 1,
      assistantCount: 1,
      toolCount: 0,
    })
  })

  it('does not reject registry.end() or produce an unhandled rejection when the detached reflection fails', async () => {
    const registry = createRegistry()
    const { sessionId } = await registry.create()
    fakeChat.enqueueText('answer')
    await collect(registry.message(sessionId, 'turn-1', { message: 'one' }))

    // A plain reassignment, not vi.spyOn: vitest's own mock tracking
    // attaches its own handler to a spy's returned promise (to record its
    // settled result in mock.results), which makes it impossible for a
    // *missing* .catch downstream to ever show up as a real unhandled
    // rejection. Only a promise nothing but production code ever touches
    // can prove that.
    engine.endSession = () => Promise.reject(new Error('reflection blew up'))

    const unhandled: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      const result = await registry.end(sessionId)
      expect(result.status).toBe('ended')
      // Give the detached, rejected reflection promise a chance to surface
      // as an unhandled rejection if nothing caught it.
      await flushMicrotasks()
      await flushMicrotasks()
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
    expect(unhandled).toEqual([])
  })

  // F1: end() hands its reflection to runBackground and immediately
  // deletes the session from `this.live`, so close()'s own await over
  // `this.live` never sees it. Before this fix nothing awaited a detached
  // reflection at all: close() would resolve while it was still running,
  // and on the bundled Node server (default runBackground is `void work`,
  // launch.ts opens the engine with { maintenance: false }) that reflection
  // was simply lost the moment the process exited.
  it('end() followed by close() does not resolve close() until the detached reflection has settled', async () => {
    const registry = createRegistry()
    const { sessionId } = await registry.create()
    fakeChat.enqueueText('answer')
    await collect(registry.message(sessionId, 'turn-1', { message: 'one' }))

    let resolveEndSession: (() => void) | undefined
    vi.spyOn(engine, 'endSession').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveEndSession = resolve
        }),
    )

    const result = await registry.end(sessionId)
    expect(result.status).toBe('ended')

    let closed = false
    const closePromise = registry.close().then(() => {
      closed = true
    })

    // The detached reflection is still pending (engine.endSession has not
    // resolved), so close() must not have resolved yet either.
    await flushMicrotasks()
    expect(closed).toBe(false)

    resolveEndSession?.()
    await closePromise
    expect(closed).toBe(true)
  })

  it('a rejected detached reflection from end() does not make close() reject or produce an unhandled rejection', async () => {
    const registry = createRegistry()
    const { sessionId } = await registry.create()
    fakeChat.enqueueText('answer')
    await collect(registry.message(sessionId, 'turn-1', { message: 'one' }))

    // Plain reassignment, not vi.spyOn: see the comment on the sibling
    // "does not reject registry.end()..." test above for why a spy's own
    // mock.results tracking would mask a missing downstream .catch here.
    engine.endSession = () => Promise.reject(new Error('reflection blew up'))

    const unhandled: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      await registry.end(sessionId)
      await expect(registry.close()).resolves.toBeUndefined()
      // Give a rejected detached reflection a chance to surface as an
      // unhandled rejection if close() awaited it without catching.
      await flushMicrotasks()
      await flushMicrotasks()
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
    expect(unhandled).toEqual([])
  })

  it('a session expired by sweep() is likewise awaited by close(), not left detached the way end() used to leave it', async () => {
    let now = 0
    const registry = createRegistry({ now: () => now })
    const { sessionId } = await registry.create()
    fakeChat.enqueueText('answer')
    await collect(registry.message(sessionId, 'turn-1', { message: 'one' }))

    let resolveEndSession: (() => void) | undefined
    vi.spyOn(engine, 'endSession').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveEndSession = resolve
        }),
    )

    now = THIRTY_MINUTES + 1
    registry.sweep(now)

    let closed = false
    const closePromise = registry.close().then(() => {
      closed = true
    })

    await flushMicrotasks()
    expect(closed).toBe(false)

    resolveEndSession?.()
    await closePromise
    expect(closed).toBe(true)
  })

  it('close() resolves immediately when there are no live sessions and no detached reflections pending', async () => {
    const registry = createRegistry()

    await expect(registry.close()).resolves.toBeUndefined()
  })

  it('records a mode event when the model switches mode mid-turn', async () => {
    const registry = createRegistry({
      chat: new FakeChatProvider([
        { text: '', toolCalls: [] }, // greeting
        { text: '', toolCalls: [{ id: 't1', name: 'set_mode', arguments: '{"mode":"listen"}' }] },
        { text: 'ok', toolCalls: [] },
      ]),
    })
    const { sessionId } = await registry.create()
    const events = await collect(registry.message(sessionId, 'turn-1', { message: 'listen to me' }))
    expect(events.some((event) => event.type === 'mode' && event.mode === 'listen')).toBe(true)
  })

  it('create({ greet: false }) makes no greeting model call, writes no transcript line, and leaves message() free to run its turn immediately', async () => {
    const chat = new FakeChatProvider([{ text: 'answer', toolCalls: [] }])
    const registry = createRegistry({ chat })

    const session = await registry.create({ greet: false })

    expect(session.initialGreetingStreamUrl).toBeUndefined()
    expect(chat.requests).toHaveLength(0)
    expect(await engine.readTranscript(session.sessionId)).toEqual([])

    // A subsequent message() must not wait on any greeting: if
    // activeTurnId were still left at '__greeting__', this would throw
    // turn_in_progress instead of running the turn below.
    const events = await collect(registry.message(session.sessionId, 'turn-1', { message: 'hi' }))
    expect(events.map((event) => event.type)).toEqual(['thinking', 'text', 'done'])
    expect(chat.requests).toHaveLength(1)
  })

  it('create({ greet: true }) still runs the greeting model call and sets initialGreetingStreamUrl, unchanged from today', async () => {
    const chat = new FakeChatProvider([{ text: 'hello there', toolCalls: [] }])
    const registry = createRegistry({ chat })

    const session = await registry.create({ greet: true })

    expect(session.initialGreetingStreamUrl).toBe(
      `/api/v1/sessions/${encodeURIComponent(session.sessionId)}/events`,
    )
    let transcript = await engine.readTranscript(session.sessionId)
    for (let attempt = 0; attempt < 50 && transcript.length < 1; attempt += 1) {
      await flushMicrotasks()
      transcript = await engine.readTranscript(session.sessionId)
    }
    expect(transcript).toHaveLength(1)
    expect(chat.requests).toHaveLength(1)
  })

  it('create() with greet omitted still runs the greeting model call and sets initialGreetingStreamUrl, unchanged from today', async () => {
    const chat = new FakeChatProvider([{ text: 'hello there', toolCalls: [] }])
    const registry = createRegistry({ chat })

    const session = await registry.create()

    expect(session.initialGreetingStreamUrl).toBe(
      `/api/v1/sessions/${encodeURIComponent(session.sessionId)}/events`,
    )
    let transcript = await engine.readTranscript(session.sessionId)
    for (let attempt = 0; attempt < 50 && transcript.length < 1; attempt += 1) {
      await flushMicrotasks()
      transcript = await engine.readTranscript(session.sessionId)
    }
    expect(transcript).toHaveLength(1)
    expect(chat.requests).toHaveLength(1)
  })

  describe('resume', () => {
    it('serves a message on a resumed session without a greeting call', async () => {
      const chat = new FakeChatProvider([{ text: 'Still here.', toolCalls: [] }])
      const registry = createRegistry({ chat })
      const sessionId = await engine.startSession(new Date('2026-08-16T20:00:00.000Z'))
      await engine.setSessionMode(sessionId, 'general')
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:00.000Z',
        utcOffsetMinutes: 0,
        role: 'user',
        content: 'Before the hibernate.',
      })
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:05.000Z',
        role: 'assistant',
        content: 'Noted.',
      })

      const resumed = await registry.resume(sessionId)
      expect(resumed.status).toBe('live')
      expect(resumed.readOnly).toBe(false)
      expect(resumed.stampsExact).toBe(true)
      expect(resumed.incompleteTurn).toBeUndefined()

      const events = await collect(
        registry.message(sessionId, 'turn-1', { message: 'Still there?' }),
      )
      expect(events.map((event) => event.type)).toEqual(['thinking', 'text', 'done'])

      // Exactly one model call, the one this message triggered: a
      // resumed session schedules no greeting (live.greeting stays
      // undefined), so FakeChatProvider, which records every stream()
      // call including an empty-message one, must show only this turn.
      expect(chat.requests).toHaveLength(1)
      expect(chat.requests[0]?.messages.length).toBeGreaterThan(0)
    })

    it('resume of a session already live returns the same view without rebuilding', async () => {
      const registry = createRegistry({ providerAvailable: false })
      const { sessionId } = await registry.create({ greet: false })
      const restoreLiveItemsSpy = vi.spyOn(engine, 'restoreLiveItems')

      const resumed = await registry.resume(sessionId)

      expect(resumed.status).toBe('live')
      expect(resumed.sessionId).toBe(sessionId)
      // AgentSession.resume is the only caller of restoreLiveItems: a spy
      // on it staying uncalled proves this path never rebuilt anything,
      // not just that it returned successfully.
      expect(restoreLiveItemsSpy).not.toHaveBeenCalled()
    })

    it('two concurrent resumes of one id produce one session', async () => {
      const registry = createRegistry({ providerAvailable: false })
      const sessionId = await engine.startSession(new Date('2026-08-16T20:00:00.000Z'))
      await engine.setSessionMode(sessionId, 'general')
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:00.000Z',
        utcOffsetMinutes: 0,
        role: 'user',
        content: 'Only ever rebuilt once.',
      })
      // restoreLiveItems is called exactly once inside AgentSession.resume,
      // so counting its calls (rather than timing two resolved promises
      // against each other) proves how many rebuilds actually ran.
      const restoreLiveItemsSpy = vi.spyOn(engine, 'restoreLiveItems')

      const [first, second] = await Promise.all([
        registry.resume(sessionId),
        registry.resume(sessionId),
      ])

      expect(restoreLiveItemsSpy).toHaveBeenCalledTimes(1)
      expect(first.sessionId).toBe(sessionId)
      expect(second.sessionId).toBe(sessionId)
      expect(registry.getLiveSession(sessionId)).toBeDefined()
    })

    it('resume of a reflected session is refused with session_ended', async () => {
      const registry = createRegistry({ providerAvailable: false })
      const paths = memoryPaths(dir, nodeStores())
      const reflected = await SessionStore.start(paths, new Date('2026-08-14T13:00:00.000Z'))
      await reflected.appendLine(paths, {
        ts: '2026-08-14T13:00:00.000Z',
        role: 'user',
        content: 'Already reflected on, never seen by this registry.',
      })
      await applyReflection(
        paths,
        emptyReflectionOutput('Reflected already.'),
        reflected.sessionId,
        [],
        new Date('2026-08-14T13:00:00.000Z'),
        new Map(),
        async () => {},
        'UTC',
      )

      await expect(registry.resume(reflected.sessionId)).rejects.toMatchObject({
        status: 409,
        code: 'session_ended',
      })
    })

    it('resume of a session this process just ended is refused with the same code requireLive gives', async () => {
      const registry = createRegistry({ providerAvailable: false })
      const { sessionId } = await registry.create({ greet: false })

      await registry.end(sessionId)

      await expect(registry.resume(sessionId)).rejects.toMatchObject({
        status: 409,
        code: 'session_ended',
      })
    })

    it('resume of a session expired by sweep() is refused with session_expired', async () => {
      let now = 0
      const registry = createRegistry({ providerAvailable: false, now: () => now })
      const { sessionId } = await registry.create({ greet: false })

      now = THIRTY_MINUTES + 1
      registry.sweep(now)

      await expect(registry.resume(sessionId)).rejects.toMatchObject({
        status: 409,
        code: 'session_expired',
      })
    })

    it('refuses to resume a just-ended session before its durable reflection record has landed, closing the race with sessionReflectionState', async () => {
      const registry = createRegistry({ providerAvailable: false })
      const { sessionId } = await registry.create({ greet: false })

      // Plain method reassignment, not vi.spyOn(...).mockRejectedValue(...):
      // a spy's own mock tracking attaches a handler to the promise it
      // returns, which can make a test like this one pass for the wrong
      // reason. A promise nothing but production code ever touches is what
      // actually proves the durable record has not landed while resume()
      // runs, the same reasoning the file's other plain-reassignment test
      // (`does not reject registry.end() ... when the detached reflection
      // fails`) already relies on.
      engine.endSession = () => new Promise<void>(() => {})

      await registry.end(sessionId)

      // Sanity: this is the race window doResume's old checks alone would
      // have walked straight through. sessionReflectionState reads
      // 'not_started' because engine.endSession above never got far enough
      // to append the durable attempt record.
      const state = await engine.sessionReflectionState(sessionId)
      expect(state.state).toBe('not_started')

      await expect(registry.resume(sessionId)).rejects.toMatchObject({
        status: 409,
        code: 'session_ended',
      })
    })

    it('resume of an unknown id is 404', async () => {
      const registry = createRegistry({ providerAvailable: false })

      await expect(registry.resume('session_unknown')).rejects.toMatchObject({
        status: 404,
        code: 'not_found',
      })
    })

    it('resume at capacity is 429', async () => {
      const registry = createRegistry({ providerAvailable: false, maxLiveSessions: 1 })
      await registry.create({ greet: false })
      const sessionId = await engine.startSession(new Date('2026-08-16T20:00:00.000Z'))
      await engine.setSessionMode(sessionId, 'general')
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:00.000Z',
        utcOffsetMinutes: 0,
        role: 'user',
        content: 'No room left to resume this one.',
      })

      await expect(registry.resume(sessionId)).rejects.toMatchObject({
        status: 429,
        code: 'session_capacity',
      })
    })

    it('never calls engine.listStoredSessions on any resume path', async () => {
      const registry = createRegistry({ providerAvailable: false })
      const paths = memoryPaths(dir, nodeStores())
      const reflected = await SessionStore.start(paths, new Date('2026-08-14T13:00:00.000Z'))
      await reflected.appendLine(paths, {
        ts: '2026-08-14T13:00:00.000Z',
        role: 'user',
        content: 'Reflected fixture for the listStoredSessions guard.',
      })
      await applyReflection(
        paths,
        emptyReflectionOutput('Reflected already.'),
        reflected.sessionId,
        [],
        new Date('2026-08-14T13:00:00.000Z'),
        new Map(),
        async () => {},
        'UTC',
      )
      const resumableId = await engine.startSession(new Date('2026-08-16T20:00:00.000Z'))
      await engine.setSessionMode(resumableId, 'general')
      await engine.appendTranscript(resumableId, {
        ts: '2026-08-16T20:00:00.000Z',
        utcOffsetMinutes: 0,
        role: 'user',
        content: 'Resume should never scan every stored session for this.',
      })

      const listSpy = vi.spyOn(engine, 'listStoredSessions')

      await expect(registry.resume('session_unknown')).rejects.toMatchObject({ status: 404 })
      await expect(registry.resume(reflected.sessionId)).rejects.toMatchObject({ status: 409 })
      await registry.resume(resumableId)

      expect(listSpy).not.toHaveBeenCalled()
    })

    it('a resumed session with a lost tail reports incompleteTurn', async () => {
      const registry = createRegistry({ providerAvailable: false })
      const sessionId = await engine.startSession(new Date('2026-08-16T20:00:00.000Z'))
      await engine.setSessionMode(sessionId, 'general')
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:00.000Z',
        utcOffsetMinutes: 0,
        role: 'user',
        content: 'What is on my plate?',
      })
      // No matching tool result line: eviction happened between announcing
      // the call and dispatching it, the same fixture shape
      // packages/core/src/agent.test.ts uses for rebuildHistory directly.
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:01.000Z',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'list_arcs', arguments: '{}' }],
      })

      const resumed = await registry.resume(sessionId)

      expect(resumed.incompleteTurn).toEqual({ fromLineSequence: 1, droppedToolCallLines: 1 })
    })
  })
})

function createRegistry(
  options: Partial<{
    providerAvailable: boolean
    chat: ChatProvider
    now: () => number
    scheduler: RegistryScheduler
    maxLiveSessions: number
    maxTurns: number
    maxReplayEvents: number
    maxReplayBytes: number
    dreamTrigger: () => Promise<unknown>
    runBackground: (work: Promise<unknown>) => void
    persona: PersonaOptions
    idleSweep: false | { idleTimeoutMs?: number; intervalMs?: number }
    dreamSweep: false | { intervalMs?: number }
    greetingTimeoutMs: number
  }> = {},
): LiveSessionRegistry {
  const { chat = fakeChat, ...registryOptions } = options
  return new LiveSessionRegistry({
    engine,
    config: testConfig(),
    chat,
    providerAvailable: true,
    now: () => 0,
    ...(registryOptions as object),
  })
}

function emptyReflectionOutput(summary: string): ReflectionOutput {
  return {
    summary,
    items: [],
    attributions: [],
    newArcs: [],
    newPersons: [],
    newEntities: [],
    pagePromotions: [],
    arcUpdates: [],
    personUpdates: [],
    constitutionUpdate: null,
    journalingUpdate: null,
  }
}

function engineDeps(chat: ChatProvider): EngineDeps {
  return {
    chat,
    embeddings: new FakeEmbeddingProvider(),
    reflectionModel: 'fake-reflect',
    embeddingModel: 'fake-embed',
    timezone: 'UTC',
  }
}

function testConfig(): ReverieConfig {
  return {
    memoryDir: dir,
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

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const values: StreamEvent[] = []
  for await (const event of events) values.push(event)
  return values
}

class ControlledChatProvider implements ChatProvider {
  readonly name = 'controlled'
  readonly calls: ChatRequest[] = []
  private readonly queuedText: string[] = []
  private startedResolve: (() => void) | undefined
  private started = new Promise<void>((resolve) => {
    this.startedResolve = resolve
  })
  private releaseTextResolve: ((text: string) => void) | undefined
  private releaseFinish: (() => void) | undefined
  private finished = false

  async complete(_request: ChatRequest): Promise<ChatResult> {
    throw new Error('chat unavailable')
  }

  stream(request: ChatRequest): AsyncIterable<ChatEvent> {
    if (request.messages.length === 0) return scriptedText('')
    this.calls.push(request)
    const queued = this.queuedText.shift()
    if (queued !== undefined) return scriptedText(queued)
    const startedResolve = this.startedResolve
    return (async function* (provider: ControlledChatProvider) {
      startedResolve?.()
      const text = await new Promise<string>((resolve) => {
        provider.releaseTextResolve = resolve
        if (provider.finished) resolve('')
      })
      if (text.length > 0) yield { type: 'text', text }
      await new Promise<void>((resolve) => {
        provider.releaseFinish = () => {
          provider.finished = true
          resolve()
        }
        if (provider.finished) resolve()
      })
      yield { type: 'done' }
    })(this)
  }

  enqueueText(text: string): void {
    this.queuedText.push(text)
  }

  async waitUntilStreamStarted(): Promise<void> {
    await this.started
  }

  releaseText(text: string): void {
    this.releaseTextResolve?.(text)
  }

  finish(): void {
    this.finished = true
    this.releaseTextResolve?.('')
    this.releaseFinish?.()
  }
}

class RuntimeUnavailableChatProvider implements ChatProvider {
  readonly name = 'runtime-unavailable'

  async complete(_request: ChatRequest): Promise<ChatResult> {
    throw new ProviderUnavailableError()
  }

  stream(_request: ChatRequest): AsyncIterable<ChatEvent> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<ChatEvent> {
        return {
          async next(): Promise<IteratorResult<ChatEvent>> {
            throw new ProviderUnavailableError()
          },
        }
      },
    }
  }
}

class FakeScheduler {
  private readonly callbacks = new Map<() => void, number>()

  schedule(callback: () => void, intervalMs: number): () => void {
    this.callbacks.set(callback, intervalMs)
    return () => this.callbacks.delete(callback)
  }

  runAll(): number {
    const callbacks = [...this.callbacks.keys()]
    for (const callback of callbacks) callback()
    return callbacks.length
  }

  intervals(): number[] {
    return [...this.callbacks.values()]
  }
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function* scriptedText(text: string): AsyncIterable<ChatEvent> {
  if (text.length > 0) yield { type: 'text', text }
  yield { type: 'done' }
}
