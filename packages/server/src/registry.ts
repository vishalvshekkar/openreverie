import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { type AgentEvent, AgentSession, type ReverieConfig } from '@openreverie/core'
import type { MemoryEngine, PublicSession, PublicTranscriptLine } from '@openreverie/memory'
import type { ChatProvider } from '@openreverie/providers'
import { ApiError } from './api.js'

const MAX_NDJSON_EVENT_BYTES = 256 * 1024
const ENDED_TOMBSTONE_CAP = 64
const THIRTY_MINUTES = 30 * 60 * 1000

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
}

interface ReplayRecord {
  event: StreamEvent
  bytes: number
}

interface TurnRecord {
  hash: string
  message: string
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
  private readonly live = new Map<string, LiveSession>()
  private readonly tombstones = new Map<string, Tombstone>()
  private readonly evictedTombstones = new Set<string>()

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
  }

  async create(): Promise<CreateSessionResponse> {
    if (this.live.size >= this.maxLiveSessions) {
      throw new ApiError(429, 'session_capacity', 'Too many live sessions are open.')
    }
    const agent = await AgentSession.start(this.engine, this.config, this.chat)
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
      message: body.message,
      state: 'active',
      startSeq: live.sequence + 1,
    }
    live.turns.set(turnId, turn)
    live.activeTurnId = turnId
    void this.runTurn(live, turnId, turn)
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

  sweep(now = this.now()): void {
    for (const [sessionId, live] of this.live) {
      if (live.activeTurnId || now - live.lastActivity < THIRTY_MINUTES) continue
      this.live.delete(sessionId)
      const publicSession = { ...live.public, status: 'expired' as const, readOnly: true }
      this.addTombstone({ sessionId, public: publicSession })
      void live.agent.end().catch(() => {})
      this.notify(live)
    }
  }

  liveSessions(): PublicSession[] {
    return [...this.live.values()].map((live) => ({ ...live.public }))
  }

  getLiveSession(sessionId: string): PublicSession | undefined {
    const live = this.live.get(sessionId)
    return live ? { ...live.public } : undefined
  }

  private async runTurn(live: LiveSession, turnId: string, turn: TurnRecord): Promise<void> {
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
      for await (const event of live.agent.send(turn.message)) {
        const recorded = this.record(live, streamEventFromAgent(event))
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
      for await (const event of live.agent.greet()) this.record(live, streamEventFromAgent(event))
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
    if (this.evictedTombstones.has(sessionId)) {
      throw new ApiError(404, 'not_found', 'The requested resource was not found.')
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
    this.evictedTombstones.delete(tombstone.sessionId)
    this.tombstones.delete(tombstone.sessionId)
    this.tombstones.set(tombstone.sessionId, tombstone)
    while (this.tombstones.size > ENDED_TOMBSTONE_CAP) {
      const oldest = this.tombstones.keys().next().value as string | undefined
      if (oldest) {
        this.tombstones.delete(oldest)
        this.evictedTombstones.add(oldest)
      }
    }
  }

  private isProviderUnavailable(_error: unknown): boolean {
    return !this.providerAvailable
  }
}

function streamEventFromAgent(event: AgentEvent): StreamEventInput {
  switch (event.type) {
    case 'thinking':
      return { type: 'thinking' }
    case 'text':
      return { type: 'text', text: event.text }
    case 'tool':
      return { type: 'tool', name: event.name }
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
