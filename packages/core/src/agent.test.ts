import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type EngineDeps,
  ensureMemoryTree,
  loadProfile,
  MemoryEngine,
  type MemoryPaths,
  memoryPaths,
  writeProfile,
} from '@openreverie/memory'
import { type ChatProvider, FakeChatProvider, FakeEmbeddingProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AgentEvent, AgentSession } from './agent.js'
import { defaultCrisisResources, type ReverieConfig } from './config.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openreverie-agent-'))
  await ensureMemoryTree(memoryPaths(dir))
  await pinTimezoneUtc(memoryPaths(dir))
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

function fakeDeps(chat: ChatProvider): EngineDeps {
  return {
    chat,
    embeddings: new FakeEmbeddingProvider(),
    reflectionModel: 'fake-reflect',
    embeddingModel: 'fake-embed',
  }
}

async function pinTimezoneUtc(paths: MemoryPaths): Promise<void> {
  const profile = await loadProfile(paths)
  await writeProfile(paths, {
    meta: { ...profile.meta, timezone: 'UTC', timezoneSource: 'user-confirmed' },
    body: profile.body,
  })
}

function emptyReflectionOutput(summary: string) {
  return {
    summary,
    items: [],
    attributions: [],
    newArcs: [],
    newPersons: [],
    newEntities: [],
    pagePromotions: [],
    arcUpdates: [],
    personUpdates: [],
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
  it('yields thinking at the start of every round, including after a tool call resumes the model', async () => {
    const chat = new FakeChatProvider([
      {
        text: '',
        toolCalls: [{ id: 'call_1', name: 'list_arcs', arguments: '{}' }],
      },
      { text: 'Here is what I found.', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    const events = await collect(session.send('What is going on?'))

    expect(events).toEqual([
      { type: 'thinking' },
      { type: 'tool', name: 'list_arcs' },
      { type: 'thinking' },
      { type: 'text', text: 'Here is what I found.' },
      { type: 'done' },
    ])

    await engine.close()
  })

  it('greet() also yields thinking before the greeting text', async () => {
    const chat = new FakeChatProvider([{ text: 'Hello again.', toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    const events = await collect(session.greet())

    expect(events).toEqual([
      { type: 'thinking' },
      { type: 'text', text: 'Hello again.' },
      { type: 'done' },
    ])

    await engine.close()
  })

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
      { type: 'thinking' },
      { type: 'tool', name: 'search_memory' },
      { type: 'thinking' },
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

    expect(eventsA).toEqual([
      { type: 'thinking' },
      { type: 'text', text: 'Reply A' },
      { type: 'done' },
    ])
    expect(eventsB).toEqual([
      { type: 'thinking' },
      { type: 'text', text: 'Reply B' },
      { type: 'done' },
    ])

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

  it('rebuilds the system prompt when update_style succeeds, so the new style applies immediately to subsequent requests', async () => {
    const chat = new FakeChatProvider([
      {
        text: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'update_style',
            arguments: JSON.stringify({ tone: 'playful' }),
          },
        ],
      },
      { text: 'Now speaking playfully.', toolCalls: [] },
    ])

    const toolDeps = {
      updateStyle: async (_patch: Record<string, unknown>) => {
        return {
          engagement: 'balanced' as const,
          tone: 'playful' as const,
          orientation: 'listening' as const,
        }
      },
    }

    const engine = await MemoryEngine.open(dir, {
      chat,
      embeddings: new FakeEmbeddingProvider(),
      reflectionModel: 'fake-reflect',
      embeddingModel: 'fake-embed',
    })
    const config = testConfig()
    const session = await AgentSession.start(engine, config, chat, toolDeps)

    const events = await collect(session.send('Change how you talk to me.'))

    expect(events).toEqual([
      { type: 'thinking' },
      { type: 'tool', name: 'update_style' },
      { type: 'thinking' },
      { type: 'text', text: 'Now speaking playfully.' },
      { type: 'done' },
    ])

    expect(chat.requests.length).toBe(2)

    const firstSystemPrompt = chat.requests[0]?.system || ''
    const secondSystemPrompt = chat.requests[1]?.system || ''

    expect(firstSystemPrompt).not.toBe(secondSystemPrompt)
    expect(firstSystemPrompt).toContain('Your configured tone is warm')
    expect(secondSystemPrompt).toContain('Your configured tone is playful')

    await engine.close()
  })

  it('does not rebuild the system prompt when update_style fails', async () => {
    const chat = new FakeChatProvider([
      {
        text: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'update_style',
            arguments: JSON.stringify({ tone: 'playful' }),
          },
        ],
      },
      { text: 'Still warm.', toolCalls: [] },
    ])

    const toolDeps = {
      updateStyle: async () => {
        throw new Error('could not persist style')
      },
    }

    const engine = await MemoryEngine.open(dir, {
      chat,
      embeddings: new FakeEmbeddingProvider(),
      reflectionModel: 'fake-reflect',
      embeddingModel: 'fake-embed',
    })
    const config = testConfig()
    const session = await AgentSession.start(engine, config, chat, toolDeps)

    const events = await collect(session.send('Try to change how you talk.'))

    expect(events).toEqual([
      { type: 'thinking' },
      { type: 'tool', name: 'update_style' },
      { type: 'thinking' },
      { type: 'text', text: 'Still warm.' },
      { type: 'done' },
    ])

    expect(chat.requests.length).toBe(2)

    const firstSystemPrompt = chat.requests[0]?.system || ''
    const secondSystemPrompt = chat.requests[1]?.system || ''

    expect(firstSystemPrompt).toBe(secondSystemPrompt)
    expect(secondSystemPrompt).toContain('Your configured tone is warm')

    await engine.close()
  })

  it('greet() streams the greeting and appends it as a single assistant line, with no user line', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you again. How has the week been?', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })
    const session = await AgentSession.start(engine, testConfig(), chat, undefined, {
      now: () => new Date('2026-08-16T20:00:00.000Z'),
    })

    const events = await collect(session.greet())

    expect(events).toEqual([
      { type: 'thinking' },
      { type: 'text', text: 'Good to see you again. How has the week been?' },
      { type: 'done' },
    ])

    const transcript = await engine.readTranscript(session.sessionId)
    expect(transcript.map((l) => l.role)).toEqual(['assistant'])
    expect(transcript[0]).toMatchObject({
      role: 'assistant',
      content: 'Good to see you again. How has the week been?',
    })

    expect(chat.requests[0]?.messages).toEqual([])
    expect(chat.requests[0]?.tools).toEqual([])

    // The greeting is the one model call with no user message to carry a
    // stamp, so its current local time is appended to the system string for
    // that call only. Nothing later reuses that string, so this costs no
    // cache: every later request's prefix is this.system plus messages.
    expect(chat.requests[0]?.system).toContain(
      'The current local time is Mon 2026-08-17 01:30 Asia/Kolkata.',
    )
    expect(chat.requests[0]?.system).toContain('## Speak first')

    await engine.close()
  })

  it('greet() instructs never opening with housekeeping, bookkeeping, or managing memory', async () => {
    const chat = new FakeChatProvider([{ text: 'Hello again.', toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    await collect(session.greet())

    const system = chat.requests[0]?.system ?? ''
    expect(system.toLowerCase()).toContain('never open with housekeeping')
    expect(system.toLowerCase()).toContain("open with the person's life")

    await engine.close()
  })

  it('greet() writes a transcript line in the same shape as a normal assistant line', async () => {
    const chat = new FakeChatProvider([{ text: 'Hello again.', toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    await collect(session.greet())

    const transcript = await engine.readTranscript(session.sessionId)
    expect(transcript).toHaveLength(1)
    const [line] = transcript
    expect(line?.role).toBe('assistant')
    expect(line?.content).toBe('Hello again.')
    expect(typeof line?.ts).toBe('string')
    expect(line?.toolCalls).toBeUndefined()
    expect(line?.toolCallId).toBeUndefined()

    await engine.close()
  })

  it('greet() abandons silently, writing no transcript line, when the provider fails', async () => {
    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    const events = await collect(session.greet())

    expect(events).toEqual([{ type: 'thinking' }])
    const transcript = await engine.readTranscript(session.sessionId)
    expect(transcript).toEqual([])

    await engine.close()
  })

  it('greet() writes no transcript line even when the provider streams text before it fails', async () => {
    // Regression guard: FakeChatProvider's stream() calls next() before it
    // ever returns a generator, so a provider that fails with nothing
    // scripted (the test above) throws before withTimeout ever gets an
    // iterator, and `text` in runGreeting is always empty on that path.
    // That test alone cannot catch a bug where runGreeting's catch block
    // appends whatever partial text had already streamed, the way
    // runTurn's error handling deliberately does. This test streams real
    // text first, then fails, so the transcript-stays-empty guarantee is
    // actually exercised on a non-empty `text`.
    const chat = new FakeChatProvider([
      {
        text: '',
        toolCalls: [],
        textChunks: ['Good to see', ' you again.'],
        throwAfterTextEvents: 2,
      },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    const events = await collect(session.greet())

    expect(events).toEqual([
      { type: 'thinking' },
      { type: 'text', text: 'Good to see' },
      { type: 'text', text: ' you again.' },
    ])
    const transcript = await engine.readTranscript(session.sessionId)
    expect(transcript).toEqual([])

    await engine.close()
  })

  it('greet() times out after 20 seconds without blocking, writing no transcript line', async () => {
    vi.useFakeTimers()
    try {
      const hangingChat: ChatProvider = {
        name: 'hanging',
        async complete() {
          throw new Error('not used in this test')
        },
        stream() {
          return (async function* () {
            await new Promise<never>(() => {
              // Never resolves: simulates a provider that stalls forever.
            })
          })()
        },
      }
      const engine = await MemoryEngine.open(dir, fakeDeps(hangingChat))
      const session = await AgentSession.start(engine, testConfig(), hangingChat)

      const resultPromise = collect(session.greet())
      await vi.advanceTimersByTimeAsync(20_001)
      const events = await resultPromise

      expect(events).toEqual([{ type: 'thinking' }])
      const transcript = await engine.readTranscript(session.sessionId)
      expect(transcript).toEqual([])

      await engine.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the transcript coherent when a consumer abandons greet() mid stream, persisting only the text already yielded', async () => {
    const chat = new FakeChatProvider([
      { text: '', toolCalls: [], textChunks: ['Good to see you again.', ' How has today gone?'] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    for await (const event of session.greet()) {
      if (event.type === 'text') break
    }

    const transcript = await engine.readTranscript(session.sessionId)
    expect(transcript).toHaveLength(1)
    expect(transcript[0]).toMatchObject({
      role: 'assistant',
      content: 'Good to see you again.',
    })

    await engine.close()
  })

  it('withTimeout asks the provider iterator to unwind on timeout, so its own cleanup eventually runs', async () => {
    vi.useFakeTimers()
    try {
      let cleanedUp = false
      let releaseHang: () => void = () => {}
      const delayedCleanupChat: ChatProvider = {
        name: 'delayed-cleanup',
        async complete() {
          throw new Error('not used in this test')
        },
        stream() {
          // Shaped like OpenAiChatProvider's real read loop: a `while`
          // loop that awaits the next chunk, then yields it. Suspending
          // partway through an unsettled await (not at the yield) is
          // what matters here: only a shape with an actual yield inside
          // the loop can distinguish "the queued return() intercepted
          // the next suspension point" from "the finally happened to
          // run because the generator reached its own natural end
          // anyway," which a body with no yield at all cannot do.
          return (async function* () {
            try {
              while (true) {
                // Simulates a provider whose connection is still open
                // when the greeting times out and settles only later on
                // its own, the way a stalled fetch might eventually
                // produce more data or error once the OS or a proxy
                // closes the idle socket.
                await new Promise<void>((resolve) => {
                  releaseHang = resolve
                })
                yield { type: 'text' as const, text: 'late chunk' }
              }
            } finally {
              cleanedUp = true
            }
          })()
        },
      }
      const engine = await MemoryEngine.open(dir, fakeDeps(delayedCleanupChat))
      const session = await AgentSession.start(engine, testConfig(), delayedCleanupChat)

      const resultPromise = collect(session.greet())
      await vi.advanceTimersByTimeAsync(20_001)
      const events = await resultPromise

      expect(events).toEqual([{ type: 'thinking' }])
      expect(cleanedUp).toBe(false)

      // The provider's connection finally settles, well after greet()
      // already gave up on it. The return() request queued at timeout
      // time is what makes the generator unwind straight to its own
      // finally at that point, instead of yielding the late chunk to
      // nobody and sitting suspended there forever.
      releaseHang()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(cleanedUp).toBe(true)

      await engine.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('withTimeout also asks the provider iterator to unwind when a consumer plainly abandons the stream, not only on timeout', async () => {
    // Ctrl-C while the greeting is still streaming, the moment right
    // after a chunk has already reached the terminal: the real provider
    // iterator is suspended at its own yield (having just produced that
    // chunk) and is about to await its next one. No fake timers here and
    // no timeout ever fires; the point of this test is the plain
    // abandonment path, distinct from the timeout path above.
    let cleanedUp = false
    const abandonedMidStreamChat: ChatProvider = {
      name: 'abandoned-mid-stream',
      async complete() {
        throw new Error('not used in this test')
      },
      stream() {
        return (async function* () {
          try {
            yield { type: 'text' as const, text: 'Good to see you.' }
            // Suspended mid-await, not at a yield, exactly like the real
            // provider's own next chunk still being awaited when the
            // consumer stops asking for more.
            await new Promise<void>(() => {})
          } finally {
            cleanedUp = true
          }
        })()
      },
    }
    const engine = await MemoryEngine.open(dir, fakeDeps(abandonedMidStreamChat))
    const session = await AgentSession.start(engine, testConfig(), abandonedMidStreamChat)

    for await (const event of session.greet()) {
      if (event.type === 'text') break
    }

    // A generator suspended at its own yield (exactly where this provider
    // sits right after producing the first chunk) is serviced by
    // return() immediately: no timer advance and no external release are
    // needed for its finally to run, unlike the timeout test above.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(cleanedUp).toBe(true)

    await engine.close()
  })

  it('writes transcript timestamps from the injected clock rather than the real one', async () => {
    const chat = new FakeChatProvider([{ text: 'Noted.', toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat, undefined, {
      now: () => new Date('2026-08-16T20:00:00.000Z'),
    })

    await collect(session.send('Hello.'))

    const transcript = await engine.readTranscript(session.sessionId)
    expect(transcript.map((line) => line.ts)).toEqual([
      '2026-08-16T20:00:00.000Z',
      '2026-08-16T20:00:00.000Z',
    ])

    await engine.close()
  })

  it('records the local UTC offset alongside ts, from the same clock read', async () => {
    const chat = new FakeChatProvider([{ text: 'Noted.', toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })
    const session = await AgentSession.start(engine, testConfig(), chat, undefined, {
      now: () => new Date('2026-08-16T20:00:00.000Z'),
    })

    await collect(session.send('Hello.'))

    const transcript = await engine.readTranscript(session.sessionId)
    expect(transcript).toHaveLength(2)
    expect(transcript[0]?.ts).toBe('2026-08-16T20:00:00.000Z')
    expect(transcript[0]?.utcOffsetMinutes).toBe(330)
    expect(transcript[1]?.utcOffsetMinutes).toBe(330)

    await engine.close()
  })

  it('stamps the user message with its local time in content, and leaves the transcript verbatim', async () => {
    const chat = new FakeChatProvider([{ text: 'Sounds fun.', toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })
    const session = await AgentSession.start(engine, testConfig(), chat, undefined, {
      now: () => new Date('2026-08-16T20:00:00.000Z'),
    })

    await collect(session.send("I'm watching Halcyon tonight at 7.25pm"))

    expect(chat.requests[0]?.messages).toEqual([
      {
        role: 'user',
        content: "[Mon 2026-08-17 01:30 Asia/Kolkata] I'm watching Halcyon tonight at 7.25pm",
      },
    ])

    const transcript = await engine.readTranscript(session.sessionId)
    expect(transcript[0]?.content).toBe("I'm watching Halcyon tonight at 7.25pm")
    expect(transcript[0]?.utcOffsetMinutes).toBe(330)
    expect(transcript[1]?.content).toBe('Sounds fun.')

    await engine.close()
  })

  it('never stamps an assistant or a tool message', async () => {
    const chat = new FakeChatProvider([
      { text: '', toolCalls: [{ id: 'call_1', name: 'list_arcs', arguments: '{}' }] },
      { text: 'Nothing open right now.', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })
    const session = await AgentSession.start(engine, testConfig(), chat, undefined, {
      now: () => new Date('2026-08-16T20:00:00.000Z'),
    })

    await collect(session.send('What is open?'))

    const secondRound = chat.requests[1]?.messages ?? []
    for (const message of secondRound) {
      if (message.role === 'user') {
        expect(message.content.startsWith('[Mon 2026-08-17 01:30 Asia/Kolkata] ')).toBe(true)
      } else {
        expect(message.content.startsWith('[Mon 2026-08-17 01:30 Asia/Kolkata]')).toBe(false)
      }
    }

    await engine.close()
  })

  it('keeps the request prefix byte-stable across tool rounds even as the clock advances', async () => {
    const chat = new FakeChatProvider([
      { text: '', toolCalls: [{ id: 'call_1', name: 'list_arcs', arguments: '{}' }] },
      { text: 'Nothing open right now.', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })
    let clock = new Date('2026-08-16T20:00:00.000Z')
    const session = await AgentSession.start(engine, testConfig(), chat, undefined, {
      now: () => clock,
    })

    const events = session.send('What is open?')
    const seen: string[] = []
    for await (const event of events) {
      seen.push(event.type)
      // Advance real wall-clock time in the middle of the turn, between the
      // two provider rounds. Nothing already sent may change because of it.
      if (event.type === 'tool') clock = new Date('2026-08-16T21:47:00.000Z')
    }
    expect(seen).toContain('done')

    const first = chat.requests[0]
    const second = chat.requests[1]
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    // The system string is frozen for the life of the session: a per-round
    // clock read in here would reprocess the whole history every turn.
    expect(second?.system).toBe(first?.system)
    // Round two's messages are a strict extension of round one's, element
    // for element. A rebuild of history, or a re-rendered stamp, breaks it.
    const firstMessages = first?.messages ?? []
    const secondMessages = second?.messages ?? []
    expect(secondMessages.length).toBeGreaterThan(firstMessages.length)
    expect(secondMessages.slice(0, firstMessages.length)).toEqual(firstMessages)

    await engine.close()
  })

  it('stamps a later message with the later time and never re-renders the earlier stamp', async () => {
    const chat = new FakeChatProvider([
      { text: 'Enjoy it.', toolCalls: [] },
      { text: 'How was it?', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })
    let clock = new Date('2026-08-16T10:49:00.000Z')
    const session = await AgentSession.start(engine, testConfig(), chat, undefined, {
      now: () => clock,
    })

    await collect(session.send('Watching Halcyon tonight at 7.25pm'))
    clock = new Date('2026-08-16T18:00:00.000Z')
    await collect(session.send('Back home.'))

    const secondRequest = chat.requests[1]?.messages ?? []
    const userMessages = secondRequest.filter((message) => message.role === 'user')
    expect(userMessages).toEqual([
      {
        role: 'user',
        content: '[Sun 2026-08-16 16:19 Asia/Kolkata] Watching Halcyon tonight at 7.25pm',
      },
      { role: 'user', content: '[Sun 2026-08-16 23:30 Asia/Kolkata] Back home.' },
    ])

    await engine.close()
  })

  it('reassembles the system prompt after update_profile so the Time section shows the confirmed zone', async () => {
    const chat = new FakeChatProvider([
      {
        text: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'update_profile',
            arguments: JSON.stringify({ timezone: 'Asia/Kolkata' }),
          },
        ],
      },
      { text: 'Got it, thanks.', toolCalls: [] },
      { text: 'Sure.', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat, undefined, {
      now: () => new Date('2026-08-16T20:00:00.000Z'),
    })

    await collect(session.send('I live in Bengaluru.'))
    await collect(session.send('Anything else?'))

    const last = chat.requests.at(-1)?.system ?? ''
    expect(last).toContain("This person's timezone is Asia/Kolkata.")
    expect(last).not.toContain('This timezone is a system default')

    await engine.close()
  })
})
