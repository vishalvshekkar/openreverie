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
})

describe('FakeEmbeddingProvider', () => {
  it('is deterministic, normalized, and distinct', async () => {
    const fake = new FakeEmbeddingProvider()
    const [a1] = await fake.embed('m', ['hello'])
    const [a2, b] = await fake.embed('m', ['hello', 'world'])
    expect(a1).toEqual(a2)
    expect(a1).not.toEqual(b)
    const norm = Math.sqrt(a1!.reduce((s, v) => s + v * v, 0))
    expect(Math.abs(norm - 1)).toBeLessThan(1e-6)
  })
})
