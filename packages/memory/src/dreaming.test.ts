import { FakeChatProvider } from '@openreverie/providers'
import { describe, expect, it } from 'vitest'
import type { DreamLookup } from './dreaming.js'
import { runExploration } from './dreaming.js'

function fakeLookup(calls: string[]): DreamLookup {
  return {
    async search() {
      calls.push('search')
      return [{ docId: 'doc_1' }]
    },
    async readDocumentById() {
      calls.push('read')
      return null
    },
    async readTranscript() {
      calls.push('transcript')
      return []
    },
    neighbors() {
      calls.push('neighbors')
      return []
    },
  }
}

const searchCall = (id: string) => ({
  id,
  name: 'search_memory',
  arguments: JSON.stringify({ query: 'old arcs' }),
})

describe('runExploration', () => {
  it('dispatches tool calls and stops when the model stops', async () => {
    const chat = new FakeChatProvider([
      { text: '', toolCalls: [searchCall('t1')] },
      { text: 'done exploring', toolCalls: [] },
    ])
    const calls: string[] = []
    const events: Record<string, unknown>[] = []
    const messages = await runExploration({
      chat,
      model: 'fake',
      persona: 'PERSONA',
      lookup: fakeLookup(calls),
      maxToolCalls: 10,
      packet: 'PACKET',
      record: (e) => events.push(e),
    })
    expect(calls).toEqual(['search'])
    expect(chat.requests).toHaveLength(2)
    expect(chat.requests[0]?.system).toContain('PERSONA')
    expect(chat.requests[0]?.tools?.map((t) => t.name)).toEqual([
      'search_memory',
      'read_document',
      'read_transcript',
      'graph_query',
    ])
    expect(messages.at(-1)?.content).toBe('done exploring')
    expect(events.filter((e) => e.event === 'tool_call')).toHaveLength(1)
  })

  it('enforces the hard tool-call cap', async () => {
    const script = Array.from({ length: 6 }, (_, i) => ({
      text: '',
      toolCalls: [searchCall(`t${i}`)],
    }))
    const chat = new FakeChatProvider([...script, { text: 'stopped', toolCalls: [] }])
    const calls: string[] = []
    await runExploration({
      chat,
      model: 'fake',
      persona: 'P',
      lookup: fakeLookup(calls),
      maxToolCalls: 3,
      packet: 'PACKET',
      record: () => {},
    })
    expect(calls).toHaveLength(3)
    // 3 tool rounds + 1 wrap-up call after the budget-exhausted message.
    expect(chat.requests).toHaveLength(4)
    // The persona goes on every dreaming call, including the wrap-up round
    // after the budget is exhausted.
    expect(chat.requests.every((r) => r.system?.includes('P'))).toBe(true)
  })

  it('a single response over budget: the rest of that response is refused, none reach the lookup', async () => {
    const chat = new FakeChatProvider([
      {
        text: '',
        toolCalls: [searchCall('a'), searchCall('b'), searchCall('c')],
      },
      { text: 'wrap', toolCalls: [] },
    ])
    const calls: string[] = []
    const messages = await runExploration({
      chat,
      model: 'fake',
      persona: 'P',
      lookup: fakeLookup(calls),
      maxToolCalls: 1,
      packet: 'PACKET',
      record: () => {},
    })
    expect(calls).toHaveLength(1)
    const toolMessages = messages.filter((m) => m.role === 'tool')
    expect(toolMessages).toHaveLength(3)
    expect(toolMessages[1]?.content).toContain('exhausted')
    expect(toolMessages[2]?.content).toContain('exhausted')
    expect(messages.at(-1)?.content).toBe('wrap')
  })

  it('a tool dispatch error becomes an error string result, not a crash', async () => {
    const chat = new FakeChatProvider([
      { text: '', toolCalls: [{ id: 't1', name: 'read_document', arguments: 'not json' }] },
      { text: 'ok', toolCalls: [] },
    ])
    const messages = await runExploration({
      chat,
      model: 'fake',
      persona: 'P',
      lookup: fakeLookup([]),
      maxToolCalls: 5,
      packet: 'PACKET',
      record: () => {},
    })
    const toolMessage = messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toContain('error')
  })
})
