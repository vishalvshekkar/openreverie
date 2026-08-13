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

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'done' }

export interface ChatResult {
  text: string
  toolCalls: ToolCall[]
}

export interface ChatProvider {
  readonly name: string
  complete(req: ChatRequest): Promise<ChatResult>
  stream(req: ChatRequest): AsyncIterable<ChatEvent>
}

export interface EmbeddingProvider {
  readonly name: string
  embed(model: string, texts: string[]): Promise<number[][]>
}

export type FetchLike = typeof fetch
