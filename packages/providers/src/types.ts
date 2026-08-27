// Chat and embedding provider interfaces, and the message and tool types
// they operate on. These are the boundary every other package depends on.
// Only @openreverie/providers may talk to a vendor API; everything else
// consumes these interfaces.

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface ChatMessage {
  role: Role
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ChatRequest {
  model: string
  system?: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  temperature?: number
  maxTokens?: number
}

// Token counts for one model call. Reverie Cloud bills on tokens, and this
// is the only place in the system a count can come from: the model
// provider is the one party that actually knows what it charged for.
// `model` rides along because a single ChatProvider can be asked to serve
// more than one model (ChatRequest.model varies per call), so a usage
// number without the model it was measured against is not attributable to
// anything.
export interface Usage {
  model: string
  inputTokens: number
  outputTokens: number
}

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'done' }

export interface ChatResult {
  text: string
  toolCalls: ToolCall[]
  // Set when the provider could not honor part of the request as asked and
  // adjusted it to get a real answer back, rather than failing the call
  // outright. Optional and absent on the ordinary path: a caller that never
  // reads it loses nothing, but one that cares (dreaming's own process.jsonl
  // is the reason this field exists) can make an otherwise-silent provider
  // decision inspectable instead of invisible.
  warnings?: string[]
  // Token counts for this call, when the provider can report them.
  // Optional, the same way warnings is: a provider that cannot report
  // usage (a fake in a test, a proxy that strips it) is still a valid
  // ChatResult. Nothing in this package meters or enforces a limit on
  // this number; it exists so a caller that wants to (Reverie Cloud's own
  // ChatProvider wrapper) has somewhere to read it from.
  usage?: Usage
}

export interface ChatProvider {
  readonly name: string
  complete(req: ChatRequest): Promise<ChatResult>
  stream(req: ChatRequest): AsyncIterable<ChatEvent>
}

// The return shape for EmbeddingProvider.embed. `vectors` stays a bare
// number[][] in the same order as the input texts, exactly what every
// caller already destructures into a single vector or feeds straight to
// an index. `usage` sits alongside it rather than the vectors and the
// count being two separate return values, because they describe one
// call and belong together; a named field beats a tuple here since
// `result.vectors` at a call site says what it is without the reader
// having to remember position. `usage` is optional for the same reason
// ChatResult.usage is: a provider that cannot report it (a fake, a proxy
// that strips it) still returns a valid EmbedResult.
export interface EmbedResult {
  vectors: number[][]
  usage?: Usage
}

export interface EmbeddingProvider {
  readonly name: string
  embed(model: string, texts: string[]): Promise<EmbedResult>
}

export class ProviderUnavailableError extends Error {
  constructor(message = 'The model provider is unavailable.') {
    super(message)
    this.name = 'ProviderUnavailableError'
  }
}

export type FetchLike = typeof fetch
