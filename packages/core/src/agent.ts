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
import { dispatchTool, toolDefinitions } from './tools.js'

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
  private readonly system: string
  private readonly history: SessionMessage[] = []
  private ended = false

  private constructor(
    engine: MemoryEngine,
    chat: ChatProvider,
    model: string,
    system: string,
    sessionId: string,
  ) {
    this.engine = engine
    this.chat = chat
    this.model = model
    this.system = system
    this.sessionId = sessionId
  }

  static async start(
    engine: MemoryEngine,
    config: ReverieConfig,
    chat: ChatProvider,
  ): Promise<AgentSession> {
    const system = await assembleSystemPrompt(engine, config)
    const sessionId = await engine.startSession()
    return new AgentSession(engine, chat, config.models.chat, system, sessionId)
  }

  async *send(userText: string): AsyncIterable<AgentEvent> {
    await this.appendBoth({ role: 'user', content: userText })

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let text = ''
      const toolCalls: ToolCall[] = []

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

      if (toolCalls.length === 0) {
        await this.appendBoth({ role: 'assistant', content: text })
        yield { type: 'done' }
        return
      }

      let first = true
      for (const toolCall of toolCalls) {
        yield { type: 'tool', name: toolCall.name }
        await this.appendBoth({
          role: 'assistant',
          content: first ? text : '',
          toolCalls: [toolCall],
        })
        first = false

        const result = await dispatchTool(this.engine, this.sessionId, toolCall)
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
}
