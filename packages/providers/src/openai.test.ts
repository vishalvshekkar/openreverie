import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OpenAiChatProvider } from './openai.js'
import type { ChatEvent, ChatRequest, FetchLike, ToolCall } from './types.js'

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
      { type: 'done' },
    ])
  })

  it('reassembles a tool call whose arguments arrive split across chunks', async () => {
    const canned = new Response(sseStreamFor('toolCall'), { status: 200 })
    const { fetch } = fakeFetch(canned)
    const provider = new OpenAiChatProvider({ apiKey: 'sk-test' }, fetch)

    const events: ChatEvent[] = []
    for await (const event of provider.stream(baseRequest)) events.push(event)

    expect(events).toHaveLength(2)
    const [toolCallEvent, doneEvent] = events
    if (toolCallEvent?.type !== 'tool_call') throw new Error('expected a tool_call event first')
    expect(toolCallEvent.toolCall.id).toBe('call_abc123')
    expect(toolCallEvent.toolCall.name).toBe('search_memory')
    expect(JSON.parse(toolCallEvent.toolCall.arguments)).toEqual({ query: 'memory lane' })
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

    await expect(drain()).rejects.toThrow(`openai: HTTP 429: ${longBody.slice(0, 200)}`)
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
