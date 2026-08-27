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
  EmbedResult,
  FetchLike,
  ToolCall,
  ToolDefinition,
  Usage,
} from './types.js'
import { ProviderUnavailableError } from './types.js'

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

interface OpenAiUsage {
  prompt_tokens: number
  completion_tokens: number
}

interface OpenAiCompletionResponse {
  choices?: Array<{
    message?: {
      role: string
      content: string | null
      tool_calls?: OpenAiToolCall[] | null
    }
  }>
  usage?: OpenAiUsage
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
  // Present only on the final chunk, and only because buildRequestBody
  // sends stream_options: { include_usage: true }. Every earlier chunk
  // still carries this key with value null (OpenAI's own shape), so a
  // check for the key merely being present would fire on every chunk;
  // callers must check for a non-null value instead.
  usage?: OpenAiUsage | null
}

function toUsage(model: string, usage: OpenAiUsage): Usage {
  return { model, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }
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

// dropTemperature exists only for the retry path in complete() below: the
// stream() path never needs it, since nothing in this codebase streams
// with a temperature set (grep confirms dreaming.ts's narrative call,
// which is complete()-only, is the sole caller that ever sets one).
function buildRequestBody(
  req: ChatRequest,
  stream: boolean,
  dropTemperature = false,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toOpenAiMessages(req),
    stream,
  }
  // OpenAI only includes a usage chunk in the SSE stream when this is set,
  // and only accepts the field at all on a streaming request: sending it
  // with stream: false is a 400. Gated on the stream flag, not always on.
  if (stream) body.stream_options = { include_usage: true }
  const tools = toOpenAiTools(req.tools)
  if (tools) body.tools = tools
  if (req.temperature !== undefined && !dropTemperature) body.temperature = req.temperature
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
  return body
}

function throwForStatus(status: number, bodyText: string): never {
  const message = `openai: HTTP ${status}: ${bodyText.slice(0, 200)}`
  if (status === 429 || status >= 500) throw new ProviderUnavailableError(message)
  throw new Error(message)
}

async function requireOk(res: Response): Promise<void> {
  if (res.ok) return
  const text = await res.text()
  throwForStatus(res.status, text)
}

interface OpenAiErrorBody {
  error?: { message?: string; param?: string; code?: string; type?: string }
}

// OpenAI's own structured error contract for a request parameter it will
// not accept for the given model: {"error":{"param":"temperature", ...}}.
// Detected from the response body itself, never from a list of model
// names or families: model naming is provider trivia, and AGENTS.md is
// explicit that nothing above the provider boundary may reach around the
// provider interfaces, which cuts both ways here, inside this file, too.
// This stays a fact about one HTTP response, not an assumption about which
// models exist.
function isUnsupportedTemperatureError(status: number, bodyText: string): boolean {
  if (status !== 400) return false
  let parsed: OpenAiErrorBody
  try {
    parsed = JSON.parse(bodyText) as OpenAiErrorBody
  } catch {
    return false
  }
  return parsed.error?.param === 'temperature'
}

async function parseCompletion(res: Response, model: string): Promise<ChatResult> {
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
  const result: ChatResult = { text: message.content ?? '', toolCalls }
  if (data.usage) {
    result.usage = toUsage(model, data.usage)
  }
  return result
}

const NETWORK_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
])

function isNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? error.code : undefined
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true
  const cause = 'cause' in error ? error.cause : undefined
  return cause !== error && isNetworkError(cause)
}

async function requestOpenAi(
  fetchImpl: FetchLike,
  input: Parameters<FetchLike>[0],
  init: Parameters<FetchLike>[1],
): Promise<Response> {
  try {
    return await fetchImpl(input, init)
  } catch (error) {
    if (error instanceof ProviderUnavailableError) throw error
    if (isNetworkError(error)) {
      throw new ProviderUnavailableError('openai: network connection failed')
    }
    throw error
  }
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
    const res = await requestOpenAi(this.fetchImpl, `${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(this.apiKey),
      body: JSON.stringify(buildRequestBody(req, false)),
    })
    if (res.ok) return parseCompletion(res, req.model)

    const bodyText = await res.text()

    // temperature is a preference, not a hard requirement of the caller's
    // request: a caller that asked for one (only dreaming's narrative
    // call does, deliberately, for a looser register; see
    // docs/dreaming.md) still gets a real answer when this model will not
    // accept it, rather than a hard failure. The retry is marked on the
    // result via ChatResult.warnings so the decision to drop it stays
    // visible to whatever the caller does with it (dreaming records it
    // into the dream's own process.jsonl), instead of silently vanishing,
    // which is the exact class of bug the model-fallback defect this fix
    // sits next to already was.
    if (req.temperature !== undefined && isUnsupportedTemperatureError(res.status, bodyText)) {
      const retryRes = await requestOpenAi(this.fetchImpl, `${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: authHeaders(this.apiKey),
        body: JSON.stringify(buildRequestBody(req, false, true)),
      })
      await requireOk(retryRes)
      const result = await parseCompletion(retryRes, req.model)
      return {
        ...result,
        warnings: [
          `temperature ${req.temperature} was not accepted for model ${req.model} and was dropped; retried without it`,
        ],
      }
    }

    throwForStatus(res.status, bodyText)
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatEvent> {
    const res = await requestOpenAi(this.fetchImpl, `${this.baseUrl}/chat/completions`, {
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
      // Checked before the `!choice` guard below: the chunk carrying usage
      // is the one OpenAI sends with an empty choices array (stream_options:
      // { include_usage: true } adds one extra chunk after the content is
      // already finished, not fields on an existing content chunk), so a
      // check placed after that guard would see this chunk as having no
      // choice and drop it entirely. Every earlier chunk carries `usage:
      // null` rather than omitting the key, so this must check for a
      // non-null value, not merely for the key's presence.
      if (chunk.usage != null) {
        yield { type: 'usage', usage: toUsage(req.model, chunk.usage) }
      }
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
  usage?: { prompt_tokens: number; total_tokens: number }
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

  async embed(model: string, texts: string[]): Promise<EmbedResult> {
    const vectors: number[][] = []
    // Summed across every batch, not just reported from the first: a
    // request over EMBEDDING_BATCH_SIZE texts fans out into more than one
    // HTTP call, and a usage total that only reflects one of them would be
    // a fabricated count presented as the whole, not a smaller true count.
    let inputTokens = 0
    let everyBatchReportedUsage = true
    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE)
      const batchResult = await this.embedBatch(model, batch)
      vectors.push(...batchResult.vectors)
      if (batchResult.usage) {
        inputTokens += batchResult.usage.inputTokens
      } else {
        everyBatchReportedUsage = false
      }
    }
    // A partial sum is worse than no number at all: omit usage entirely
    // rather than report a total that silently excludes a batch the
    // response did not carry usage for.
    if (everyBatchReportedUsage) {
      return { vectors, usage: { model, inputTokens, outputTokens: 0 } }
    }
    return { vectors }
  }

  private async embedBatch(model: string, texts: string[]): Promise<EmbedResult> {
    const res = await requestOpenAi(this.fetchImpl, `${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: authHeaders(this.apiKey),
      body: JSON.stringify({ model, input: texts }),
    })
    await requireOk(res)
    const data = (await res.json()) as OpenAiEmbeddingResponse
    const vectors = [...data.data].sort((a, b) => a.index - b.index).map((item) => item.embedding)
    // Embeddings have no completion, so outputTokens is always 0: this is
    // a fact about what an embedding call is, not a gap in what OpenAI
    // reports (its embeddings usage object never has a completion_tokens
    // field at all).
    if (data.usage) {
      return { vectors, usage: { model, inputTokens: data.usage.prompt_tokens, outputTokens: 0 } }
    }
    return { vectors }
  }
}
