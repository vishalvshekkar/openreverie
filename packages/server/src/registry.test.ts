import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultCrisisResources, type ReverieConfig } from '@openreverie/core'
import { type EngineDeps, MemoryEngine } from '@openreverie/memory'
import {
  type ChatEvent,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  FakeChatProvider,
  FakeEmbeddingProvider,
  ProviderUnavailableError,
} from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_REGISTRY_LIMITS,
  DREAM_SWEEP_INTERVAL,
  LiveSessionRegistry,
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

    await expect(
      collect(registry.message(sessions[0]?.sessionId ?? '', 'turn-oldest', { message: 'again' })),
    ).rejects.toMatchObject({ status: 409, code: 'session_ended' })
    await expect(
      collect(registry.message(sessions[1]?.sessionId ?? '', 'turn-next', { message: 'again' })),
    ).rejects.toMatchObject({ status: 409, code: 'session_expired' })
    await expect(
      collect(registry.message(sessions[64]?.sessionId ?? '', 'turn-newest', { message: 'again' })),
    ).rejects.toMatchObject({ status: 409, code: 'session_expired' })
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
})

function createRegistry(
  options: Partial<{
    providerAvailable: boolean
    chat: ChatProvider
    now: () => number
    scheduler: FakeScheduler
    maxLiveSessions: number
    maxTurns: number
    maxReplayEvents: number
    maxReplayBytes: number
    dreamTrigger: () => Promise<unknown>
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

function engineDeps(chat: ChatProvider): EngineDeps {
  return {
    chat,
    embeddings: new FakeEmbeddingProvider(),
    reflectionModel: 'fake-reflect',
    embeddingModel: 'fake-embed',
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
