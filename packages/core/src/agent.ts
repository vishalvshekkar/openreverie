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

import type { MemoryEngine } from '@openreverie/memory'
import type { ChatProvider, ToolCall } from '@openreverie/providers'
import type { ReverieConfig } from './config.js'
import { assembleSystemPrompt } from './context.js'
import { dispatchTool, type ToolDeps, toolDefinitions } from './tools.js'

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'done' }

const MAX_TOOL_ROUNDS = 8

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

  private readonly toolDeps: ToolDeps | undefined
  private readonly config: ReverieConfig

  private constructor(
    engine: MemoryEngine,
    chat: ChatProvider,
    model: string,
    system: string,
    sessionId: string,
    toolDeps: ToolDeps | undefined,
    config: ReverieConfig,
  ) {
    this.engine = engine
    this.chat = chat
    this.model = model
    this.system = system
    this.sessionId = sessionId
    this.toolDeps = toolDeps
    this.config = config
  }

  static async start(
    engine: MemoryEngine,
    config: ReverieConfig,
    chat: ChatProvider,
    toolDeps?: ToolDeps,
  ): Promise<AgentSession> {
    const system = await assembleSystemPrompt(engine, config)
    const sessionId = await engine.startSession()
    return new AgentSession(engine, chat, config.models.chat, system, sessionId, toolDeps, config)
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

  private async *runTurn(userText: string): AsyncIterable<AgentEvent> {
    await this.appendBoth({ role: 'user', content: userText })

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
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

        const result = await dispatchTool(this.engine, this.sessionId, toolCall, this.toolDeps)

        // If update_style succeeds, reassemble the system prompt so the new
        // style applies immediately to subsequent requests.
        if (toolCall.name === 'update_style' && !this.resultHasError(result)) {
          const resultData = JSON.parse(result)
          this.config.style = resultData.style
          this.system = await assembleSystemPrompt(this.engine, this.config)
        }

        await this.appendBoth({ role: 'tool', content: result, toolCallId: toolCall.id })
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
  private async appendBoth(message: SessionMessage): Promise<void> {
    await this.engine.appendTranscript(this.sessionId, {
      ts: new Date().toISOString(),
      role: message.role,
      content: message.content,
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    })
    this.history.push(message)
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
