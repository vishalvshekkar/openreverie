import { describe, expect, it } from 'vitest'
import { FakeChatProvider, FakeEmbeddingProvider } from './fakes.js'

describe('FakeChatProvider', () => {
  it('returns scripted results in order and records requests', async () => {
    const fake = new FakeChatProvider([
      { text: 'one', toolCalls: [] },
      { text: 'two', toolCalls: [{ id: 'c1', name: 'search_memory', arguments: '{"query":"x"}' }] },
    ])
    const r1 = await fake.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    expect(r1.text).toBe('one')
    const events: string[] = []
    for await (const e of fake.stream({ model: 'm', messages: [] })) events.push(e.type)
    expect(events).toEqual(['text', 'tool_call', 'done'])
    expect(fake.requests).toHaveLength(2)
  })

  it('streams scripted textChunks and throws after throwAfterTextEvents', async () => {
    const fake = new FakeChatProvider([
      {
        text: '',
        toolCalls: [],
        textChunks: ['abc', 'def', 'ghi'],
        throwAfterTextEvents: 2,
      },
    ])
    const events: string[] = []
    const texts: string[] = []
    await expect(
      (async () => {
        for await (const e of fake.stream({ model: 'm', messages: [] })) {
          events.push(e.type)
          if (e.type === 'text') texts.push(e.text)
        }
      })(),
    ).rejects.toThrow()
    expect(events).toEqual(['text', 'text'])
    expect(texts).toEqual(['abc', 'def'])
  })
})

describe('FakeEmbeddingProvider', () => {
  it('is deterministic, normalized, and distinct', async () => {
    const fake = new FakeEmbeddingProvider()
    const [a1] = (await fake.embed('m', ['hello'])).vectors
    const [a2, b] = (await fake.embed('m', ['hello', 'world'])).vectors
    expect(a1).toEqual(a2)
    expect(a1).not.toEqual(b)
    expect(a1).toBeDefined()
    if (!a1) throw new Error('expected vector')
    const norm = Math.sqrt(a1.reduce((s, v) => s + v * v, 0))
    expect(Math.abs(norm - 1)).toBeLessThan(1e-6)
  })

  it('reports usage tagged with the requested model and no completion tokens', async () => {
    const fake = new FakeEmbeddingProvider()
    const result = await fake.embed('embed-model-x', ['hello', 'world'])
    // 'hello' and 'world' are both 5 characters, and the fake's heuristic
    // is ceil(length / 4): 2 tokens each, 4 total.
    expect(result.usage).toEqual({ model: 'embed-model-x', inputTokens: 4, outputTokens: 0 })
  })
})
