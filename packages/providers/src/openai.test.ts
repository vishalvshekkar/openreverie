import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OpenAiChatProvider, OpenAiEmbeddingProvider } from './openai.js'
import {
  type ChatEvent,
  type ChatRequest,
  type FetchLike,
  ProviderUnavailableError,
  type ToolCall,
} from './types.js'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const streamFixture = readFileSync(join(fixtureDir, 'openai-stream.txt'), 'utf8')

function sseStreamFor(section: 'text' | 'toolCall'): ReadableStream<Uint8Array> {
  const [textPart, toolCallPart] = streamFixture.split('===TOOL_CALL===\n')
  const body = section === 'text' ? textPart : toolCallPart
  if (!body) {
    throw new Error(`fixture missing section: ${section}`)
  }
  const encoded = new TextEncoder().encode(body)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded)
      controller.close()
    },
  })
}

interface RecordedCall {
  url: string
  init: RequestInit | undefined
}

function fakeFetch(response: Response): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init })
    return response
  }
  return { fetch: fetchImpl, calls }
}

// One response per call, in order, for tests that exercise a retry: the
// plain fakeFetch above always returns the same Response, which cannot
// express "the first call gets a 400, the second gets a 200".
function fakeFetchSequence(responses: Response[]): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let cursor = 0
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init })
    const response = responses[cursor]
    if (!response) throw new Error('fakeFetchSequence: no response scripted for this call')
    cursor += 1
    return response
  }
  return { fetch: fetchImpl, calls }
}

// The real body OpenAI returns when a model rejects a temperature other
// than its default (captured live on 2026-08-25 against gpt-5, truncated
// to the fields this file's detection actually reads).
function temperatureRejectionBody(): string {
  return JSON.stringify({
    error: {
      message:
        "Unsupported value: 'temperature' does not support 0.9 with this model. Only the default (1) value is supported.",
      type: 'invalid_request_error',
      param: 'temperature',
      code: 'unsupported_value',
    },
  })
}

const baseRequest: ChatRequest = {
  model: 'gpt-4o-mini',
  system: 'You are a helpful companion.',
  messages: [{ role: 'user', content: 'hi there' }],
}

describe('OpenAiChatProvider.complete', () => {
  it('POSTs to /chat/completions with mapped request body', async () => {
    const canned = new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'hello back', tool_calls: null } }],
      }),
      { status: 200 },
    )
    const { fetch, calls } = fakeFetch(canned)
    const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

    const result = await provider.complete(baseRequest)

    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (!call) throw new Error('expected a recorded call')
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions')
    const body = JSON.parse(String(call.init?.body))
    expect(body.model).toBe('gpt-4o-mini')
    expect(body.stream).toBe(false)
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are a helpful companion.' },
      { role: 'user', content: 'hi there' },
    ])
    expect(result).toEqual({ text: 'hello back', toolCalls: [] })
  })

  it('respects a custom baseUrl', async () => {
    const canned = new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
      { status: 200 },
    )
    const { fetch, calls } = fakeFetch(canned)
    const provider = new OpenAiChatProvider(
      { apiKey: 'sk-test', baseUrl: 'https://proxy.local/v1' },
      fetch,
    )

    await provider.complete(baseRequest)

    const call = calls[0]
    if (!call) throw new Error('expected a recorded call')
    expect(call.url).toBe('https://proxy.local/v1/chat/completions')
  })

  it('maps tool definitions and prior tool calls into OpenAI shapes', async () => {
    const canned = new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' } }] }),
      { status: 200 },
    )
    const { fetch, calls } = fakeFetch(canned)
    const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

    const toolCall: ToolCall = { id: 'call_1', name: 'search_memory', arguments: '{"query":"x"}' }
    const req: ChatRequest = {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'assistant', content: '', toolCalls: [toolCall] },
        { role: 'tool', content: 'result text', toolCallId: 'call_1' },
      ],
      tools: [
        {
          name: 'search_memory',
          description: 'Search the memory index',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
    }

    await provider.complete(req)

    const call = calls[0]
    if (!call) throw new Error('expected a recorded call')
    const body = JSON.parse(String(call.init?.body))
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'search_memory',
          description: 'Search the memory index',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
    ])
    expect(body.messages[0]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'search_memory', arguments: '{"query":"x"}' },
        },
      ],
    })
    expect(body.messages[1]).toEqual({
      role: 'tool',
      content: 'result text',
      tool_call_id: 'call_1',
    })
  })

  it('maps a response tool call back to ChatResult', async () => {
    const canned = new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_9',
                  type: 'function',
                  function: { name: 'search_memory', arguments: '{"q":"hi"}' },
                },
              ],
            },
          },
        ],
      }),
      { status: 200 },
    )
    const { fetch } = fakeFetch(canned)
    const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

    const result = await provider.complete(baseRequest)

    expect(result).toEqual({
      text: '',
      toolCalls: [{ id: 'call_9', name: 'search_memory', arguments: '{"q":"hi"}' }],
    })
  })

  it('throws with status and truncated body on a non-2xx response', async () => {
    const longBody = `unauthorized ${'x'.repeat(300)}`
    const canned = new Response(longBody, { status: 401 })
    const { fetch } = fakeFetch(canned)
    const provider = new OpenAiChatProvider({ apiKey: 'sk-bad' }, fetch)

    await expect(provider.complete(baseRequest)).rejects.toThrow(
      `openai: HTTP 401: ${longBody.slice(0, 200)}`,
    )
  })

  // Found live on 2026-08-25: gpt-5 (a reasoning model) rejects any
  // temperature other than its default with exactly this 400 shape.
  // temperature is a preference, not a hard requirement, so this must not
  // fail the call outright when the caller asked for one.
  describe('a request with temperature set, against a model that rejects it', () => {
    const withTemperature: ChatRequest = { ...baseRequest, temperature: 0.9 }

    it('retries once without temperature and returns the retried answer', async () => {
      const { fetch, calls } = fakeFetchSequence([
        new Response(temperatureRejectionBody(), { status: 400 }),
        new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'a dream' } }] }),
          { status: 200 },
        ),
      ])
      const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

      const result = await provider.complete(withTemperature)

      expect(result.text).toBe('a dream')
      expect(calls).toHaveLength(2)
      const firstBody = JSON.parse(String(calls[0]?.init?.body))
      expect(firstBody.temperature).toBe(0.9)
      const secondBody = JSON.parse(String(calls[1]?.init?.body))
      expect(secondBody.temperature).toBeUndefined()
    })

    it('carries configured headers on the retried request too, not just the first attempt', async () => {
      const { fetch, calls } = fakeFetchSequence([
        new Response(temperatureRejectionBody(), { status: 400 }),
        new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'a dream' } }] }),
          { status: 200 },
        ),
      ])
      const provider = new OpenAiChatProvider({ apiKey: 'sk-test', headers: gatewayHeaders }, fetch)

      await provider.complete(withTemperature)

      expect(calls).toHaveLength(2)
      const expectedHeaders = {
        ...gatewayHeaders,
        'content-type': 'application/json',
        authorization: 'Bearer sk-test',
      }
      expect(calls[0]?.init?.headers).toEqual(expectedHeaders)
      expect(calls[1]?.init?.headers).toEqual(expectedHeaders)
    })

    it('marks the result with a warning naming the dropped temperature, so the decision is not silent', async () => {
      const { fetch } = fakeFetchSequence([
        new Response(temperatureRejectionBody(), { status: 400 }),
        new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'a dream' } }] }),
          { status: 200 },
        ),
      ])
      const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

      const result = await provider.complete(withTemperature)

      expect(result.warnings).toHaveLength(1)
      expect(result.warnings?.[0]).toContain('0.9')
      expect(result.warnings?.[0]).toContain('gpt-4o-mini')
    })

    it('never retries, and carries no warnings, when the caller did not ask for a temperature at all', async () => {
      const { fetch, calls } = fakeFetch(new Response(temperatureRejectionBody(), { status: 400 }))
      const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

      await expect(provider.complete(baseRequest)).rejects.toThrow(/HTTP 400/)
      expect(calls).toHaveLength(1)
    })

    it('does not retry, and surfaces the original error, for a 400 that is not the temperature shape', async () => {
      const otherBadRequest = JSON.stringify({
        error: { message: 'model not found', type: 'invalid_request_error', param: 'model' },
      })
      const { fetch, calls } = fakeFetch(new Response(otherBadRequest, { status: 400 }))
      const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

      await expect(provider.complete(withTemperature)).rejects.toThrow('model not found')
      expect(calls).toHaveLength(1)
    })

    it('does not retry a 400 whose body is not valid JSON at all', async () => {
      const { fetch, calls } = fakeFetch(new Response('not json', { status: 400 }))
      const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

      await expect(provider.complete(withTemperature)).rejects.toThrow(/HTTP 400/)
      expect(calls).toHaveLength(1)
    })

    it('still classifies a genuine outage on the retry itself as ProviderUnavailableError', async () => {
      const { fetch } = fakeFetchSequence([
        new Response(temperatureRejectionBody(), { status: 400 }),
        new Response('service unavailable', { status: 503 }),
      ])
      const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

      await expect(provider.complete(withTemperature)).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      )
    })
  })

  it('classifies a socket error code as a provider outage', async () => {
    const networkError = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
    const fetch: FetchLike = async () => {
      throw networkError
    }
    const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

    await expect(provider.complete(baseRequest)).rejects.toBeInstanceOf(ProviderUnavailableError)
  })

  it('classifies a service response as a provider outage', async () => {
    const { fetch } = fakeFetch(new Response('service unavailable', { status: 503 }))
    const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

    await expect(provider.complete(baseRequest)).rejects.toBeInstanceOf(ProviderUnavailableError)
  })
})

describe('token usage (P0-4)', () => {
  it('complete() carries usage from the response body, tagged with the requested model', async () => {
    const canned = new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'hello back' } }],
        usage: { prompt_tokens: 14, completion_tokens: 5 },
      }),
      { status: 200 },
    )
    const { fetch } = fakeFetch(canned)
    const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

    const result = await provider.complete(baseRequest)

    expect(result.usage).toEqual({ model: 'gpt-4o-mini', inputTokens: 14, outputTokens: 5 })
  })

  it('complete() carries no usage field when the response has none', async () => {
    const canned = new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello back' } }] }),
      { status: 200 },
    )
    const { fetch } = fakeFetch(canned)
    const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

    const result = await provider.complete(baseRequest)

    expect(result.usage).toBeUndefined()
  })

  it('stream() sends stream_options.include_usage, and complete() sends no such field', async () => {
    const streamCanned = new Response(sseStreamFor('text'), { status: 200 })
    const { fetch: streamFetch, calls: streamCalls } = fakeFetch(streamCanned)
    const streamProvider = new OpenAiChatProvider({ apiKey: 'sk-test' }, streamFetch)
    const events: ChatEvent[] = []
    for await (const event of streamProvider.stream(baseRequest)) events.push(event)
    const streamBody = JSON.parse(String(streamCalls[0]?.init?.body))
    expect(streamBody.stream_options).toEqual({ include_usage: true })

    const completeCanned = new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
      { status: 200 },
    )
    const { fetch: completeFetch, calls: completeCalls } = fakeFetch(completeCanned)
    const completeProvider = new OpenAiChatProvider({ apiKey: 'sk-test' }, completeFetch)
    await completeProvider.complete(baseRequest)
    const completeBody = JSON.parse(String(completeCalls[0]?.init?.body))
    expect(completeBody.stream_options).toBeUndefined()
  })
})

describe('OpenAiChatProvider.stream', () => {
  it('emits text events reassembled from SSE chunks, then done', async () => {
    const canned = new Response(sseStreamFor('text'), { status: 200 })
    const { fetch } = fakeFetch(canned)
    const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

    const events: ChatEvent[] = []
    for await (const event of provider.stream(baseRequest)) events.push(event)

    expect(events).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ', world!' },
      { type: 'usage', usage: { model: 'gpt-4o-mini', inputTokens: 12, outputTokens: 3 } },
      { type: 'done' },
    ])
  })

  it('reassembles a tool call whose arguments arrive split across chunks', async () => {
    const canned = new Response(sseStreamFor('toolCall'), { status: 200 })
    const { fetch } = fakeFetch(canned)
    const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

    const events: ChatEvent[] = []
    for await (const event of provider.stream(baseRequest)) events.push(event)

    expect(events).toHaveLength(3)
    const [toolCallEvent, usageEvent, doneEvent] = events
    if (toolCallEvent?.type !== 'tool_call') throw new Error('expected a tool_call event first')
    expect(toolCallEvent.toolCall.id).toBe('call_abc123')
    expect(toolCallEvent.toolCall.name).toBe('search_memory')
    expect(JSON.parse(toolCallEvent.toolCall.arguments)).toEqual({ query: 'memory lane' })
    expect(usageEvent).toEqual({
      type: 'usage',
      usage: { model: 'gpt-4o-mini', inputTokens: 20, outputTokens: 8 },
    })
    expect(doneEvent).toEqual({ type: 'done' })
  })

  it('throws with status and truncated body on a non-2xx response', async () => {
    const longBody = `rate limited ${'y'.repeat(300)}`
    const canned = new Response(longBody, { status: 429 })
    const { fetch } = fakeFetch(canned)
    const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

    const drain = async () => {
      for await (const _event of provider.stream(baseRequest)) {
        // draining is the point: the throw must happen before any event
      }
    }

    const error = await drain().catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ProviderUnavailableError)
    expect((error as Error).message).toBe(`openai: HTTP 429: ${longBody.slice(0, 200)}`)
  })

  it('reassembles a data: line whose bytes are split across two read chunks', async () => {
    const body =
      'data: {"choices":[{"index":0,"delta":{"content":"Hello, world!"},"finish_reason":null}]}\n\n' +
      'data: [DONE]\n'
    const encoded = new TextEncoder().encode(body)
    // Cut mid-way through the JSON payload, well clear of any line boundary,
    // so the split lands at an awkward byte position inside the data: line.
    const splitAt = 42
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, splitAt))
        controller.enqueue(encoded.slice(splitAt))
        controller.close()
      },
    })
    const canned = new Response(stream, { status: 200 })
    const { fetch } = fakeFetch(canned)
    const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

    const events: ChatEvent[] = []
    for await (const event of provider.stream(baseRequest)) events.push(event)

    expect(events).toEqual([{ type: 'text', text: 'Hello, world!' }, { type: 'done' }])
  })

  it('flushes a final data: line that has no trailing newline and no [DONE]', async () => {
    const body = 'data: {"choices":[{"index":0,"delta":{"content":"tail"},"finish_reason":null}]}'
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    })
    const canned = new Response(stream, { status: 200 })
    const { fetch } = fakeFetch(canned)
    const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

    const events: ChatEvent[] = []
    for await (const event of provider.stream(baseRequest)) events.push(event)

    expect(events).toEqual([{ type: 'text', text: 'tail' }, { type: 'done' }])
  })

  it('cancels the reader when the consumer breaks out of the iterator early', async () => {
    let cancelled = false
    const firstChunk =
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n'
    // Deliberately never close or enqueue further chunks: the stream stays
    // open past the first event so an early `break` must actively cancel
    // it, rather than merely draining an already-closed stream.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(firstChunk))
      },
      cancel() {
        cancelled = true
      },
    })
    const canned = new Response(stream, { status: 200 })
    const { fetch } = fakeFetch(canned)
    const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

    const events: ChatEvent[] = []
    for await (const event of provider.stream(baseRequest)) {
      events.push(event)
      break
    }

    expect(events).toEqual([{ type: 'text', text: 'Hello' }])
    expect(cancelled).toBe(true)
  })
})

// A canned embeddings response, just enough for OpenAiEmbeddingProvider.embed
// to resolve without throwing: these tests only care about the outgoing
// request headers, not the parsed result.
function fakeEmbeddingResponse(): Response {
  return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }), {
    status: 200,
  })
}

const gatewayHeaders = {
  'cf-aig-collect-log-payload': 'false',
  'cf-aig-metadata': '{"user":"abc123"}',
}

describe('OpenAiConfig.headers (provider-gateway headers)', () => {
  it('complete() sends exactly the two headers it sends today, when no headers are configured', async () => {
    const canned = new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
      { status: 200 },
    )
    const { fetch, calls } = fakeFetch(canned)
    const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

    await provider.complete(baseRequest)

    expect(calls[0]?.init?.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer sk-test',
    })
  })

  it('embed() sends exactly the two headers it sends today, when no headers are configured', async () => {
    const { fetch, calls } = fakeFetch(fakeEmbeddingResponse())
    const provider = new OpenAiEmbeddingProvider({ apiKey: 'sk-test' }, fetch)

    await provider.embed('text-embedding-3-small', ['hi'])

    expect(calls[0]?.init?.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer sk-test',
    })
  })

  it('complete() carries configured headers alongside the fixed pair', async () => {
    const canned = new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
      { status: 200 },
    )
    const { fetch, calls } = fakeFetch(canned)
    const provider = new OpenAiChatProvider({ apiKey: 'sk-test', headers: gatewayHeaders }, fetch)

    await provider.complete(baseRequest)

    expect(calls[0]?.init?.headers).toEqual({
      ...gatewayHeaders,
      'content-type': 'application/json',
      authorization: 'Bearer sk-test',
    })
  })

  it('stream() carries configured headers alongside the fixed pair', async () => {
    const canned = new Response(sseStreamFor('text'), { status: 200 })
    const { fetch, calls } = fakeFetch(canned)
    const provider = new OpenAiChatProvider({ apiKey: 'sk-test', headers: gatewayHeaders }, fetch)

    for await (const _event of provider.stream(baseRequest)) {
      // draining is enough; this test only inspects the outgoing request
    }

    expect(calls[0]?.init?.headers).toEqual({
      ...gatewayHeaders,
      'content-type': 'application/json',
      authorization: 'Bearer sk-test',
    })
  })

  it('embed() carries configured headers alongside the fixed pair', async () => {
    const { fetch, calls } = fakeFetch(fakeEmbeddingResponse())
    const provider = new OpenAiEmbeddingProvider(
      { apiKey: 'sk-test', headers: gatewayHeaders },
      fetch,
    )

    await provider.embed('text-embedding-3-small', ['hi'])

    expect(calls[0]?.init?.headers).toEqual({
      ...gatewayHeaders,
      'content-type': 'application/json',
      authorization: 'Bearer sk-test',
    })
  })

  it('a configured header trying to override authorization or content-type does not win', async () => {
    const canned = new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
      { status: 200 },
    )
    const { fetch, calls } = fakeFetch(canned)
    const provider = new OpenAiChatProvider(
      {
        apiKey: 'sk-test',
        headers: { authorization: 'Bearer attacker-supplied', 'content-type': 'text/evil' },
      },
      fetch,
    )

    await provider.complete(baseRequest)

    // The real API key and the real content type must survive: a host
    // header can never clobber authentication or the content type this
    // file depends on, even though nothing in the gateway headers this
    // feature exists for would ever collide with these two in practice.
    expect(calls[0]?.init?.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer sk-test',
    })
  })
})
