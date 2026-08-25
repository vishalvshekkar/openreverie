// The streaming agent session loop: the conversational heart of reverie.
//
// AgentSession.start assembles the system prompt once (persona plus a
// snapshot of memory state) and opens a session with the memory engine.
// send() runs a standard streaming tool-call loop against the configured
// chat provider: it streams text straight through to the caller, and on
// every tool call it dispatches through the engine and feeds the result
// back for another round, up to a fixed round limit so a model that will
// not stop calling tools cannot loop forever.
//
// Transcript-first discipline: every user line, assistant tool-call line,
// tool result line, and final assistant text line is appended to the
// on-disk transcript before it is added to the in-memory message history
// that gets sent back to the model. The transcript is the durable record;
// the in-memory history exists only for the life of this session object.
//
// Invariant: history content and transcript content deliberately differ.
// The transcript line stores content verbatim, plus structural time fields
// (ts, utcOffsetMinutes). The in-memory history stores the same content,
// with that same time rendered into it for user messages. Both come from
// one clock read per message; the transcript is the record, the history is
// the rendering, and neither is ever built from a different read than the
// other. A stamp, once written into history, is never rewritten: that is
// what keeps every request a strict extension of the previous one, which is
// the shape a provider's prefix cache is built to serve.

import type { MemoryEngine } from '@openreverie/memory'
import { renderLiveStamp, renderLocalTime, utcOffsetMinutesFor } from '@openreverie/memory'
import type { ChatProvider, ToolCall } from '@openreverie/providers'
import type { ReverieConfig } from './config.js'
import { assembleSystemPrompt } from './context.js'
import type { ModeName } from './modes.js'
import { dispatchTool, toolDefinitions } from './tools.js'

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'thinking' }
  | { type: 'mode'; mode: ModeName }
  | { type: 'done' }

export type ModeChangeSource = 'cli' | 'web' | 'tool'

export interface AgentSessionOptions {
  // Injectable clock. Every transcript line and every rendered time in this
  // session comes from a call to this, so a test can pin it without
  // touching process-wide state.
  now?: () => Date
  // The mode this session starts in. Defaults to 'general'. Session mode
  // is session state, never persisted config, so this is the only way a
  // caller sets a starting mode other than the default.
  mode?: ModeName
}

const MAX_TOOL_ROUNDS = 8

const GREETING_TIMEOUT_MS = 20_000

const GREETING_INSTRUCTION = `## Speak first

You are opening this session before the user has said anything. Say something now, unprompted.

If the guidance above is the first conversation guidance, follow it exactly and ignore everything below in this section: it already tells you how to open, so treat this as your instruction to do that now rather than wait to be spoken to.

Otherwise: always speak, even when nothing in particular needs raising. If nothing is pressing, one or two warm sentences with no agenda is enough.

If there is something worth opening with, choose exactly one, in this order, and lead with only that:
1. Something left unresolved from the most recent session. A recorded intention is evidence the person meant to do something, never evidence that they did it: do not ask how something went unless the record shows it actually happened.
2. Something notable in the recent record: a day that sounded hard, a milestone coming up.
3. Nothing. A short hello.

Never open with a list. Never summarize the record. Never give a status report. Never open with housekeeping, bookkeeping, or anything about managing memory: no mentioning that you remembered something, added someone to your notes, or updated a page. Open with the person's life, not with your own record keeping. Say the one thing you picked the way you would say it out loud to someone you know, not the way you would write a briefing.

How hard you reach for a thread depends on your configured engagement: following stays light, leading is more willing to name one directly.`

// A single-use, per-call timeout wrapper around an async iterable: each
// call to the underlying iterator races against a fresh ms-long timer, so
// a provider that stalls between chunks (or never yields at all) throws
// instead of hanging forever. The timer is cleared after every step,
// whether it wins or loses the race.
//
// When the timer wins, the underlying iterator is left parked mid-call
// (an OpenAiChatProvider generator suspended at `await reader.read()`, for
// example), and nobody will ever call next() on it again after this
// function throws. Left alone, that generator's own finally (which
// cancels the reader and releases its lock) never runs. iterator.return()
// queues a request that the generator will service the next time it
// reaches a yield or its own await settles, unwinding through that
// finally instead of continuing normally.
//
// The timer winning is not the only way this generator stops early: a
// consumer can also abandon it directly (Ctrl-C while the greeting is
// streaming calls .return() on this generator the same way a `for await`
// break does). `advancedPastYield` distinguishes the two ways execution
// can reach the finally below. It is only ever set to true by the line
// immediately after `yield result.value`, so it stays false whenever
// that yield does not resume normally: a plain abandonment injects a
// return completion at the yield instead of continuing past it, per
// generator .return() semantics, which is exactly the case this exists
// to catch. It is also false, harmlessly, on the `result.done` early
// return and when `iterator.next()` itself throws (a real provider
// error): in both cases the underlying iterator is already finished or
// already errored out, so calling .return() on it below is a no-op, not
// a double-unwind.
//
// This is fire-and-forget, not awaited: measured against a generator
// that is currently mid an unsettled await (not suspended at a yield),
// a queued return() is not serviced until that specific await settles on
// its own; there is no way to force it sooner. A provider stuck there
// (there is no AbortController wired through ChatRequest to make it
// settle) may never resolve at all, and awaiting return() here would
// hang for exactly as long as this timeout (and this abandonment path)
// exist to avoid. Any throw from return() itself is swallowed: it must
// never replace or delay the timeout error, or a plain abandonment,
// already propagating.
async function* withTimeout<T>(iterable: AsyncIterable<T>, ms: number): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]()
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const timedOutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error('AgentSession: greeting timed out'))
      }, ms)
    })
    let advancedPastYield = false
    try {
      const result = await Promise.race([iterator.next(), timedOutPromise])
      if (result.done) return
      yield result.value
      advancedPastYield = true
    } finally {
      clearTimeout(timer)
      if (timedOut || !advancedPastYield) {
        iterator.return?.()?.catch(() => {})
      }
    }
  }
}

// A message this session ever appends is always user, assistant, or tool,
// never system (the system prompt is passed separately on every request).
// This narrower type is what both the in-memory history and the on-disk
// transcript line are built from.
interface SessionMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
}

export class AgentSession {
  readonly sessionId: string
  private readonly engine: MemoryEngine
  private readonly chat: ChatProvider
  private readonly model: string
  private system: string
  private readonly history: SessionMessage[] = []
  private ended = false
  // Concurrent send() calls are serialized behind this promise chain: the
  // Nth send() only begins running once the (N-1)th has fully completed
  // (its generator exhausted or thrown), so two overlapping callers never
  // race reads/writes of `history` or interleave transcript appends.
  // end() awaits the same chain so it never reflects a session while a
  // round is still being written.
  private sendChain: Promise<void> = Promise.resolve()

  private readonly config: ReverieConfig
  private readonly now: () => Date
  private activeMode: ModeName

  private constructor(
    engine: MemoryEngine,
    chat: ChatProvider,
    model: string,
    system: string,
    sessionId: string,
    config: ReverieConfig,
    now: () => Date,
    mode: ModeName,
  ) {
    this.engine = engine
    this.chat = chat
    this.model = model
    this.system = system
    this.sessionId = sessionId
    this.config = config
    this.now = now
    this.activeMode = mode
  }

  get mode(): ModeName {
    return this.activeMode
  }

  static async start(
    engine: MemoryEngine,
    config: ReverieConfig,
    chat: ChatProvider,
    options: AgentSessionOptions = {},
  ): Promise<AgentSession> {
    const mode = options.mode ?? 'general'
    // Important 4 (part one): assembleSystemPrompt's own injectable clock
    // is only useful if AgentSession actually passes its clock to it.
    // Computed once here, ahead of the call, rather than passing
    // options.now directly, so a caller that omits options.now keeps
    // reading the real wall clock unchanged, the same default
    // assembleSystemPrompt itself falls back to.
    const now = options.now ?? (() => new Date())
    const system = await assembleSystemPrompt(engine, config, mode, now)
    const sessionId = await engine.startSession()
    // Recorded from the session's first moment, so a process that dies
    // before /bye still leaves the mode where reflection can find it.
    await engine.setSessionMode(sessionId, mode)
    return new AgentSession(engine, chat, config.models.chat, system, sessionId, config, now, mode)
  }

  // The one place a session's mode changes, from all three callers. Each
  // caller differs in exactly one way, which the transcript has to record:
  // the CLI's /mode is a line the user literally typed, the web picker is a
  // click with no keystroke behind it, and a set_mode tool call is already
  // recorded by its own assistant tool-call line and tool result line.
  async setMode(name: ModeName, options: { source: ModeChangeSource }): Promise<void> {
    this.activeMode = name
    if (options.source !== 'tool') {
      const now = this.now()
      await this.engine.appendTranscript(this.sessionId, {
        ts: now.toISOString(),
        utcOffsetMinutes: utcOffsetMinutesFor(now, this.engine.timezone()),
        role: 'user',
        content: `/mode ${name}`,
        ...(options.source === 'web' ? { synthetic: true as const } : {}),
      })
    }
    await this.engine.setSessionMode(this.sessionId, name)
    await this.refreshSystemPrompt()
  }

  // A public entry point, because /style and the settings pane both change
  // the profile from outside any turn. Without one, the only re-assembly in
  // the codebase is buried inside runTurn, and a /style change would apply
  // no earlier than the next session.
  async refreshSystemPrompt(): Promise<void> {
    this.system = await assembleSystemPrompt(this.engine, this.config, this.activeMode, this.now)
  }

  async *send(userText: string): AsyncIterable<AgentEvent> {
    if (this.ended) {
      throw new Error('AgentSession: send() called after end()')
    }
    // Queue behind whatever send() is currently running (or resolved,
    // if none is). Register this call's own gate in the chain before
    // awaiting anything, so a second, immediately-following send() (or
    // an end()) sees this one as already queued/in-flight.
    const previous = this.sendChain
    let release: () => void = () => {}
    this.sendChain = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await previous
      yield* this.runTurn(userText)
    } finally {
      release()
    }
  }

  // Opens a session before the user has said anything: streams a model
  // turn using the system prompt plus GREETING_INSTRUCTION, with no user
  // message and no tools, and appends the result as a single assistant
  // transcript line. Queued on the same sendChain as send(), so a greeting
  // and a send() (or end()) never race each other's transcript writes.
  async *greet(): AsyncIterable<AgentEvent> {
    if (this.ended) {
      throw new Error('AgentSession: greet() called after end()')
    }
    const previous = this.sendChain
    let release: () => void = () => {}
    this.sendChain = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await previous
      yield* this.runGreeting()
    } finally {
      release()
    }
  }

  private async *runGreeting(): AsyncIterable<AgentEvent> {
    yield { type: 'thinking' }
    let text = ''
    let errored = false
    // The greeting is the only model call with no user message to carry a
    // stamp, and it is the first call of the session. One clock read here
    // produces the line appended to this call's system string. Nothing
    // later reuses that string (every later request's prefix is
    // this.system plus messages), so this suffix costs no cache. No other
    // call site gets a system-string suffix.
    const openedAt = this.now()
    try {
      const stream = this.chat.stream({
        model: this.model,
        system: `${this.system}\n\n${GREETING_INSTRUCTION}\n\nThe current local time is ${renderLocalTime(openedAt, this.engine.timezone())}.`,
        messages: [],
        tools: [],
      })
      for await (const event of withTimeout(stream, GREETING_TIMEOUT_MS)) {
        if (event.type === 'text' && event.text.length > 0) {
          text += event.text
          yield { type: 'text', text: event.text }
        }
      }
    } catch {
      // Any provider error, or the timeout above, abandons the greeting
      // silently. Nothing streamed so far is appended to the transcript:
      // the user never asked for this message, so a half-written
      // greeting has no source to point back to. The user's first real
      // message will surface a real provider problem clearly.
      errored = true
    } finally {
      // Reached on normal completion, on the catch above, and also when a
      // consumer abandons the iterator mid stream (Ctrl-C while the
      // greeting is still streaming): that early exit resumes here via
      // the generator's own return(), bypassing the catch entirely, the
      // same way a `for await` break resumes a `finally` around it.
      // Persist whatever text was actually streamed to the caller in
      // every case except the error path: text the user already saw on
      // screen must not vanish from the record, but a message that never
      // got past the provider, or never got past the timeout, must never
      // appear at all.
      if (!errored && text.length > 0) {
        await this.appendBoth({ role: 'assistant', content: text })
      }
    }
    if (errored) return
    yield { type: 'done' }
  }

  private async *runTurn(userText: string): AsyncIterable<AgentEvent> {
    await this.appendBoth({ role: 'user', content: userText })

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      yield { type: 'thinking' }
      let text = ''
      const toolCalls: ToolCall[] = []

      try {
        for await (const event of this.chat.stream({
          model: this.model,
          system: this.system,
          // A snapshot, not a live reference: the provider (or a test fake)
          // may hold onto this array past the call, and history keeps
          // growing across rounds.
          messages: [...this.history],
          tools: toolDefinitions(),
        })) {
          if (event.type === 'text') {
            text += event.text
            if (event.text.length > 0) {
              yield { type: 'text', text: event.text }
            }
          } else if (event.type === 'tool_call') {
            toolCalls.push(event.toolCall)
          }
        }
      } catch (err) {
        // The provider failed mid-stream. Any text already yielded to the
        // caller must not vanish from the durable record just because the
        // round never reached a clean end: append what was accumulated so
        // far as this round's assistant line before letting the error
        // propagate. If nothing was streamed yet, there is nothing to
        // append (matches the "error before any content" case).
        if (text.length > 0) {
          await this.appendBoth({ role: 'assistant', content: text })
        }
        throw err
      }

      if (toolCalls.length === 0) {
        await this.appendBoth({ role: 'assistant', content: text })
        yield { type: 'done' }
        return
      }

      let first = true
      for (const toolCall of toolCalls) {
        // Transcript-first discipline applies to the event stream too:
        // append the assistant tool-call line, THEN yield the 'tool'
        // event. If the consumer abandons the iterator right after this
        // yield (break, thrown handler, cancellation), the transcript
        // already holds a coherent record of the call; dispatch and the
        // result line simply never happen, rather than the call being
        // told about but never recorded.
        await this.appendBoth({
          role: 'assistant',
          content: first ? text : '',
          toolCalls: [toolCall],
        })
        first = false
        yield { type: 'tool', name: toolCall.name }

        let switchedTo: ModeName | undefined
        const result = await dispatchTool(this.engine, this.sessionId, toolCall, {
          setMode: async (name) => {
            // source 'tool' because the assistant tool-call line and the
            // tool result line already record this change in the
            // transcript.
            await this.setMode(name, { source: 'tool' })
            switchedTo = name
          },
        })

        // Same for update_profile: the Time section is built from the
        // profile, so a confirmed timezone has to be reassembled in for the
        // rest of this session. This costs one cache miss, once, typically
        // during the first conversation. Messages already stamped keep the
        // stamp they were written with and are never re-rendered.
        if (toolCall.name === 'update_profile' && !this.resultHasError(result)) {
          this.system = await assembleSystemPrompt(
            this.engine,
            this.config,
            this.activeMode,
            this.now,
          )
        }

        // Same reasoning as update_profile above: journaling.md feeds
        // the journaling protocol section of the system prompt, so a
        // live rewrite has to be reassembled in before the next model
        // call sees it, rather than waiting for a session that has not
        // started yet.
        if (toolCall.name === 'update_journaling_protocol' && !this.resultHasError(result)) {
          await this.refreshSystemPrompt()
        }

        await this.appendBoth({ role: 'tool', content: result, toolCallId: toolCall.id })
        if (switchedTo !== undefined) {
          yield { type: 'mode', mode: switchedTo }
        }
      }
    }

    // Still calling tools after MAX_TOOL_ROUNDS rounds: everything from
    // those rounds is already appended above. Stop instead of making
    // another model call, rather than looping forever.
    yield { type: 'done' }
  }

  async end(): Promise<void> {
    if (this.ended) return
    this.ended = true
    // Let any in-flight (or queued) send() finish writing its lines
    // before reflection reads the transcript, so a round in progress is
    // never silently excluded from reflection.
    await this.sendChain
    await this.engine.endSession(this.sessionId)
  }

  // Appends a message to the on-disk transcript first, then to the
  // in-memory history, per the transcript-first discipline: nothing is
  // added to history until it is durably recorded.
  //
  // One clock read per appended message, and one only. That single instant
  // produces the transcript line's ts, its utcOffsetMinutes, and the
  // rendered stamp, so the value the model sees and the value on disk can
  // never disagree.
  //
  // Only user messages are stamped. An assistant or tool message is
  // produced within seconds of the user message that prompted it, so its
  // own time adds nothing the preceding user stamp does not already give,
  // and an assistant message that comes back carrying a bracket prefix it
  // did not write teaches the model to start emitting stamps into its own
  // replies to the person.
  private async appendBoth(message: SessionMessage): Promise<void> {
    const now = this.now()
    const timezone = this.engine.timezone()
    await this.engine.appendTranscript(this.sessionId, {
      ts: now.toISOString(),
      utcOffsetMinutes: utcOffsetMinutesFor(now, timezone),
      role: message.role,
      content: message.content,
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    })
    this.history.push(
      message.role === 'user'
        ? { ...message, content: `${renderLiveStamp(now, timezone)} ${message.content}` }
        : message,
    )
  }

  private resultHasError(result: string): boolean {
    try {
      const parsed = JSON.parse(result)
      return 'error' in parsed
    } catch {
      return false
    }
  }
}
