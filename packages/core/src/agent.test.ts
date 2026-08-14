import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type EngineDeps, MemoryEngine } from '@openreverie/memory'
import { FakeChatProvider, FakeEmbeddingProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AgentEvent, AgentSession } from './agent.js'
import { defaultCrisisResources, type ReverieConfig } from './config.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openreverie-agent-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function testConfig(): ReverieConfig {
  return {
    memoryDir: dir,
    provider: { name: 'openai', apiKeyEnv: 'OPENREVERIE_TEST_KEY' },
    models: { chat: 'gpt-5', reflection: 'gpt-5-mini', embeddings: 'text-embedding-3-small' },
    safety: { mode: 'companion', resources: defaultCrisisResources },
    style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
  }
}

function fakeDeps(chat: FakeChatProvider): EngineDeps {
  return {
    chat,
    embeddings: new FakeEmbeddingProvider(),
    reflectionModel: 'fake-reflect',
    embeddingModel: 'fake-embed',
  }
}

function emptyReflectionOutput(summary: string) {
  return {
    summary,
    items: [],
    attributions: [],
    newArcs: [],
    newPersons: [],
    arcNarratives: [],
    constitutionUpdate: null,
  }
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const event of events) {
    out.push(event)
  }
  return out
}

describe('AgentSession', () => {
  it('runs a tool round then a final text round, forwarding events and the transcript in order', async () => {
    const chat = new FakeChatProvider([
      {
        text: '',
        toolCalls: [
          { id: 'call_1', name: 'search_memory', arguments: JSON.stringify({ query: 'kayaking' }) },
        ],
      },
      { text: 'We went kayaking last spring, on the lake near your place.', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    const events = await collect(session.send('Did we ever go kayaking?'))

    expect(events).toEqual([
      { type: 'tool', name: 'search_memory' },
      { type: 'text', text: 'We went kayaking last spring, on the lake near your place.' },
      { type: 'done' },
    ])

    const transcript = await engine.readTranscript(session.sessionId)
    expect(transcript.map((l) => l.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(transcript[0]).toMatchObject({ role: 'user', content: 'Did we ever go kayaking?' })
    expect(transcript[1]).toMatchObject({ role: 'assistant', content: '' })
    expect(transcript[1]?.toolCalls).toEqual([
      { id: 'call_1', name: 'search_memory', arguments: JSON.stringify({ query: 'kayaking' }) },
    ])
    expect(transcript[2]).toMatchObject({ role: 'tool', toolCallId: 'call_1' })
    expect(typeof transcript[2]?.content).toBe('string')
    expect(transcript[3]).toMatchObject({
      role: 'assistant',
      content: 'We went kayaking last spring, on the lake near your place.',
    })

    // The second request to the chat provider carries the tool result as a
    // message in its history, not just the original user line.
    expect(chat.requests.length).toBe(2)
    const secondRequestRoles = chat.requests[1]?.messages.map((m) => m.role)
    expect(secondRequestRoles).toEqual(['user', 'assistant', 'tool'])
    const toolMessage = chat.requests[1]?.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.toolCallId).toBe('call_1')
    expect(typeof toolMessage?.content).toBe('string')

    await engine.close()
  })

  it('propagates a provider error while the transcript keeps the user line', async () => {
    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    await expect(collect(session.send('Hello?'))).rejects.toThrow()

    const transcript = await engine.readTranscript(session.sessionId)
    expect(transcript.map((l) => l.role)).toEqual(['user'])
    expect(transcript[0]).toMatchObject({ role: 'user', content: 'Hello?' })

    await engine.close()
  })

  it('stops after 8 tool rounds without looping forever', async () => {
    const scripted = Array.from({ length: 8 }, (_, i) => ({
      text: '',
      toolCalls: [
        {
          id: `call_${i}`,
          name: 'list_arcs',
          arguments: '{}',
        },
      ],
    }))
    const chat = new FakeChatProvider(scripted)
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    const events = await collect(session.send('Keep going.'))

    expect(chat.requests.length).toBe(8)
    expect(events.filter((e) => e.type === 'tool').length).toBe(8)
    expect(events[events.length - 1]).toEqual({ type: 'done' })

    const transcript = await engine.readTranscript(session.sessionId)
    // user line, then 8 rounds of (assistant tool-call, tool result)
    expect(transcript.length).toBe(1 + 8 * 2)

    await engine.close()
  })

  it('keeps the transcript coherent when the consumer abandons the iterator right after a tool event', async () => {
    const chat = new FakeChatProvider([
      {
        text: '',
        toolCalls: [
          { id: 'call_1', name: 'search_memory', arguments: JSON.stringify({ query: 'kayaking' }) },
        ],
      },
      { text: 'We went kayaking last spring, on the lake near your place.', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    for await (const event of session.send('Did we ever go kayaking?')) {
      if (event.type === 'tool') break
    }

    const transcript = await engine.readTranscript(session.sessionId)
    expect(transcript.map((l) => l.role)).toEqual(['user', 'assistant'])
    expect(transcript[1]).toMatchObject({ role: 'assistant', content: '' })
    expect(transcript[1]?.toolCalls).toEqual([
      { id: 'call_1', name: 'search_memory', arguments: JSON.stringify({ query: 'kayaking' }) },
    ])

    await engine.close()
  })

  it('serializes concurrent send() calls so their transcripts do not interleave', async () => {
    const chat = new FakeChatProvider([
      { text: 'Reply A', toolCalls: [] },
      { text: 'Reply B', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    const [eventsA, eventsB] = await Promise.all([
      collect(session.send('Message A')),
      collect(session.send('Message B')),
    ])

    expect(eventsA).toEqual([{ type: 'text', text: 'Reply A' }, { type: 'done' }])
    expect(eventsB).toEqual([{ type: 'text', text: 'Reply B' }, { type: 'done' }])

    const transcript = await engine.readTranscript(session.sessionId)
    expect(transcript.map((l) => l.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(transcript[0]).toMatchObject({ role: 'user', content: 'Message A' })
    expect(transcript[1]).toMatchObject({ role: 'assistant', content: 'Reply A' })
    expect(transcript[2]).toMatchObject({ role: 'user', content: 'Message B' })
    expect(transcript[3]).toMatchObject({ role: 'assistant', content: 'Reply B' })

    await engine.close()
  })

  it('end() waits for an in-flight send() to finish before reflecting', async () => {
    const chat = new FakeChatProvider([
      {
        text: '',
        toolCalls: [{ id: 'call_1', name: 'list_arcs', arguments: '{}' }],
      },
      { text: 'All done here.', toolCalls: [] },
      { text: JSON.stringify(emptyReflectionOutput('reflected')), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    const sendPromise = collect(session.send('Do a thing'))
    const endPromise = session.end()

    await Promise.all([sendPromise, endPromise])

    const transcript = await engine.readTranscript(session.sessionId)
    // All of the in-flight send()'s lines (user, assistant tool-call,
    // tool result, final assistant text) must be on disk. If end() had
    // reflected before the send finished, this would be missing lines
    // and the session would be wrongly marked reflected.
    expect(transcript.map((l) => l.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])

    await engine.close()
  })

  it('rejects send() called after end() has begun', async () => {
    const chat = new FakeChatProvider([
      { text: 'Just checking in, nothing much today.', toolCalls: [] },
      { text: JSON.stringify(emptyReflectionOutput('A quiet check-in.')), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    await collect(session.send('Just checking in.'))
    await session.end()

    await expect(collect(session.send('too late'))).rejects.toThrow(Error)

    await engine.close()
  })

  it('preserves partial text on disk when the provider throws mid-stream', async () => {
    const chat = new FakeChatProvider([
      {
        text: '',
        toolCalls: [],
        textChunks: ['We went kayak', 'ing last spring.'],
        throwAfterTextEvents: 2,
      },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    await expect(collect(session.send('Tell me about it.'))).rejects.toThrow()

    const transcript = await engine.readTranscript(session.sessionId)
    expect(transcript.map((l) => l.role)).toEqual(['user', 'assistant'])
    expect(transcript[1]).toMatchObject({
      role: 'assistant',
      content: 'We went kayaking last spring.',
    })

    await engine.close()
  })

  it('end reflects the session, and a second end is a no-op', async () => {
    const chat = new FakeChatProvider([
      { text: 'Just checking in, nothing much today.', toolCalls: [] },
      { text: JSON.stringify(emptyReflectionOutput('A quiet check-in.')), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    await collect(session.send('Just checking in.'))
    expect(chat.requests.length).toBe(1)

    await session.end()
    expect(chat.requests.length).toBe(2)

    await session.end()
    expect(chat.requests.length).toBe(2)

    await engine.close()
  })
})
