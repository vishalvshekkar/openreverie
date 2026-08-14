import { describe, expect, it } from 'vitest'
import { createChatProvider, createEmbeddingProvider, type ProviderSelection } from './factory.js'
import { OpenAiChatProvider, OpenAiEmbeddingProvider } from './openai.js'
import type { FetchLike } from './types.js'

interface RecordedCall {
  url: string
  init: RequestInit | undefined
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
    return new Response(JSON.stringify({ data }), { status: 200 })
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
    expect(result).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ])
  })

  it('batches over 100 texts and preserves order across batches', async () => {
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

    expect(result).toHaveLength(150)
    // Each embedding's second component is the within-batch position it
    // reordered from; the length component reveals which text produced it.
    result.forEach((embedding, i) => {
      expect(embedding[0]).toBe(texts[i]?.length)
    })
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
