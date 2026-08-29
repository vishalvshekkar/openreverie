import { describe, expect, it } from 'vitest'
import { createChatProvider, createEmbeddingProvider, type ProviderSelection } from './factory.js'
import { OpenAiChatProvider, OpenAiEmbeddingProvider } from './openai.js'
import type { FetchLike } from './types.js'

interface RecordedCall {
  url: string
  init: RequestInit | undefined
}

// prompt_tokens is the sum of the batch's own text lengths: deterministic,
// and different per batch, so a test that sums it across two batches can
// tell a correct sum apart from one batch's number reported alone.
function batchPromptTokens(texts: string[]): number {
  return texts.reduce((sum, t) => sum + t.length, 0)
}

function fakeEmbeddingFetch(): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init })
    const body = JSON.parse(String(init?.body)) as { input: string[] }
    // Tag each item with its true batch-local position via `index`, but
    // return the array itself out of order, to prove embed() sorts by
    // index rather than trusting response array order.
    const items = body.input.map((text, i) => ({ index: i, embedding: [text.length, i] }))
    const data = [...items].reverse()
    const usage = {
      prompt_tokens: batchPromptTokens(body.input),
      total_tokens: batchPromptTokens(body.input),
    }
    return new Response(JSON.stringify({ data, usage }), { status: 200 })
  }
  return { fetch: fetchImpl, calls }
}

describe('OpenAiEmbeddingProvider.embed', () => {
  it('posts model and input, and orders results by data[i].index', async () => {
    const { fetch, calls } = fakeEmbeddingFetch()
    const provider = new OpenAiEmbeddingProvider({ apiKey: 'sk-test' }, fetch)

    const result = await provider.embed('text-embedding-3-small', ['a', 'bb', 'ccc'])

    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (!call) throw new Error('expected a recorded call')
    expect(call.url).toBe('https://api.openai.com/v1/embeddings')
    const body = JSON.parse(String(call.init?.body))
    expect(body.model).toBe('text-embedding-3-small')
    expect(body.input).toEqual(['a', 'bb', 'ccc'])
    // The fake returns entries in reverse order; embed must use each
    // entry's index field to restore the original input order.
    expect(result.vectors).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ])
    expect(result.usage).toEqual({
      model: 'text-embedding-3-small',
      inputTokens: 6,
      outputTokens: 0,
    })
  })

  it('batches over 100 texts, preserves order across batches, and sums usage across both', async () => {
    const { fetch, calls } = fakeEmbeddingFetch()
    const provider = new OpenAiEmbeddingProvider({ apiKey: 'sk-test' }, fetch)
    const texts = Array.from({ length: 150 }, (_, i) => `text-${i}`)

    const result = await provider.embed('text-embedding-3-small', texts)

    expect(calls).toHaveLength(2)
    const firstBody = JSON.parse(String(calls[0]?.init?.body))
    const secondBody = JSON.parse(String(calls[1]?.init?.body))
    expect(firstBody.input).toHaveLength(100)
    expect(secondBody.input).toHaveLength(50)
    expect(firstBody.input).toEqual(texts.slice(0, 100))
    expect(secondBody.input).toEqual(texts.slice(100))

    expect(result.vectors).toHaveLength(150)
    // Each embedding's second component is the within-batch position it
    // reordered from; the length component reveals which text produced it.
    result.vectors.forEach((embedding, i) => {
      expect(embedding[0]).toBe(texts[i]?.length)
    })

    // The true total is both batches' token counts added together, not
    // either one alone: proves embed() sums across every batch instead of
    // reporting only the last (or first) response's usage.
    const expectedTokens =
      batchPromptTokens(texts.slice(0, 100)) + batchPromptTokens(texts.slice(100))
    expect(result.usage).toEqual({
      model: 'text-embedding-3-small',
      inputTokens: expectedTokens,
      outputTokens: 0,
    })
  })

  it('omits usage entirely rather than report a partial sum, when one batch response carries no usage', async () => {
    const texts = Array.from({ length: 150 }, (_, i) => `text-${i}`)
    let callCount = 0
    const fetchImpl: FetchLike = async (_input, init) => {
      callCount += 1
      const body = JSON.parse(String(init?.body)) as { input: string[] }
      const data = body.input.map((text, i) => ({ index: i, embedding: [text.length, i] }))
      // Only the first batch's response carries a usage field, as if a
      // proxy stripped it from the second: a total built only from what
      // the first call reported would be a fabricated whole, not a
      // smaller true count, so the caller must get no number at all.
      const usage =
        callCount === 1
          ? { prompt_tokens: batchPromptTokens(body.input), total_tokens: 0 }
          : undefined
      return new Response(JSON.stringify({ data, ...(usage ? { usage } : {}) }), { status: 200 })
    }
    const provider = new OpenAiEmbeddingProvider({ apiKey: 'sk-test' }, fetchImpl)

    const result = await provider.embed('text-embedding-3-small', texts)

    expect(callCount).toBe(2)
    expect(result.usage).toBeUndefined()
  })

  it('throws with status and truncated body on a non-2xx response', async () => {
    const longBody = `bad request ${'z'.repeat(300)}`
    const fetchImpl: FetchLike = async () => new Response(longBody, { status: 400 })
    const provider = new OpenAiEmbeddingProvider({ apiKey: 'sk-test' }, fetchImpl)

    await expect(provider.embed('text-embedding-3-small', ['x'])).rejects.toThrow(
      `openai: HTTP 400: ${longBody.slice(0, 200)}`,
    )
  })
})

describe('createChatProvider', () => {
  it('returns an OpenAiChatProvider for provider "openai"', () => {
    const sel: ProviderSelection = { provider: 'openai', apiKey: 'sk-test' }
    const provider = createChatProvider(sel)
    expect(provider).toBeInstanceOf(OpenAiChatProvider)
    expect(provider.name).toBe('openai')
  })

  it('throws on an unknown provider', () => {
    const sel = { provider: 'anthropic', apiKey: 'sk-test' } as unknown as ProviderSelection
    expect(() => createChatProvider(sel)).toThrow('unknown provider: anthropic')
  })

  it('threads the selection headers through to the outgoing request', async () => {
    const calls: Array<RequestInit | undefined> = []
    const fetchImpl: FetchLike = async (_input, init) => {
      calls.push(init)
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        { status: 200 },
      )
    }
    const sel: ProviderSelection = {
      provider: 'openai',
      apiKey: 'sk-test',
      headers: { 'cf-aig-collect-log-payload': 'false' },
    }
    const provider = createChatProvider(sel, fetchImpl)

    await provider.complete({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })

    expect(calls[0]?.headers).toEqual({
      'cf-aig-collect-log-payload': 'false',
      'content-type': 'application/json',
      authorization: 'Bearer sk-test',
    })
  })
})

describe('createEmbeddingProvider', () => {
  it('returns an OpenAiEmbeddingProvider for provider "openai"', () => {
    const sel: ProviderSelection = { provider: 'openai', apiKey: 'sk-test' }
    const provider = createEmbeddingProvider(sel)
    expect(provider).toBeInstanceOf(OpenAiEmbeddingProvider)
    expect(provider.name).toBe('openai')
  })

  it('throws on an unknown provider', () => {
    const sel = { provider: 'openrouter', apiKey: 'sk-test' } as unknown as ProviderSelection
    expect(() => createEmbeddingProvider(sel)).toThrow('unknown provider: openrouter')
  })
})
