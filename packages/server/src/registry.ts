import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  type AgentEvent,
  AgentSession,
  type IncompleteTurn,
  isModeName,
  type PersonaOptions,
  type ReverieConfig,
} from '@openreverie/core'
import type { MemoryEngine, PublicSession, PublicTranscriptLine } from '@openreverie/memory'
import { type ChatProvider, ProviderUnavailableError } from '@openreverie/providers'
import { ApiError } from './api.js'

const MAX_NDJSON_EVENT_BYTES = 256 * 1024
const ENDED_TOMBSTONE_CAP = 64
// Named and exported so a host can read these instead of copying the
// numbers: omitting idleSweep or dreamSweep on LiveSessionRegistryOptions
// reproduces these exact values, unchanged from today.
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000
export const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 60 * 1000
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

// What LiveSessionRegistry.resume hands back: the ordinary public view plus
// the resume design's own diagnostics (docs/specs/2026-08-29-session-resume-
// design.md, section 3, and its addendum), reported rather than smoothed
// over so a host can tell a cache-preserving resume from a cache-breaking
// one, and a complete rebuild from one that lost a turn at eviction.
export interface ResumedSession extends PublicSession {
  incompleteTurn?: IncompleteTurn
  // false means at least one user stamp could not be reproduced byte for
  // byte against what the live session actually sent, so this resume did
  // not preserve the provider's prefix cache for that message onward.
  stampsExact: boolean
  // true when the system prompt came back from the persisted copy the
  // session itself wrote; false when it had to be re-assembled instead.
  systemPromptRestored: boolean
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
  // A host that owns session lifetime itself (a Cloudflare Durable Object
  // driven by its own alarm, working off durable session rows on disk)
  // needs a way to turn this registry's own idle sweep off entirely, not
  // just make it into a no-op. sweep() only ever walks this registry's
  // in-memory `live` map, which in a Durable Object holds only the
  // sessions this particular wake has touched since the object was last
  // instantiated: a session whose object already evicted is gone from
  // that map and can never be swept, no matter how sweep() is configured.
  // This registry cannot own session lifetime for that host under any
  // configuration, so the honest seam is a constructor option that says
  // so plainly, rather than a scheduler quietly wired to never fire.
  //
  // Omitted keeps today's behavior exactly. `false` schedules no timer at
  // all, for a host that owns session lifetime itself.
  idleSweep?: false | { idleTimeoutMs?: number; intervalMs?: number }
  // `dreamSweep: false` alongside a supplied `dreamTrigger` is legal: the
  // host already holds its own reference to that function (it is the one
  // that passed it in) and can call it directly from its own alarm.
  // With `dreamSweep: false`, this registry itself never calls it.
  //
  // Omitted keeps today's behavior exactly. `false` schedules no timer at
  // all.
  dreamSweep?: false | { intervalMs?: number }
  // Passed through unchanged to every AgentSession this registry creates.
  // Omitted keeps AgentSessionOptions.greetingTimeoutMs's own default
  // (GREETING_TIMEOUT_MS, 20 seconds).
  greetingTimeoutMs?: number
}

export interface RegistryScheduler {
  schedule(callback: () => void, intervalMs: number): () => void
}

// The two reflection projections this registry can ever honestly build
// itself, without asking the engine (R4). A live session has not had
// endSession called for it yet, so 'not_started' with zero attempts is
// simply true. A session this registry has just ended or swept as
// expired is different: reflection has been handed off to run detached in
// the background (see end()'s runReflection callback and sweep() below)
// at the exact instant this object is built, so the registry genuinely
// cannot know, synchronously, whether the durable attempt record has even
// landed yet, let alone whether it has resolved. 'in_progress' is the
// only state that assertion can make without lying: a reflection call for
// this session has definitely just been initiated. attempts is left out
// entirely rather than fabricated as 0 or 1, since either could already
// be wrong by the time a caller reads this response. GET
// /api/v1/sessions/:id reads the real, durable answer once a session is
// no longer live (it falls through to engine.listStoredSessions(), backed
// by the reflection log); these two constants only have to be honest
// about what the registry itself can assert at the instant it responds.
const NOT_STARTED_REFLECTION: PublicSession['reflection'] = { state: 'not_started', attempts: 0 }
const DETACHED_REFLECTION: PublicSession['reflection'] = { state: 'in_progress' }

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
  private readonly idleTimeoutMs: number
  private readonly greetingTimeoutMs: number | undefined
  private readonly live = new Map<string, LiveSession>()
  private readonly tombstones = new Map<string, Tombstone>()
  // Single-flights concurrent resume(id) calls for the same session id:
  // two requests arriving together (a host resuming defensively from two
  // in-flight handlers, say) must build at most one AgentSession over that
  // id, not two racing ones. Populated and read synchronously inside
  // resume() before any await, so two calls issued back to back always
  // observe each other's entry; cleared once the shared attempt settles,
  // including when it rejects, so a failed resume never wedges the id.
  private readonly resuming = new Map<string, Promise<ResumedSession>>()
  // F1: every reflection this registry has handed off to runBackground
  // (from end()) or run detached (from sweep()), tracked from the moment
  // it starts until it settles. Both end() and sweep() delete their
  // session from `this.live` before or as part of detaching its
  // reflection, so close()'s own await over `this.live` never sees either
  // one; this set is what makes close() still wait for them.
  private readonly detachedReflections = new Set<Promise<unknown>>()
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
    this.greetingTimeoutMs = options.greetingTimeoutMs
    // sweep()'s own idle threshold, read regardless of whether the sweep
    // timer below is even scheduled: a caller can still invoke sweep()
    // manually (this registry's own tests do), and it must use the
    // configured timeout either way.
    this.idleTimeoutMs = options.idleSweep
      ? (options.idleSweep.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS)
      : DEFAULT_IDLE_TIMEOUT_MS
    const scheduler = options.scheduler ?? nodeIntervalScheduler
    // `false` means scheduler.schedule is never called for that timer:
    // not called with a no-op callback, not called and immediately
    // cancelled. A plain no-op cancel function stands in its place, so
    // close() stays correct either way without needing to know which
    // timers were actually scheduled.
    this.cancelSweep =
      options.idleSweep === false
        ? noopCancel
        : scheduler.schedule(() => {
            if (!this.closed) this.sweep()
          }, options.idleSweep?.intervalMs ?? DEFAULT_IDLE_SWEEP_INTERVAL_MS)
    this.cancelDreamTrigger =
      options.dreamSweep === false
        ? noopCancel
        : scheduler.schedule(() => {
            if (!this.closed) this.runDreamTrigger()
          }, options.dreamSweep?.intervalMs ?? DREAM_SWEEP_INTERVAL)
  }

  // F1: registers `work` in detachedReflections until it settles, so
  // close() can find and await it even after the caller has already
  // deleted its session from `this.live`. Returns `work` unchanged so a
  // caller can hand the result straight to runBackground (end()) or await
  // it directly (sweep()).
  private trackDetached<T>(work: Promise<T>): Promise<T> {
    this.detachedReflections.add(work)
    const clear = (): void => {
      this.detachedReflections.delete(work)
    }
    work.then(clear, clear)
    return work
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
    )
      // Snapshotting detachedReflections here, after the live-session
      // drain above starts rather than before it, matters: an end() or
      // sweep() call already in flight when close() begins registers its
      // reflection into the set only once its own call reaches that
      // point, which can happen while the drain above is still running.
      // Reading the set late, in this continuation, still catches those.
      //
      // allSettled, not all: a rejected reflection here is already an
      // expected, swallowed failure by construction (both end() and
      // sweep() catch before calling trackDetached), but this is close()'s
      // own backstop, so it never rejects because of one regardless of
      // whether every future caller of trackDetached remembers to
      // pre-catch.
      .then(() => Promise.allSettled([...this.detachedReflections]))
      .then(() => undefined)
    return this.closePromise
  }

  async create(options: { mode?: string; greet?: boolean } = {}): Promise<CreateSessionResponse> {
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
      ...(this.greetingTimeoutMs === undefined
        ? {}
        : { greetingTimeoutMs: this.greetingTimeoutMs }),
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
        // Never true for a live session: PublicSession.resumable is
        // derived from status === 'open' everywhere it is computed
        // (MemoryEngine.listStoredSessions), and 'live' is never 'open'.
        // Session resume itself (the registry entry point that would
        // consume this) is a separate task; this keeps the type honest in
        // the meantime rather than guessing at a value that task should
        // set.
        resumable: false,
        mode: agent.mode,
        transcript: stored?.transcript ?? emptyTranscript(),
        reflection: NOT_STARTED_REFLECTION,
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

    // A client whose person opened the conversation by typing a first
    // message has no use for a greeting turn ahead of it: greet: false
    // skips the model call entirely, so this returns the same shape the
    // !providerAvailable branch already produces (no
    // initialGreetingStreamUrl, live.greeting left undefined,
    // live.activeTurnId left undefined so message()'s '__greeting__'
    // guard never trips).
    if (!this.providerAvailable || options.greet === false) return { ...live.public }

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

  // Session resume (R1): rebuilds a live AgentSession over a session id
  // that is on disk but not currently held by this registry, so a host's
  // own hibernate/resume cycle (a Cloudflare Durable Object evicted between
  // messages, say) can bring a session back without losing its place.
  // Follows docs/specs/2026-08-29-session-resume-design.md section 3
  // exactly, in the order its checks run. No auto-resume lives anywhere
  // else in this class (requireLive never calls this), and no route calls
  // it either: the design declined both, deliberately, in favor of the
  // host driving resume from its own durable liveness row. See the
  // design's own section 3 for why a window check does not belong here.
  async resume(sessionId: string): Promise<ResumedSession> {
    // Already live: return the current public view, no rebuild. Idempotent
    // by design, so a host that resumes defensively before every message
    // pays one map lookup here, not a second AgentSession. Nothing was
    // rebuilt and nothing was lost by this call, so every diagnostic
    // reports the cleanest possible answer rather than a fabricated one.
    const live = this.live.get(sessionId)
    if (live) {
      return { ...live.public, stampsExact: true, systemPromptRestored: true }
    }

    // Single-flighted: the map is read and, on a miss, populated
    // synchronously below, with no await in between, so two resume(id)
    // calls issued back to back (Promise.all([registry.resume(id),
    // registry.resume(id)]), the same shape message()'s own idempotency
    // tests use) always observe each other's entry rather than racing to
    // build two AgentSession objects over one id.
    let inFlight = this.resuming.get(sessionId)
    if (!inFlight) {
      inFlight = this.doResume(sessionId).finally(() => {
        this.resuming.delete(sessionId)
      })
      this.resuming.set(sessionId, inFlight)
    }
    const resumed = await inFlight
    // A fresh copy per caller, the same posture every other public-view
    // return in this class already takes (liveSessions, getLiveSession,
    // create's own `{ ...live.public }`): two joiners of one in-flight
    // promise must never share one mutable reference.
    return { ...resumed }
  }

  private async doResume(sessionId: string): Promise<ResumedSession> {
    // A tombstone is this process's own record that this session was ended
    // or expired here, and it is authoritative sooner than the durable
    // record the reflection-state check below reads: engine.endSession
    // only appends that durable attempt record after its own idempotency
    // scan of every stored session on disk (SessionStore.listSessions,
    // packages/memory/src/engine.ts), and end() and sweep() never wait for
    // any of that before deleting the session from `this.live` and adding
    // this tombstone. A resume racing in during that gap would otherwise
    // see: not live here, present on disk, reflection state still
    // 'not_started', and rebuild a live session over one that is, at that
    // instant, being reflected. Checked first, before the storedSessionExists
    // and sessionReflectionState checks below, since a map lookup here is
    // both cheaper and more current than either. Reuses requireLive's own
    // error mapping so the two paths never answer one tombstoned id two
    // different ways.
    //
    // Not a complete fix, stated honestly: the tombstone cache is capped at
    // ENDED_TOMBSTONE_CAP and evicts oldest-first (addTombstone below), so a
    // session whose tombstone has since been evicted falls through to the
    // checks below, which by then have the durable record on disk and
    // refuse correctly on their own. The window that would remain, a
    // session tombstoned so recently its durable record has not landed and
    // evicted from the cache so long ago it is already gone, cannot both be
    // true under this registry's default configuration (maxLiveSessions: 8,
    // far under the 64-entry cap: sweep() can tombstone at most
    // maxLiveSessions sessions in one call). That is a configuration fact,
    // though, not a structural guarantee, and it does not hold in general.
    // sweep() builds and inserts every expired session's tombstone with no
    // I/O between them, a single synchronous pass over `this.live` with no
    // await anywhere in its loop, unlike end()'s own disk read
    // (syncPublic) before its tombstone. A host that configures
    // maxLiveSessions above ENDED_TOMBSTONE_CAP can hit a sweep() call that
    // expires more sessions in one pass than the cache holds, evicting an
    // early one before its own live.agent.end() has reached its first
    // await, let alone before its durable record has landed. That
    // configuration is the real residual window this check does not close.
    const tombstone = this.tombstones.get(sessionId)
    if (tombstone) throw this.tombstoneError(tombstone)

    if (this.live.size >= this.maxLiveSessions) {
      throw new ApiError(429, 'session_capacity', 'Too many live sessions are open.')
    }

    // Existence only, no transcript read: session resume runs on a host's
    // post-hibernation path, which is every message it sends after a cold
    // start, so this must never become a second caller of
    // engine.listStoredSessions(), which reads every session's transcript
    // in full (a consumer measured that scan at 67ms for 200 sessions). A
    // written commitment was made that resume would not become a new
    // caller of it. Do not "simplify" this into listStoredSessions(): that
    // is exactly the regression this comment exists to catch.
    const exists = await this.engine.storedSessionExists(sessionId)
    if (!exists) {
      throw new ApiError(404, 'not_found', 'The requested resource was not found.')
    }

    // A session is resumable only when no reflection attempt has ever run
    // against it: a partial reflection may already have materialised arcs,
    // people, or items from that transcript, so this must fail closed.
    // sessionReflectionState folds the reflection log and checks disk for
    // a summary without reading a transcript, the same cheap primitive
    // storedSessionExists above is. Allow-list of exactly one state
    // ('not_started'), never a deny-list of the other four: a reflection
    // state nobody has named yet must default to refused, not admitted.
    const reflection = await this.engine.sessionReflectionState(sessionId)
    if (reflection.state !== 'not_started') {
      throw new ApiError(409, 'session_ended', 'This session is read-only.')
    }

    // One read of this one session's own transcript, to build the counts
    // and timestamps the public view carries (the same shape syncPublic
    // computes elsewhere in this class). Not the banned listStoredSessions
    // scan: this is a single-session read, the same primitive syncPublic
    // already calls after every turn.
    const transcriptLines = await this.engine.readTranscriptPage(sessionId)
    // Same fallback create() already uses when its own listStoredSessions
    // lookup comes back empty: a resume clock read is the honest answer
    // when there is no recorded line to derive a real timestamp from.
    const createdAt = transcriptLines[0]?.ts ?? new Date(this.now()).toISOString()
    const updatedAt = transcriptLines.at(-1)?.ts ?? createdAt

    const { session: agent, report } = await AgentSession.resume(
      this.engine,
      this.config,
      this.chat,
      sessionId,
      {
        persona: this.persona,
        ...(this.greetingTimeoutMs === undefined
          ? {}
          : { greetingTimeoutMs: this.greetingTimeoutMs }),
      },
    )

    const publicSession: PublicSession = {
      sessionId: agent.sessionId,
      createdAt,
      updatedAt,
      status: 'live',
      readOnly: false,
      // Never true once resumed into this process: PublicSession.resumable
      // means "could a host resume this", and a session already live here
      // has already been resumed. Same reasoning create() states for its
      // own live sessions.
      resumable: false,
      mode: agent.mode,
      transcript: transcriptCounts(transcriptLines),
      reflection: NOT_STARTED_REFLECTION,
    }
    const live: LiveSession = {
      agent,
      public: publicSession,
      turns: new Map(),
      replay: [],
      replayBytes: 0,
      sequence: 0,
      activeTurnId: undefined,
      lastActivity: this.now(),
      // A resumed session never greets: no greeting was scheduled here, so
      // message()'s '__greeting__' guard never trips and requireLive can
      // serve a message immediately.
      greeting: undefined,
      waiters: new Set(),
    }
    this.live.set(sessionId, live)

    return {
      ...publicSession,
      stampsExact: report.stampsExact,
      systemPromptRestored: report.systemPromptRestored,
      ...(report.incompleteTurn ? { incompleteTurn: report.incompleteTurn } : {}),
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
      const stored = await this.findStoredSession(sessionId)
      if (stored) throw this.storedSessionWriteError(stored)
      throw new ApiError(404, 'not_found', 'The requested resource was not found.')
    }
    await live.greeting
    // Reflection is handed to runBackground rather than awaited here, so a
    // person tapping "end conversation" gets a response as soon as the
    // transcript is complete, not after one or two more model calls plus a
    // rewrite per changed arc and person. syncPublic below still runs after
    // agent.end() returns, and agent.end() itself still waits for the send
    // chain to drain first, so it keeps reading a complete transcript.
    //
    // The catch here is still a swallow, but no longer because there is
    // nowhere to record a background reflection failure: engine.endSession
    // now appends a durable attempt record before any model call and a
    // 'failed' outcome (with the error's own message) if reflection throws
    // (R4, packages/memory/src/reflectionLog.ts), so a failure here is no
    // longer invisible. The swallow stays for a narrower reason: `work` is
    // already a detached, fire-and-forget promise by the time it reaches
    // this callback (this HTTP response has already returned), and letting
    // it reject unhandled here would surface as a process-level unhandled
    // rejection for a request nobody is still waiting on. The durable
    // record is what a person or `reverie doctor` reads instead; GET
    // /api/v1/sessions/:id surfaces it through engine.listStoredSessions()
    // once this session is no longer live.
    await live.agent.end({
      runReflection: (work) => {
        this.runBackground(
          // trackDetached first, then the catch's swallow is what gets
          // handed to runBackground: registering the settled (already
          // caught) promise in detachedReflections, rather than the raw
          // one, is what lets close() await this reflection even though
          // this session is about to be deleted from `this.live` below
          // (F1). See the comment above: the durable record now lives in
          // the reflection log, not in this promise's rejection, so
          // swallowing it here loses nothing that matters.
          this.trackDetached(work.catch(() => {})),
        )
      },
    })
    await this.syncPublic(live)
    this.live.delete(sessionId)
    // reflection here is DETACHED_REFLECTION ('in_progress', attempts
    // omitted), not whatever live.public.reflection already held
    // ('not_started', from create()): the runReflection callback above
    // has just handed a real reflection attempt to the background, so by
    // the time this response is built, 'not_started' would already be a
    // stale claim. See DETACHED_REFLECTION's own comment above for why
    // this is the most this registry can honestly assert right here.
    const publicSession = {
      ...live.public,
      status: 'ended' as const,
      readOnly: true,
      reflection: DETACHED_REFLECTION,
    }
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
      if (live.activeTurnId || now - live.lastActivity < this.idleTimeoutMs) continue
      this.live.delete(sessionId)
      // reflection: DETACHED_REFLECTION for the same reason end() above
      // uses it: live.agent.end() below is about to hand a real
      // reflection attempt to the background (R4 logs it durably), so
      // this tombstone must not keep claiming 'not_started'.
      const publicSession = {
        ...live.public,
        status: 'expired' as const,
        readOnly: true,
        reflection: DETACHED_REFLECTION,
      }
      this.addTombstone({ sessionId, public: publicSession })
      // Same shape as end()'s detached reflection above (F1): live.agent.end()
      // here runs with no runReflection override, so it awaits reflection
      // itself internally and the whole call, not just reflection, is what
      // gets tracked and left detached.
      void this.trackDetached(live.agent.end().catch(() => {}))
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
    if (tombstone) throw this.tombstoneError(tombstone)
    const stored = await this.findStoredSession(sessionId)
    if (stored) throw this.storedSessionWriteError(stored)
    throw new ApiError(404, 'not_found', 'The requested resource was not found.')
  }

  // Shared by requireLive and doResume, so a tombstoned session id gets the
  // same answer from both: 'expired' for one this registry's own sweep()
  // timed out, 'session_ended' for anything else (a person-driven end(),
  // and the fallback for a status this method does not recognise, same
  // fail-closed posture storedSessionWriteError already takes below).
  private tombstoneError(tombstone: Tombstone): ApiError {
    return new ApiError(
      409,
      tombstone.public.status === 'expired' ? 'session_expired' : 'session_ended',
      'This session is read-only.',
    )
  }

  private async findStoredSession(sessionId: string): Promise<PublicSession | undefined> {
    return (await this.engine.listStoredSessions()).find(
      (session) => session.sessionId === sessionId,
    )
  }

  // A stored session that was never reflected is not the same lie as one
  // that genuinely ended: the person's process crashed or was killed
  // before reflection ran, not because they closed the conversation. Only
  // 'open' gets the softer code; anything else, including a status this
  // method does not recognise, falls to session_ended, the more
  // restrictive of the two. Fail closed: an unrecognised status must never
  // be read as license to admit a write.
  private storedSessionWriteError(stored: PublicSession): ApiError {
    if (stored.status === 'open') {
      return new ApiError(
        409,
        'session_not_live',
        'This session was never ended. It is not live in this process.',
      )
    }
    return new ApiError(409, 'session_ended', 'This session is read-only.')
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

// Stands in for scheduler.schedule's own returned cancel function when a
// timer was never scheduled at all (idleSweep: false or dreamSweep:
// false), so close() can call cancelSweep/cancelDreamTrigger
// unconditionally without needing to know which timers actually exist.
function noopCancel(): void {}

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
