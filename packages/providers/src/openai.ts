// OpenAI chat and embedding adapters. This is the only place in the
// providers package (and the only place in the whole repo) that speaks the
// OpenAI HTTP API. Everything else consumes the ChatProvider and
// EmbeddingProvider interfaces from types.ts.

import type {
  ChatEvent,
  ChatMessage,
  ChatProvider,
  ChatRequest,
  ChatResult,
  EmbeddingProvider,
  FetchLike,
  ToolCall,
  ToolDefinition,
} from './types.js'

export interface OpenAiConfig {
  apiKey: string
  baseUrl?: string
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

interface OpenAiFunctionCall {
  name: string
  arguments: string
}

interface OpenAiToolCall {
  id: string
  type: 'function'
  function: OpenAiFunctionCall
}

interface OpenAiMessage {
  role: string
  content: string
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
}

interface OpenAiCompletionResponse {
  choices?: Array<{
    message?: {
      role: string
      content: string | null
      tool_calls?: OpenAiToolCall[] | null
    }
  }>
}

interface OpenAiStreamToolCallDelta {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: OpenAiStreamToolCallDelta[]
    }
    finish_reason?: string | null
  }>
}

function toOpenAiMessages(req: ChatRequest): OpenAiMessage[] {
  const messages: OpenAiMessage[] = []
  if (req.system) {
    messages.push({ role: 'system', content: req.system })
  }
  for (const m of req.messages) {
    messages.push(toOpenAiMessage(m))
  }
  return messages
}

function toOpenAiMessage(m: ChatMessage): OpenAiMessage {
  const message: OpenAiMessage = { role: m.role, content: m.content }
  if (m.toolCalls && m.toolCalls.length > 0) {
    message.tool_calls = m.toolCalls.map(toOpenAiToolCall)
  }
  if (m.toolCallId !== undefined) {
    message.tool_call_id = m.toolCallId
  }
  return message
}

function toOpenAiToolCall(tc: ToolCall): OpenAiToolCall {
  return { id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }
}

function toOpenAiTools(tools: ToolDefinition[] | undefined) {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

function buildRequestBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toOpenAiMessages(req),
    stream,
  }
  const tools = toOpenAiTools(req.tools)
  if (tools) body.tools = tools
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
  return body
}

async function requireOk(res: Response): Promise<void> {
  if (res.ok) return
  const text = await res.text()
  throw new Error(`openai: HTTP ${res.status}: ${text.slice(0, 200)}`)
}

function authHeaders(apiKey: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
}

export class OpenAiChatProvider implements ChatProvider {
  readonly name = 'openai'
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike

  constructor(cfg: OpenAiConfig, fetchImpl: FetchLike = fetch) {
    this.apiKey = cfg.apiKey
    this.baseUrl = cfg.baseUrl ?? DEFAULT_BASE_URL
    this.fetchImpl = fetchImpl
  }

  async complete(req: ChatRequest): Promise<ChatResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(this.apiKey),
      body: JSON.stringify(buildRequestBody(req, false)),
    })
    await requireOk(res)
    const data = (await res.json()) as OpenAiCompletionResponse
    const message = data.choices?.[0]?.message
    if (!message) {
      throw new Error('openai: response missing choices[0].message')
    }
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }))
    return { text: message.content ?? '', toolCalls }
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatEvent> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(this.apiKey),
      body: JSON.stringify(buildRequestBody(req, true)),
    })
    await requireOk(res)
    if (!res.body) {
      throw new Error('openai: streaming response has no body')
    }

    const pending = new Map<number, { id: string; name: string; arguments: string }>()

    function* flushPendingToolCalls(): Generator<ChatEvent> {
      for (const tc of pending.values()) {
        yield { type: 'tool_call', toolCall: { id: tc.id, name: tc.name, arguments: tc.arguments } }
      }
      pending.clear()
    }

    function applyToolCallDelta(delta: OpenAiStreamToolCallDelta): void {
      const existing = pending.get(delta.index)
      if (existing) {
        if (delta.function?.name) existing.name += delta.function.name
        if (delta.function?.arguments) existing.arguments += delta.function.arguments
        return
      }
      pending.set(delta.index, {
        id: delta.id ?? '',
        name: delta.function?.name ?? '',
        arguments: delta.function?.arguments ?? '',
      })
    }

    // Parses one SSE line and yields the events it produces. Returns true
    // when the line was `data: [DONE]`, which tells the caller the stream
    // is finished and no further lines (including a flushed tail buffer)
    // should be processed.
    function* processLine(rawLine: string): Generator<ChatEvent, boolean> {
      const line = rawLine.trim()
      if (!line.startsWith('data: ')) return false
      const payload = line.slice('data: '.length)
      if (payload === '[DONE]') {
        yield* flushPendingToolCalls()
        yield { type: 'done' }
        return true
      }
      const chunk = JSON.parse(payload) as OpenAiStreamChunk
      const choice = chunk.choices?.[0]
      if (!choice) return false

      if (choice.delta?.content) {
        yield { type: 'text', text: choice.delta.content }
      }
      for (const tcDelta of choice.delta?.tool_calls ?? []) {
        applyToolCallDelta(tcDelta)
      }
      if (choice.finish_reason) {
        yield* flushPendingToolCalls()
      }
      return false
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const rawLine of lines) {
          const finished = yield* processLine(rawLine)
          if (finished) return
        }
      }
    } finally {
      // Abort the in-flight request if the consumer never reached [DONE]
      // (an early `break` out of `for await` resumes here via the async
      // iterator's implicit `return()`, which runs this finally block).
      await reader.cancel().catch(() => {
        // Already errored or already closed; nothing left to abort.
      })
      reader.releaseLock()
    }

    // The read loop only exits here when the stream closed without ever
    // seeing `data: [DONE]`. Flush the decoder for any pending multi-byte
    // tail bytes and process whatever line remains unterminated in the
    // buffer, so its content isn't silently dropped.
    buffer += decoder.decode()
    if (buffer.trim().length > 0) {
      const finished = yield* processLine(buffer)
      if (finished) return
    }

    yield* flushPendingToolCalls()
    yield { type: 'done' }
  }
}

interface OpenAiEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>
}

const EMBEDDING_BATCH_SIZE = 100

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai'
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike

  constructor(cfg: OpenAiConfig, fetchImpl: FetchLike = fetch) {
    this.apiKey = cfg.apiKey
    this.baseUrl = cfg.baseUrl ?? DEFAULT_BASE_URL
    this.fetchImpl = fetchImpl
  }

  async embed(model: string, texts: string[]): Promise<number[][]> {
    const results: number[][] = []
    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE)
      const batchResults = await this.embedBatch(model, batch)
      results.push(...batchResults)
    }
    return results
  }

  private async embedBatch(model: string, texts: string[]): Promise<number[][]> {
    const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: authHeaders(this.apiKey),
      body: JSON.stringify({ model, input: texts }),
    })
    await requireOk(res)
    const data = (await res.json()) as OpenAiEmbeddingResponse
    return [...data.data].sort((a, b) => a.index - b.index).map((item) => item.embedding)
  }
}
