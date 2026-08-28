import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  type AgentEvent,
  AgentSession,
  isModeName,
  type PersonaOptions,
  type ReverieConfig,
} from '@openreverie/core'
import type { MemoryEngine, PublicSession, PublicTranscriptLine } from '@openreverie/memory'
import { type ChatProvider, ProviderUnavailableError } from '@openreverie/providers'
import { ApiError } from './api.js'

const MAX_NDJSON_EVENT_BYTES = 256 * 1024
const ENDED_TOMBSTONE_CAP = 64
const THIRTY_MINUTES = 30 * 60 * 1000
const SWEEP_INTERVAL = 60 * 1000
export const DREAM_SWEEP_INTERVAL = 30 * 60 * 1000

export const DEFAULT_REGISTRY_LIMITS = {
  maxLiveSessions: 8,
  maxTurns: 4096,
  maxReplayEvents: 256,
  maxReplayBytes: 1024 * 1024,
} as const

export type StreamEvent =
  | { schemaVersion: '1'; seq: number; type: 'thinking' }
  | { schemaVersion: '1'; seq: number; type: 'text'; text: string }
  | { schemaVersion: '1'; seq: number; type: 'tool'; name: string }
  | { schemaVersion: '1'; seq: number; type: 'mode'; mode: string }
  | { schemaVersion: '1'; seq: number; type: 'done' }
  | {
      schemaVersion: '1'
      seq: number
      type: 'error'
      code: 'chat_unavailable' | 'chat_failed'
      retryable: boolean
      message: string
    }

type StreamEventInput =
  | { type: 'thinking' }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'mode'; mode: string }
  | { type: 'done' }
  | {
      type: 'error'
      code: 'chat_unavailable' | 'chat_failed'
      retryable: boolean
      message: string
    }

export interface CreateSessionResponse extends PublicSession {
  initialGreetingStreamUrl?: string
}

export interface LiveSessionRegistryOptions {
  engine: MemoryEngine
  config: ReverieConfig
  chat: ChatProvider
  providerAvailable: boolean
  now?: () => number
  maxLiveSessions?: number
  maxTurns?: number
  maxReplayEvents?: number
  maxReplayBytes?: number
  scheduler?: RegistryScheduler
  dreamTrigger?: () => Promise<unknown>
  // Host-supplyable prompt blocks, passed unchanged to every AgentSession
  // this registry creates. This is the injection point a Cloudflare
  // Durable Object host actually uses: it builds the registry directly and
  // never calls packages/server/src/launch.ts. Defaults to {}, which is
  // AgentSessionOptions.persona's own default and changes nothing for a
  // caller that omits this.
  persona?: PersonaOptions
  // A fire-and-forget promise handed to Node's event loop keeps running on
  // its own. On Cloudflare Workers it does not: once the request that
  // started it returns a response, the isolate can be torn down and the
  // promise cancelled mid-flight, which would cut off a turn or greeting
  // for someone whose connection drops. This hook is where a host extends
  // that promise's lifetime past the request. Cloudflare passes
  // ctx.waitUntil. The default below keeps today's Node behavior exactly:
  // fire and forget, with no added catch, so a rejection still surfaces
  // as an unhandled rejection rather than being silently swallowed.
  runBackground?: (work: Promise<unknown>) => void
}

export interface RegistryScheduler {
  schedule(callback: () => void, intervalMs: number): () => void
}

interface ReplayRecord {
  event: StreamEvent
  bytes: number
}

interface TurnRecord {
  hash: string
  state: 'active' | 'terminal'
  startSeq: number
  endSeq?: number
}

interface LiveSession {
  agent: AgentSession
  public: PublicSession
  turns: Map<string, TurnRecord>
  replay: ReplayRecord[]
  replayBytes: number
  sequence: number
  activeTurnId: string | undefined
  lastActivity: number
  greeting: Promise<void> | undefined
  waiters: Set<() => void>
}

interface Tombstone {
  sessionId: string
  public: PublicSession
}

export class LiveSessionRegistry {
  private readonly engine: MemoryEngine
  private readonly config: ReverieConfig
  private readonly chat: ChatProvider
  private readonly providerAvailable: boolean
  private readonly now: () => number
  private readonly maxLiveSessions: number
  private readonly maxTurns: number
  private readonly maxReplayEvents: number
  private readonly maxReplayBytes: number
  private readonly cancelSweep: () => void
  private readonly cancelDreamTrigger: () => void
  private readonly dreamTrigger: (() => Promise<unknown>) | undefined
  private readonly persona: PersonaOptions
  private readonly runBackground: (work: Promise<unknown>) => void
  private readonly live = new Map<string, LiveSession>()
  private readonly tombstones = new Map<string, Tombstone>()
  private closed = false
  private closePromise: Promise<void> | undefined

  constructor(options: LiveSessionRegistryOptions) {
    this.engine = options.engine
    this.config = options.config
    this.chat = options.chat
    this.providerAvailable = options.providerAvailable
    this.now = options.now ?? Date.now
    this.maxLiveSessions = options.maxLiveSessions ?? DEFAULT_REGISTRY_LIMITS.maxLiveSessions
    this.maxTurns = options.maxTurns ?? DEFAULT_REGISTRY_LIMITS.maxTurns
    this.maxReplayEvents = options.maxReplayEvents ?? DEFAULT_REGISTRY_LIMITS.maxReplayEvents
    this.maxReplayBytes = options.maxReplayBytes ?? DEFAULT_REGISTRY_LIMITS.maxReplayBytes
    this.dreamTrigger = options.dreamTrigger
    this.persona = options.persona ?? {}
    // Same posture as `void work` would give: nothing is attached to
    // `work`, so a rejection surfaces as an unhandled rejection exactly as
    // it did before this hook existed. Only a host that actually needs to
    // extend the promise's lifetime (Workers' ctx.waitUntil) overrides this.
    this.runBackground = options.runBackground ?? ((work) => void work)
    const scheduler = options.scheduler ?? nodeIntervalScheduler
    this.cancelSweep = scheduler.schedule(() => {
      if (!this.closed) this.sweep()
    }, SWEEP_INTERVAL)
    this.cancelDreamTrigger = scheduler.schedule(() => {
      if (!this.closed) this.runDreamTrigger()
    }, DREAM_SWEEP_INTERVAL)
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.cancelSweep()
    this.cancelDreamTrigger()
    const sessions = [...this.live.values()]
    this.live.clear()
    for (const live of sessions) this.notify(live)
    this.closePromise = Promise.all(
      sessions.map(async (live) => {
        await live.greeting
        await live.agent.end()
      }),
    ).then(() => undefined)
    return this.closePromise
  }

  async create(options: { mode?: string } = {}): Promise<CreateSessionResponse> {
    if (this.live.size >= this.maxLiveSessions) {
      throw new ApiError(429, 'session_capacity', 'Too many live sessions are open.')
    }
    const requested = options.mode
    if (requested !== undefined && !isModeName(requested)) {
      throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    }
    const agent = await AgentSession.start(this.engine, this.config, this.chat, {
      ...(requested === undefined ? {} : { mode: requested }),
      persona: this.persona,
    })
    const stored = (await this.engine.listStoredSessions()).find(
      (session) => session.sessionId === agent.sessionId,
    )
    const createdAt = stored?.createdAt ?? new Date(this.now()).toISOString()
    const live: LiveSession = {
      agent,
      public: {
        sessionId: agent.sessionId,
        createdAt,
        updatedAt: stored?.updatedAt ?? createdAt,
        status: 'live',
        readOnly: false,
        mode: agent.mode,
        transcript: stored?.transcript ?? emptyTranscript(),
      },
      turns: new Map(),
      replay: [],
      replayBytes: 0,
      sequence: 0,
      activeTurnId: undefined,
      lastActivity: this.now(),
      greeting: undefined,
      waiters: new Set(),
    }
    this.live.set(agent.sessionId, live)

    if (!this.providerAvailable) return { ...live.public }

    live.activeTurnId = '__greeting__'
    live.greeting = this.recordGreeting(live).finally(() => {
      live.activeTurnId = undefined
      live.lastActivity = this.now()
      this.notify(live)
    })
    // create() returns below before the greeting finishes streaming, the
    // same detached shape as runTurn: routed through runBackground so a
    // host can keep it alive past this request.
    this.runBackground(live.greeting)
    return {
      ...live.public,
      initialGreetingStreamUrl: `/api/v1/sessions/${encodeURIComponent(agent.sessionId)}/events`,
    }
  }

  async *message(
    sessionId: string,
    turnId: string,
    body: { message: string },
    after?: number,
  ): AsyncIterable<StreamEvent> {
    const live = await this.requireLive(sessionId)
    if (live.activeTurnId === '__greeting__') await live.greeting

    const hash = createHash('sha256')
      .update(Buffer.from(JSON.stringify({ message: body.message }), 'utf8'))
      .digest('hex')
    const prior = live.turns.get(turnId)
    if (prior) {
      if (prior.hash !== hash) {
        throw new ApiError(
          409,
          'idempotency_conflict',
          'This turn conflicts with an earlier request.',
        )
      }
      yield* this.replayOrSubscribe(live, prior, after)
      return
    }
    if ((live.activeTurnId && live.activeTurnId !== turnId) || live.turns.size >= this.maxTurns) {
      throw new ApiError(
        409,
        live.activeTurnId ? 'turn_in_progress' : 'session_turn_limit',
        live.activeTurnId ? 'A turn is already in progress.' : 'Start a new session to continue.',
      )
    }

    const turn: TurnRecord = {
      hash,
      state: 'active',
      startSeq: live.sequence + 1,
    }
    live.turns.set(turnId, turn)
    live.activeTurnId = turnId
    // Detached on purpose: the caller below only subscribes to replay, it
    // does not drive completion. Handed to runBackground rather than a
    // bare `void` so a host can keep the turn running past this request:
    // on Cloudflare Workers a bare `void` promise is cancelled once the
    // response is sent, which would cut a person off mid-turn if their
    // connection drops.
    this.runBackground(this.runTurn(live, turnId, turn, body.message))
    yield* this.replayOrSubscribe(live, turn, after ?? turn.startSeq - 1)
  }

  async *events(sessionId: string, after?: number): AsyncIterable<StreamEvent> {
    const live = await this.requireLive(sessionId)
    let cursor = after
    this.assertGlobalReplayAvailable(live, cursor)
    while (true) {
      for (const record of live.replay) {
        if (cursor === undefined || record.event.seq > cursor) {
          yield record.event
          cursor = record.event.seq
        }
      }
      if (!live.activeTurnId) return
      await this.waitForEvent(live)
      this.assertGlobalReplayAvailable(live, cursor)
    }
  }

  async end(sessionId: string): Promise<PublicSession> {
    const live = this.live.get(sessionId)
    if (!live) {
      const tombstone = this.tombstones.get(sessionId)
      if (tombstone) return { ...tombstone.public }
      if (await this.isStoredSession(sessionId)) {
        throw new ApiError(409, 'session_ended', 'This session is read-only.')
      }
      throw new ApiError(404, 'not_found', 'The requested resource was not found.')
    }
    await live.greeting
    await live.agent.end()
    await this.syncPublic(live)
    this.live.delete(sessionId)
    const publicSession = { ...live.public, status: 'ended' as const, readOnly: true }
    this.addTombstone({ sessionId, public: publicSession })
    return { ...publicSession }
  }

  async setMode(sessionId: string, mode: string): Promise<{ mode: string }> {
    if (!isModeName(mode)) {
      throw new ApiError(400, 'invalid_request', 'The request is invalid.')
    }
    const live = await this.requireLive(sessionId)
    // source 'web': a click, with no keystroke behind it, so the /mode line
    // this writes is marked synthetic.
    await live.agent.setMode(mode, { source: 'web' })
    live.public = { ...live.public, mode }
    live.lastActivity = this.now()
    return { mode }
  }

  sweep(now = this.now()): void {
    if (this.closed) return
    for (const [sessionId, live] of this.live) {
      if (live.activeTurnId || now - live.lastActivity < THIRTY_MINUTES) continue
      this.live.delete(sessionId)
      const publicSession = { ...live.public, status: 'expired' as const, readOnly: true }
      this.addTombstone({ sessionId, public: publicSession })
      void live.agent.end().catch(() => {})
      this.notify(live)
    }
  }

  // Fire-and-forget: a dream that fails, whether by a rejected promise or a
  // synchronous throw, must never reach the timer loop and take the sweep
  // down with it.
  private runDreamTrigger(): void {
    try {
      void this.dreamTrigger?.()?.catch(() => {})
    } catch {
      // Contained, on purpose. See the comment above.
    }
  }

  liveSessions(): PublicSession[] {
    return [...this.live.values()].map((live) => ({ ...live.public }))
  }

  getLiveSession(sessionId: string): PublicSession | undefined {
    const live = this.live.get(sessionId)
    return live ? { ...live.public } : undefined
  }

  private async runTurn(
    live: LiveSession,
    turnId: string,
    turn: TurnRecord,
    message: string,
  ): Promise<void> {
    let terminal = false
    try {
      if (!this.providerAvailable) {
        this.record(live, {
          type: 'error',
          code: 'chat_unavailable',
          retryable: true,
          message: 'Chat is unavailable right now. Your saved record is still available.',
        })
        terminal = true
        return
      }
      for await (const event of live.agent.send(message)) {
        const input = streamEventFromAgent(event)
        if (input === undefined) continue
        const recorded = this.record(live, input)
        terminal ||= recorded.type === 'done' || recorded.type === 'error'
      }
      if (!terminal) {
        this.record(live, { type: 'done' })
        terminal = true
      }
    } catch (error) {
      if (!terminal) {
        this.record(live, {
          type: 'error',
          code: this.isProviderUnavailable(error) ? 'chat_unavailable' : 'chat_failed',
          retryable: true,
          message: this.isProviderUnavailable(error)
            ? 'Chat is unavailable right now. Your saved record is still available.'
            : 'Chat could not finish. Please try again.',
        })
        terminal = true
      }
    } finally {
      turn.state = 'terminal'
      turn.endSeq = live.sequence
      if (live.activeTurnId === turnId) live.activeTurnId = undefined
      live.lastActivity = this.now()
      await this.syncPublic(live)
      this.notify(live)
    }
  }

  private async recordGreeting(live: LiveSession): Promise<void> {
    try {
      for await (const event of live.agent.greet()) {
        const input = streamEventFromAgent(event)
        if (input !== undefined) this.record(live, input)
      }
      await this.syncPublic(live)
    } catch {
      // AgentSession.greet intentionally suppresses provider failures. This catch only guards
      // unexpected local failures, which must not turn a greeting into a fabricated transcript line.
    }
  }

  private record(live: LiveSession, input: StreamEventInput): StreamEvent {
    const event = { schemaVersion: '1' as const, seq: live.sequence + 1, ...input } as StreamEvent
    const encoded = `${JSON.stringify(event)}\n`
    const bytes = Buffer.byteLength(encoded, 'utf8')
    if (bytes > MAX_NDJSON_EVENT_BYTES) {
      throw new ApiError(413, 'record_too_large', 'A stream event is too large.')
    }
    live.sequence = event.seq
    live.replay.push({ event, bytes })
    live.replayBytes += bytes
    while (
      live.replay.length > this.maxReplayEvents ||
      (live.replay.length > 0 && live.replayBytes > this.maxReplayBytes)
    ) {
      const oldest = live.replay.shift()
      if (oldest) live.replayBytes -= oldest.bytes
    }
    this.notify(live)
    return event
  }

  private async *replayOrSubscribe(
    live: LiveSession,
    turn: TurnRecord,
    after: number | undefined,
  ): AsyncIterable<StreamEvent> {
    let cursor = after ?? turn.startSeq - 1
    while (true) {
      this.assertTurnReplayAvailable(live, turn, cursor)
      for (const record of live.replay) {
        if (record.event.seq >= turn.startSeq && record.event.seq > cursor) {
          yield record.event
          cursor = record.event.seq
        }
      }
      if (turn.state === 'terminal') return
      await this.waitForEvent(live)
    }
  }

  private assertTurnReplayAvailable(live: LiveSession, turn: TurnRecord, after: number): void {
    const first = live.replay.find((record) => record.event.seq >= turn.startSeq)?.event
    if (first && first.seq > Math.max(turn.startSeq, after + 1)) {
      throw new ApiError(409, 'resync_required', 'Fetch the saved transcript and try again.')
    }
    if (!first && turn.state === 'terminal' && turn.endSeq !== undefined && after < turn.endSeq) {
      throw new ApiError(409, 'resync_required', 'Fetch the saved transcript and try again.')
    }
  }

  private assertGlobalReplayAvailable(live: LiveSession, after: number | undefined): void {
    if (after === undefined) return
    const first = live.replay[0]?.event
    if (first && after < first.seq - 1) {
      throw new ApiError(409, 'resync_required', 'Fetch the saved transcript and try again.')
    }
    if (!first && after < live.sequence) {
      throw new ApiError(409, 'resync_required', 'Fetch the saved transcript and try again.')
    }
  }

  private waitForEvent(live: LiveSession): Promise<void> {
    return new Promise((resolve) => live.waiters.add(resolve))
  }

  private notify(live: LiveSession): void {
    for (const resolve of live.waiters) resolve()
    live.waiters.clear()
  }

  private async requireLive(sessionId: string): Promise<LiveSession> {
    const live = this.live.get(sessionId)
    if (live) return live
    const tombstone = this.tombstones.get(sessionId)
    if (tombstone) {
      throw new ApiError(
        409,
        tombstone.public.status === 'expired' ? 'session_expired' : 'session_ended',
        'This session is read-only.',
      )
    }
    if (await this.isStoredSession(sessionId)) {
      throw new ApiError(409, 'session_ended', 'This session is read-only.')
    }
    throw new ApiError(404, 'not_found', 'The requested resource was not found.')
  }

  private async isStoredSession(sessionId: string): Promise<boolean> {
    return (await this.engine.listStoredSessions()).some(
      (session) => session.sessionId === sessionId,
    )
  }

  private async syncPublic(live: LiveSession): Promise<void> {
    const lines = await this.engine.readTranscriptPage(live.public.sessionId)
    live.public = {
      ...live.public,
      updatedAt: lines.at(-1)?.ts ?? live.public.createdAt,
      transcript: transcriptCounts(lines),
    }
  }

  private addTombstone(tombstone: Tombstone): void {
    this.tombstones.delete(tombstone.sessionId)
    this.tombstones.set(tombstone.sessionId, tombstone)
    while (this.tombstones.size > ENDED_TOMBSTONE_CAP) {
      const oldest = this.tombstones.keys().next().value as string | undefined
      if (oldest) {
        this.tombstones.delete(oldest)
      }
    }
  }

  private isProviderUnavailable(error: unknown): boolean {
    return error instanceof ProviderUnavailableError
  }
}

export function createLiveSessionRegistry(
  options: LiveSessionRegistryOptions,
): LiveSessionRegistry {
  return new LiveSessionRegistry(options)
}

const nodeIntervalScheduler: RegistryScheduler = {
  schedule(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs)
    timer.unref()
    return () => clearInterval(timer)
  },
}

function streamEventFromAgent(event: AgentEvent): StreamEventInput | undefined {
  switch (event.type) {
    case 'thinking':
      return { type: 'thinking' }
    case 'text':
      return { type: 'text', text: event.text }
    case 'tool':
      return { type: 'tool', name: event.name }
    case 'mode':
      return { type: 'mode', mode: event.mode }
    case 'done':
      return { type: 'done' }
  }
}

function emptyTranscript(): PublicSession['transcript'] {
  return { lineCount: 0, userCount: 0, assistantCount: 0, toolCount: 0 }
}

function transcriptCounts(lines: PublicTranscriptLine[]): PublicSession['transcript'] {
  return {
    lineCount: lines.length,
    userCount: lines.filter((line) => line.role === 'user').length,
    assistantCount: lines.filter((line) => line.role === 'assistant').length,
    toolCount: lines.filter((line) => line.role === 'tool').length,
  }
}
