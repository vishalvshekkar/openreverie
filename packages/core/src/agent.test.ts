import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendDreamLog,
  appendGraph,
  type DreamInsight,
  type EngineDeps,
  ensureMemoryTree,
  loadProfile,
  MemoryEngine,
  type MemoryPaths,
  memoryPaths,
  newId,
  nodeStores,
  readDocument,
  SessionStore,
  writeDocumentAtomic,
  writeProfile,
} from '@openreverie/memory'
import {
  type ChatProvider,
  FakeChatProvider,
  FakeEmbeddingProvider,
  type ToolCall,
} from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AgentEvent, AgentSession } from './agent.js'
import { defaultCrisisResources, type ReverieConfig } from './config.js'
import { assembleSystemPrompt } from './context.js'
import { DEFAULT_DEPLOYMENT_CONTEXT } from './personas.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openreverie-agent-'))
  await ensureMemoryTree(memoryPaths(dir, nodeStores()), 'UTC')
  await pinTimezoneUtc(memoryPaths(dir, nodeStores()))
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
    dreaming: {
      enabled: false,
      cadence: 'daily',
      triggers: { afterSession: true, onStart: true, serverTimer: true },
      maxToolCalls: 10,
    },
  }
}

function fakeDeps(chat: ChatProvider): EngineDeps {
  return {
    chat,
    embeddings: new FakeEmbeddingProvider(),
    reflectionModel: 'fake-reflect',
    embeddingModel: 'fake-embed',
    timezone: 'UTC',
  }
}

async function pinTimezoneUtc(paths: MemoryPaths): Promise<void> {
  const profile = await loadProfile(paths, 'UTC')
  await writeProfile(paths, {
    meta: { ...profile.meta, timezone: 'UTC', timezoneSource: 'user-confirmed' },
    body: profile.body,
  })
}

// A dream directory on disk, the same shape runDream leaves (Task 7), hand
// built rather than run through the model: for a freshDream test all that
// matters is that listDreams finds a dream here, and it has never been
// marked mentioned in the log.
// A complete dream: both dream.md and insight.md written, the shape a
// normal run leaves when the tone gate does not withhold the narrative.
// hasNarrative must be true for freshDream to pick this up (see Fix 1 in
// task-10-report.md), so dream.md is not optional here even though only
// insight.md matters for most of these fixtures' assertions.
async function writeDream(
  paths: MemoryPaths,
  args: { date: string; dreamId: string },
): Promise<void> {
  const dir = join(paths.dreamsDir, `${args.date}-${args.dreamId}`)
  await mkdir(dir, { recursive: true })
  await writeDocumentAtomic(paths.files, {
    path: join(dir, 'dream.md'),
    meta: {
      id: newId('doc'),
      kind: 'dream',
      dream: args.dreamId,
      date: args.date,
      period: args.date,
      voice: 'first',
    },
    body: 'A dream narrative, for the greet() opener mention fixtures.\n',
  })
  const insight: DreamInsight = {
    id: newId('ins'),
    kind: 'pattern',
    headline: 'A quiet pattern',
    claim: 'They tend to go quiet for a day after a hard conversation.',
    confidence: 0.7,
    evidence: [],
  }
  await writeDocumentAtomic(paths.files, {
    path: join(dir, 'insight.md'),
    meta: {
      id: newId('doc'),
      kind: 'dream_insight',
      dream: args.dreamId,
      date: args.date,
      period: args.date,
      insights: [insight],
    },
    body: 'A dream insight document, for the greet() opener mention fixtures.\n',
  })
}

// A partial dream directory: mkdir happened but insight.md never got
// written, the shape a crash between the two leaves (Task 7's carried
// ruling). listDreamSummaries reports this with insightCount: 0 and
// hasNarrative: false rather than throwing; it must not become freshDream,
// since there is nothing in it to actually offer.
async function writePartialDream(
  paths: MemoryPaths,
  args: { date: string; dreamId: string },
): Promise<void> {
  const dir = join(paths.dreamsDir, `${args.date}-${args.dreamId}`)
  await mkdir(dir, { recursive: true })
}

// A dream whose narrative the tone gate withheld: insight.md exists (a run
// only aborts entirely, writing nothing, when no insight survives at all),
// but there is no dream.md. This must not become freshDream either: the
// opener promises a dream the person can read, and there is none here. The
// insights in it still belong in the prompt section (dreamsSection reads
// insight.md regardless of dream.md), which is what makes this case
// different from writePartialDream above.
async function writeToneWithheldDream(
  paths: MemoryPaths,
  args: { date: string; dreamId: string; insightId: string },
): Promise<void> {
  const dir = join(paths.dreamsDir, `${args.date}-${args.dreamId}`)
  await mkdir(dir, { recursive: true })
  const insight: DreamInsight = {
    id: args.insightId,
    kind: 'pattern',
    headline: 'An insight with no narrative',
    claim: 'The tone gate withheld the story but kept this.',
    confidence: 0.7,
    evidence: [],
  }
  await writeDocumentAtomic(paths.files, {
    path: join(dir, 'insight.md'),
    meta: {
      id: newId('doc'),
      kind: 'dream_insight',
      dream: args.dreamId,
      date: args.date,
      period: args.date,
      insights: [insight],
    },
    body: 'A dream insight document with no accompanying dream.md.\n',
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
    journalingUpdate: null,
  }
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const event of events) {
    out.push(event)
  }
  return out
}

// Lets already-queued microtasks (promise reactions already scheduled)
// run before the next assertion, without waiting on any real timer. Used
// only to observe that a promise has NOT settled yet, never to wait for
// one that eventually will.
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

// A round in a scripted script for makeAgentFixture: a small DSL over
// FakeChatProvider's {text, toolCalls} shape, so a caller can spell out a
// round as the events it produces rather than translate that by hand.
type ScriptedEvent = { type: 'tool_call'; toolCall: ToolCall } | { type: 'text'; text: string }

function toFakeChatResult(round: ScriptedEvent[]): { text: string; toolCalls: ToolCall[] } {
  let text = ''
  const toolCalls: ToolCall[] = []
  for (const event of round) {
    if (event.type === 'text') {
      text += event.text
    } else {
      toolCalls.push(event.toolCall)
    }
  }
  return { text, toolCalls }
}

// The fixture behind the session-mode tests below: an engine, config and
// chat provider wired together the same way every other test in this file
// wires them, plus `systems`, which records the system prompt of every
// request the fake provider receives so a test can assert on what the
// model actually saw rather than on a return value that can be right
// while the prompt is stale.
async function makeAgentFixture(rounds: ScriptedEvent[][] = []): Promise<{
  engine: MemoryEngine
  config: ReverieConfig
  chat: FakeChatProvider
  paths: MemoryPaths
  systems: string[]
}> {
  const chat = new FakeChatProvider(rounds.map(toFakeChatResult))
  const engine = await MemoryEngine.open(dir, fakeDeps(chat))
  const config = testConfig()
  const paths = memoryPaths(dir, nodeStores())
  const systems: string[] = []
  const originalStream = chat.stream.bind(chat)
  chat.stream = (req) => {
    systems.push(req.system ?? '')
    return originalStream(req)
  }
  return { engine, config, chat, paths, systems }
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

  // P0-4: the provider's usage ChatEvent must reach neither the caller as
  // an AgentEvent nor, worse, get concatenated into the greeting text.
  // FakeChatProvider emits `usage` (when scripted) after any tool_call
  // events and before `done`, mirroring where OpenAiChatProvider puts it;
  // this proves runGreeting's explicit usage branch does what its comment
  // says rather than silently falling through into the text branch above
  // it or being missed entirely.
  it('greet() does not turn a scripted usage event into an AgentEvent, and the greeting text carries no token numbers', async () => {
    const chat = new FakeChatProvider([
      {
        text: 'Hello again.',
        toolCalls: [],
        usage: { model: 'fake-model', inputTokens: 111, outputTokens: 222 },
      },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    const events = await collect(session.greet())

    expect(events).toEqual([
      { type: 'thinking' },
      { type: 'text', text: 'Hello again.' },
      { type: 'done' },
    ])
    expect(events.some((e) => e.type === 'text' && /111|222/.test(e.text))).toBe(false)

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

  // Same hazard as the greet() test above, exercised through runTurn's
  // separate loop (it has its own explicit usage branch, not shared code
  // with runGreeting): a scripted usage event must not surface as text,
  // as a tool call, or as any other AgentEvent.
  it('send() does not turn a scripted usage event into an AgentEvent, and the reply text carries no token numbers', async () => {
    const chat = new FakeChatProvider([
      {
        text: 'We went kayaking last spring.',
        toolCalls: [],
        usage: { model: 'fake-model', inputTokens: 333, outputTokens: 444 },
      },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    const events = await collect(session.send('Did we ever go kayaking?'))

    expect(events).toEqual([
      { type: 'thinking' },
      { type: 'text', text: 'We went kayaking last spring.' },
      { type: 'done' },
    ])
    expect(events.some((e) => e.type === 'text' && /333|444/.test(e.text))).toBe(false)

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

  it('end() with no options still awaits reflection, even when engine.endSession is slow', async () => {
    const chat = new FakeChatProvider([{ text: 'Just checking in.', toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)
    await collect(session.send('Just checking in.'))

    let resolveEndSession: (() => void) | undefined
    vi.spyOn(engine, 'endSession').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveEndSession = resolve
        }),
    )

    let settled = false
    const endPromise = session.end().then(() => {
      settled = true
    })

    await flushMicrotasks()
    expect(settled).toBe(false)

    resolveEndSession?.()
    await endPromise
    expect(settled).toBe(true)

    await engine.close()
  })

  it('end({ runReflection }) resolves before reflection settles, and hands the hook the reflection promise exactly once', async () => {
    const chat = new FakeChatProvider([{ text: 'Just checking in.', toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)
    await collect(session.send('Just checking in.'))

    let resolveEndSession: (() => void) | undefined
    vi.spyOn(engine, 'endSession').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveEndSession = resolve
        }),
    )

    const received: Promise<unknown>[] = []
    await session.end({
      runReflection: (work) => {
        received.push(work)
      },
    })
    expect(received).toHaveLength(1)

    let settled = false
    received[0]?.then(() => {
      settled = true
    })
    await flushMicrotasks()
    expect(settled).toBe(false)

    resolveEndSession?.()
    await received[0]
    expect(settled).toBe(true)

    await engine.close()
  })

  it('end({ runReflection }) still drains an in-flight send() before calling engine.endSession', async () => {
    const chat = new FakeChatProvider([
      {
        text: '',
        toolCalls: [{ id: 'call_1', name: 'list_arcs', arguments: '{}' }],
      },
      { text: 'All done here.', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    const calls: string[] = []
    const originalAppendTranscript = engine.appendTranscript.bind(engine)
    vi.spyOn(engine, 'appendTranscript').mockImplementation((sessionId, line) => {
      calls.push('appendTranscript')
      return originalAppendTranscript(sessionId, line)
    })
    vi.spyOn(engine, 'endSession').mockImplementation(async () => {
      calls.push('endSession')
    })

    const sendPromise = collect(session.send('Do a thing'))
    const endPromise = session.end({
      runReflection: (work) => {
        void work
      },
    })

    await Promise.all([sendPromise, endPromise])

    // The in-flight send() writes four transcript lines (user, assistant
    // tool-call, tool result, final assistant text): all four must be
    // appended before endSession is ever called, proving the send chain
    // drained first.
    expect(calls).toEqual([
      'appendTranscript',
      'appendTranscript',
      'appendTranscript',
      'appendTranscript',
      'endSession',
    ])

    await engine.close()
  })

  describe('session mode', () => {
    it('starts in general and reports it', async () => {
      const { engine, config, chat } = await makeAgentFixture()
      const session = await AgentSession.start(engine, config, chat)
      expect(session.mode).toBe('general')
      await engine.close()
    })

    it('starts in a mode passed at start, and records it on disk right away', async () => {
      const { engine, config, chat } = await makeAgentFixture()
      const session = await AgentSession.start(engine, config, chat, { mode: 'journal' })
      expect(session.mode).toBe('journal')
      expect(await engine.sessionMode(session.sessionId)).toBe('journal')
      await engine.close()
    })

    // Assert on the system prompt the fake provider received, not on a return
    // value: a return value can be right while the prompt is stale.
    it('carries the new mode paragraph on the next provider request after set_mode', async () => {
      const { engine, config, chat, systems } = await makeAgentFixture([
        [
          {
            type: 'tool_call',
            toolCall: { id: 't1', name: 'set_mode', arguments: '{"mode":"listen"}' },
          },
        ],
        [{ type: 'text', text: 'ok' }],
      ])
      const session = await AgentSession.start(engine, config, chat)
      const events = []
      for await (const event of session.send('be quiet and just listen')) events.push(event)

      expect(systems[0]).not.toContain('## Mode: listen')
      expect(systems[1]).toContain('## Mode: listen')
      expect(events).toContainEqual({ type: 'mode', mode: 'listen' })
      expect(session.mode).toBe('listen')

      await engine.close()
    })

    it('leaves the mode unchanged when set_mode names something unknown', async () => {
      const { engine, config, chat } = await makeAgentFixture([
        [
          {
            type: 'tool_call',
            toolCall: { id: 't1', name: 'set_mode', arguments: '{"mode":"moody"}' },
          },
        ],
        [{ type: 'text', text: 'ok' }],
      ])
      const session = await AgentSession.start(engine, config, chat)
      for await (const _event of session.send('switch modes')) {
        // drain
      }
      expect(session.mode).toBe('general')

      await engine.close()
    })

    // The regression test for the bug this replaces: the server starts
    // sessions with no injected dependencies at all.
    it('works on a session created with no injected dependencies', async () => {
      const { engine, config, chat } = await makeAgentFixture([
        [
          {
            type: 'tool_call',
            toolCall: { id: 't1', name: 'set_mode', arguments: '{"mode":"solve"}' },
          },
        ],
        [{ type: 'text', text: 'ok' }],
      ])
      const session = await AgentSession.start(engine, config, chat)
      for await (const _event of session.send('help me decide')) {
        // drain
      }
      expect(session.mode).toBe('solve')

      await engine.close()
    })

    it('appends one /mode line with no synthetic key when the CLI sets it', async () => {
      const { engine, config, chat } = await makeAgentFixture()
      const session = await AgentSession.start(engine, config, chat)
      await session.setMode('listen', { source: 'cli' })
      const lines = await engine.readTranscript(session.sessionId)
      const modeLines = lines.filter((line) => line.content === '/mode listen')
      expect(modeLines).toHaveLength(1)
      expect(modeLines[0]?.role).toBe('user')
      expect(modeLines[0]?.synthetic).toBeUndefined()

      await engine.close()
    })

    it('marks the /mode line synthetic when the web sets it', async () => {
      const { engine, config, chat } = await makeAgentFixture()
      const session = await AgentSession.start(engine, config, chat)
      await session.setMode('listen', { source: 'web' })
      const lines = await engine.readTranscript(session.sessionId)
      const modeLines = lines.filter((line) => line.content === '/mode listen')
      expect(modeLines).toHaveLength(1)
      expect(modeLines[0]?.synthetic).toBe(true)

      await engine.close()
    })

    it('appends no line at all when the model sets it, since the tool lines already record it', async () => {
      const { engine, config, chat } = await makeAgentFixture()
      const session = await AgentSession.start(engine, config, chat)
      await session.setMode('listen', { source: 'tool' })
      const lines = await engine.readTranscript(session.sessionId)
      expect(lines.filter((line) => line.content === '/mode listen')).toHaveLength(0)

      await engine.close()
    })

    it('records every mode change on disk for the engine to read at end of session', async () => {
      const { engine, config, chat } = await makeAgentFixture()
      const session = await AgentSession.start(engine, config, chat)
      await session.setMode('listen', { source: 'cli' })
      expect(await engine.sessionMode(session.sessionId)).toBe('listen')
      await session.setMode('journal', { source: 'web' })
      expect(await engine.sessionMode(session.sessionId)).toBe('journal')

      await engine.close()
    })

    // Guard, not a falsification: this passes with the mode feature entirely
    // absent. It guards against a future change that makes set_mode start
    // writing the file.
    it('Guard: profile.md is byte-identical before and after a mode change', async () => {
      const { engine, config, chat, paths } = await makeAgentFixture()
      const session = await AgentSession.start(engine, config, chat)
      const before = await readFile(paths.profile, 'utf8')
      await session.setMode('real', { source: 'cli' })
      expect(await readFile(paths.profile, 'utf8')).toEqual(before)

      await engine.close()
    })

    it('applies a profile change made outside a turn when refreshSystemPrompt is called', async () => {
      const { engine, config, chat, systems } = await makeAgentFixture([
        [{ type: 'text', text: 'a' }],
      ])
      const session = await AgentSession.start(engine, config, chat)
      await engine.updateProfileSettings({ style: { tone: 'direct' } })
      await session.refreshSystemPrompt()
      for await (const _event of session.send('hello')) {
        // drain
      }
      expect(systems[0]).toContain('Your configured tone is direct')

      await engine.close()
    })
  })

  it('greet() streams the greeting and appends it as a single assistant line, with no user line', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you again. How has the week been?', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })
    const session = await AgentSession.start(engine, testConfig(), chat, {
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

  it("actually reads AgentSession's injected clock for prompt assembly, not the wall clock (Important 4, part one)", async () => {
    // A session dated in 2020: under the real wall clock it is years
    // outside the seven-day recent-sessions window no matter when this
    // suite runs, so it can only appear in the rendered system prompt if
    // AgentSession.start actually threads its own `now` (also pinned in
    // 2020 here) into assembleSystemPrompt, rather than letting that call
    // fall back to reading the real wall clock internally. Mirrors
    // context.test.ts's "actually reads the injected clock" test one
    // layer up, at the AgentSession boundary that test cannot reach.
    const startedAt = new Date('2020-01-01T09:00:00.000Z')
    const paths = memoryPaths(dir, nodeStores())
    const store = await SessionStore.start(paths, startedAt, 'UTC')
    await store.appendLine(paths, { ts: startedAt.toISOString(), role: 'user', content: 'Hello.' })
    await writeDocumentAtomic(paths.files, {
      path: join(store.dir, 'summary.md'),
      meta: {
        id: newId('doc'),
        kind: 'summary',
        session: store.sessionId,
        date: '2020-01-01',
        items: [],
      },
      body: 'A session from 2020, only recent to a clock pinned near it.\n',
    })

    const chat = new FakeChatProvider([{ text: 'Hello again.', toolCalls: [] }])
    // maintenance: false, so opening the engine does not itself consume
    // this FakeChatProvider's queued response reflecting or rolling up
    // the 2020 session (it is old enough to be stale by any real clock).
    const engine = await MemoryEngine.open(dir, fakeDeps(chat), { maintenance: false })
    const session = await AgentSession.start(engine, testConfig(), chat, {
      // Two days after the 2020 session, well inside the seven-day recent
      // window, but only when the prompt is assembled against THIS clock.
      now: () => new Date('2020-01-03T09:00:00.000Z'),
    })

    await collect(session.greet())

    const system = chat.requests[0]?.system ?? ''
    expect(system).toContain('## Recent sessions')
    expect(system).toContain('A session from 2020, only recent to a clock pinned near it.')

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

  it('greet() instructs not asking how something went unless the record shows it happened', async () => {
    const chat = new FakeChatProvider([{ text: 'Hello again.', toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    await collect(session.greet())

    const system = chat.requests[0]?.system ?? ''
    expect(system.toLowerCase()).toContain('do not ask how something went')
    expect(system.toLowerCase()).toContain('unless the record shows it actually happened')

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

  describe('dream opener mention', () => {
    it('adds the dream mention guidance and marks the dream mentioned when the context carries a freshDream', async () => {
      const paths = memoryPaths(dir, nodeStores())
      await writeDream(paths, { date: '2026-08-20', dreamId: 'dream_fresh1' })
      const chat = new FakeChatProvider([{ text: 'Hello again.', toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const markSpy = vi.spyOn(engine, 'markDreamMentioned')
      const session = await AgentSession.start(engine, testConfig(), chat)

      await collect(session.greet())

      const system = chat.requests[0]?.system ?? ''
      expect(system).toContain('While the person was away you dreamt.')
      expect(markSpy).toHaveBeenCalledWith('dream_fresh1')

      await engine.close()
    })

    it('adds no dream mention guidance and marks nothing when there is no fresh dream', async () => {
      const chat = new FakeChatProvider([{ text: 'Hello again.', toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const markSpy = vi.spyOn(engine, 'markDreamMentioned')
      const session = await AgentSession.start(engine, testConfig(), chat)

      await collect(session.greet())

      const system = chat.requests[0]?.system ?? ''
      expect(system).not.toContain('you dreamt')
      expect(markSpy).not.toHaveBeenCalled()

      await engine.close()
    })

    it('never mentions the dream and never marks it mentioned in decompress mode, leaving it available for later', async () => {
      const paths = memoryPaths(dir, nodeStores())
      await writeDream(paths, { date: '2026-08-20', dreamId: 'dream_fresh2' })
      const chat = new FakeChatProvider([{ text: 'Hello again.', toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const markSpy = vi.spyOn(engine, 'markDreamMentioned')
      const session = await AgentSession.start(engine, testConfig(), chat, { mode: 'decompress' })

      await collect(session.greet())

      const system = chat.requests[0]?.system ?? ''
      expect(system).not.toContain('you dreamt')
      expect(markSpy).not.toHaveBeenCalled()

      await engine.close()
    })

    it('adds no dream mention guidance and marks nothing once the dream has already been mentioned', async () => {
      const paths = memoryPaths(dir, nodeStores())
      await writeDream(paths, { date: '2026-08-20', dreamId: 'dream_seen1' })
      await appendDreamLog(paths, [
        { ts: '2026-08-21T00:00:00.000Z', type: 'mentioned', dream: 'dream_seen1' },
      ])
      const chat = new FakeChatProvider([{ text: 'Hello again.', toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const markSpy = vi.spyOn(engine, 'markDreamMentioned')
      const session = await AgentSession.start(engine, testConfig(), chat)

      await collect(session.greet())

      const system = chat.requests[0]?.system ?? ''
      expect(system).not.toContain('you dreamt')
      expect(markSpy).not.toHaveBeenCalled()

      await engine.close()
    })

    it('adds no dream mention guidance and marks nothing when profile.dreams.openerMention is false', async () => {
      const paths = memoryPaths(dir, nodeStores())
      await writeDream(paths, { date: '2026-08-20', dreamId: 'dream_fresh3' })
      const profile = await loadProfile(paths, 'UTC')
      await writeProfile(paths, {
        meta: { ...profile.meta, dreams: { openerMention: false } },
        body: profile.body,
      })
      const chat = new FakeChatProvider([{ text: 'Hello again.', toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const markSpy = vi.spyOn(engine, 'markDreamMentioned')
      const session = await AgentSession.start(engine, testConfig(), chat)

      await collect(session.greet())

      const system = chat.requests[0]?.system ?? ''
      expect(system).not.toContain('you dreamt')
      expect(markSpy).not.toHaveBeenCalled()

      await engine.close()
    })

    it('still adds the dream mention guidance when profile.dreams.promptSection is false: the opener is independent of the section', async () => {
      const paths = memoryPaths(dir, nodeStores())
      await writeDream(paths, { date: '2026-08-20', dreamId: 'dream_fresh4' })
      const profile = await loadProfile(paths, 'UTC')
      await writeProfile(paths, {
        meta: { ...profile.meta, dreams: { promptSection: false } },
        body: profile.body,
      })
      const chat = new FakeChatProvider([{ text: 'Hello again.', toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const markSpy = vi.spyOn(engine, 'markDreamMentioned')
      const session = await AgentSession.start(engine, testConfig(), chat)

      await collect(session.greet())

      const system = chat.requests[0]?.system ?? ''
      expect(system).toContain('While the person was away you dreamt.')
      expect(markSpy).toHaveBeenCalledWith('dream_fresh4')

      await engine.close()
    })

    it('does not offer a partial dream directory that has no insight.md, even when it is the newest', async () => {
      const paths = memoryPaths(dir, nodeStores())
      await writeDream(paths, { date: '2026-08-19', dreamId: 'dream_real1' })
      await writePartialDream(paths, { date: '2026-08-20', dreamId: 'dream_partial1' })
      const chat = new FakeChatProvider([{ text: 'Hello again.', toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const markSpy = vi.spyOn(engine, 'markDreamMentioned')
      const session = await AgentSession.start(engine, testConfig(), chat)

      await collect(session.greet())

      const system = chat.requests[0]?.system ?? ''
      expect(system).toContain('While the person was away you dreamt.')
      expect(markSpy).toHaveBeenCalledWith('dream_real1')

      await engine.close()
    })

    it('never offers a tone-withheld dream (insight.md with no dream.md) in the opener, while its insights still reach the prompt section', async () => {
      const paths = memoryPaths(dir, nodeStores())
      // An arc so this is not treated as a first session, which would skip
      // dreamsSection entirely (see context.test.ts's own first-session
      // tests for the same setup). Appended before MemoryEngine.open,
      // since the engine snapshots graph state at open.
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'arc_any',
          type: 'arc',
          label: 'Any Arc',
        },
      ])
      await writeToneWithheldDream(paths, {
        date: '2026-08-20',
        dreamId: 'dream_withheld1',
        insightId: 'ins_withheld1',
      })
      const chat = new FakeChatProvider([{ text: 'Hello again.', toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const markSpy = vi.spyOn(engine, 'markDreamMentioned')
      const session = await AgentSession.start(engine, testConfig(), chat)

      await collect(session.greet())

      const system = chat.requests[0]?.system ?? ''
      expect(system).not.toContain('While the person was away you dreamt.')
      expect(markSpy).not.toHaveBeenCalled()
      // The insight still belongs in the prompt section: only the opener
      // mention is gated on having a narrative to offer.
      expect(system).toContain('ins_withheld1')
      expect(system).toContain('An insight with no narrative')

      await engine.close()
    })
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

  it('honors a custom greetingTimeoutMs instead of the default 20 seconds', async () => {
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
      const session = await AgentSession.start(engine, testConfig(), hangingChat, {
        greetingTimeoutMs: 5_000,
      })

      const resultPromise = collect(session.greet())
      // If greetingTimeoutMs were ignored in favor of the hardcoded 20
      // second default, this advance alone would not fire the timeout,
      // and awaiting resultPromise below would hang until vitest's own
      // test timeout, not resolve with these events.
      await vi.advanceTimersByTimeAsync(5_001)
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
    const session = await AgentSession.start(engine, testConfig(), chat, {
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
    const session = await AgentSession.start(engine, testConfig(), chat, {
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
    const session = await AgentSession.start(engine, testConfig(), chat, {
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
    const session = await AgentSession.start(engine, testConfig(), chat, {
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
    const session = await AgentSession.start(engine, testConfig(), chat, {
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
    const session = await AgentSession.start(engine, testConfig(), chat, {
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
    const session = await AgentSession.start(engine, testConfig(), chat, {
      now: () => new Date('2026-08-16T20:00:00.000Z'),
    })

    await collect(session.send('I live in Bengaluru.'))
    await collect(session.send('Anything else?'))

    const last = chat.requests.at(-1)?.system ?? ''
    expect(last).toContain("This person's timezone is Asia/Kolkata.")
    expect(last).not.toContain('This timezone is a system default')

    await engine.close()
  })

  it('reassembles the system prompt after a successful update_journaling_protocol call', async () => {
    // An arc so this is not treated as a first session, which would
    // replace every optional section (journalingProtocolSection
    // included) with the onboarding block; see context.test.ts's own
    // journalingProtocolSection tests for the same setup. Appended
    // before MemoryEngine.open, since the engine snapshots graph state
    // at open.
    await appendGraph(memoryPaths(dir, nodeStores()), [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_any',
        type: 'arc',
        label: 'Any Arc',
      },
    ])

    const chat = new FakeChatProvider([
      {
        text: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'update_journaling_protocol',
            arguments: JSON.stringify({ body: 'Gratitude, three times a week.' }),
          },
        ],
      },
      { text: 'Got it, thanks.', toolCalls: [] },
      { text: 'Sure.', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    // journal mode, not the plan's plain start(): journalingProtocol is
    // only read from disk when the session mode is 'journal' (see
    // engine.ts's sessionContext), so the plan's own mode-less version of
    // this test could never contain the new body regardless of whether
    // the refreshSystemPrompt trigger below actually works.
    const session = await AgentSession.start(engine, testConfig(), chat, {
      mode: 'journal',
      now: () => new Date('2026-08-16T20:00:00.000Z'),
    })

    await collect(session.send("Let's set up journaling."))
    await collect(session.send('Anything else?'))

    const last = chat.requests.at(-1)?.system ?? ''
    expect(last).toContain('Gratitude, three times a week.')

    await engine.close()
  })

  describe('AgentSessionOptions.persona', () => {
    it('reaches the very first system prompt assembled in start()', async () => {
      const chat = new FakeChatProvider([{ text: 'Hi.', toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const session = await AgentSession.start(engine, testConfig(), chat, {
        persona: { deploymentContext: 'A hosted deployment claim, agent-level.' },
      })

      await collect(session.send('Hello.'))

      expect(chat.requests[0]?.system).toContain('A hosted deployment claim, agent-level.')
      expect(chat.requests[0]?.system).not.toContain(DEFAULT_DEPLOYMENT_CONTEXT)

      await engine.close()
    })

    it('survives a mid-session refresh triggered by update_profile', async () => {
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
      const session = await AgentSession.start(engine, testConfig(), chat, {
        now: () => new Date('2026-08-16T20:00:00.000Z'),
        persona: { deploymentContext: 'A hosted deployment claim, surviving refresh.' },
      })

      await collect(session.send('I live in Bengaluru.'))
      await collect(session.send('Anything else?'))

      const last = chat.requests.at(-1)?.system ?? ''
      expect(last).toContain('A hosted deployment claim, surviving refresh.')
      expect(last).not.toContain(DEFAULT_DEPLOYMENT_CONTEXT)

      await engine.close()
    })

    it('omitting persona entirely keeps the default deployment claim', async () => {
      const chat = new FakeChatProvider([{ text: 'Hi.', toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const session = await AgentSession.start(engine, testConfig(), chat)

      await collect(session.send('Hello.'))

      expect(chat.requests[0]?.system).toContain(DEFAULT_DEPLOYMENT_CONTEXT)

      await engine.close()
    })
  })

  describe('resume', () => {
    it('reproduces a byte-exact stamp when the stored offset still matches the current zone', async () => {
      const chat = new FakeChatProvider([{ text: 'Sounds fun.', toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      await engine.updateProfile({ timezone: 'Asia/Kolkata' })
      const live = await AgentSession.start(engine, testConfig(), chat, {
        now: () => new Date('2026-08-16T20:00:00.000Z'),
      })
      await collect(live.send("I'm watching Halcyon tonight at 7.25pm"))
      const liveMessages = chat.requests.at(-1)?.messages ?? []

      const chat2 = new FakeChatProvider([{ text: 'Enjoy.', toolCalls: [] }])
      const { session: resumed, report } = await AgentSession.resume(
        engine,
        testConfig(),
        chat2,
        live.sessionId,
        { now: () => new Date('2026-08-17T02:00:00.000Z') },
      )
      expect(report.stampsExact).toBe(true)

      await collect(resumed.send('Back home now.'))
      const resumedMessages = chat2.requests[0]?.messages ?? []
      // Round two's messages are a strict extension of round one's, the
      // same "prefix stays byte-identical" claim the live-session stamping
      // tests already prove, but proven here across a resume boundary: the
      // rebuilt history must match what the live session actually sent to
      // the provider, element for element.
      expect(resumedMessages.slice(0, liveMessages.length)).toEqual(liveMessages)

      await engine.close()
    })

    it('falls back to the stored-offset rendering when the stored offset disagrees with the current zone', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      await engine.updateProfile({ timezone: 'Asia/Kolkata' })
      const sessionId = await engine.startSession(new Date('2026-08-16T20:00:00.000Z'))
      await engine.setSessionMode(sessionId, 'general')
      // utcOffsetMinutes -300 (US Eastern) does not match Asia/Kolkata's
      // +330 at this instant: the fallback branch must fire.
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:00.000Z',
        utcOffsetMinutes: -300,
        role: 'user',
        content: 'Moved timezones since I last wrote.',
      })

      const chat2 = new FakeChatProvider([{ text: 'Got it.', toolCalls: [] }])
      const { session: resumed, report } = await AgentSession.resume(
        engine,
        testConfig(),
        chat2,
        sessionId,
        { now: () => new Date('2026-08-17T02:00:00.000Z') },
      )
      expect(report.stampsExact).toBe(false)

      await collect(resumed.send('Confirming.'))
      const firstMessage = chat2.requests[0]?.messages[0]
      expect(firstMessage).toEqual({
        role: 'user',
        content: '[Sun 2026-08-16 15:00 UTC-05:00] Moved timezones since I last wrote.',
      })

      await engine.close()
    })

    it('carries both stamp branches in one rebuild when the zone changed partway', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      await engine.updateProfile({ timezone: 'Asia/Kolkata' })
      const sessionId = await engine.startSession(new Date('2026-08-16T20:00:00.000Z'))
      await engine.setSessionMode(sessionId, 'general')
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:00.000Z',
        utcOffsetMinutes: 330,
        role: 'user',
        content: 'First message, exact.',
      })
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:01:00.000Z',
        role: 'assistant',
        content: 'Noted.',
      })
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:05:00.000Z',
        utcOffsetMinutes: -300,
        role: 'user',
        content: 'Second message, fallback.',
      })
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:06:00.000Z',
        role: 'assistant',
        content: 'Also noted.',
      })

      const chat2 = new FakeChatProvider([{ text: 'Continuing.', toolCalls: [] }])
      const { session: resumed, report } = await AgentSession.resume(
        engine,
        testConfig(),
        chat2,
        sessionId,
        { now: () => new Date('2026-08-17T02:00:00.000Z') },
      )
      expect(report.stampsExact).toBe(false)

      await collect(resumed.send('Third.'))
      const messages = chat2.requests[0]?.messages ?? []
      expect(messages[0]).toEqual({
        role: 'user',
        content: '[Mon 2026-08-17 01:30 Asia/Kolkata] First message, exact.',
      })
      expect(messages[2]).toEqual({
        role: 'user',
        content: '[Sun 2026-08-16 15:05 UTC-05:00] Second message, fallback.',
      })

      await engine.close()
    })

    it('excludes a historyOmitted /mode line from history but leaves it in the transcript', async () => {
      const chat = new FakeChatProvider([{ text: 'Hi.', toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      await engine.updateProfile({ timezone: 'UTC' })
      const live = await AgentSession.start(engine, testConfig(), chat, {
        now: () => new Date('2026-08-16T20:00:00.000Z'),
      })
      await live.setMode('listen', { source: 'cli' })

      const beforeResume = await engine.readTranscript(live.sessionId)
      const modeLine = beforeResume.find((line) => line.content === '/mode listen')
      expect(modeLine?.historyOmitted).toBe(true)

      const chat2 = new FakeChatProvider([{ text: 'Sure.', toolCalls: [] }])
      const { session: resumed } = await AgentSession.resume(
        engine,
        testConfig(),
        chat2,
        live.sessionId,
        { now: () => new Date('2026-08-16T20:05:00.000Z') },
      )
      await collect(resumed.send('Continuing.'))
      const messages = chat2.requests[0]?.messages ?? []
      expect(messages.some((m) => m.content.includes('/mode listen'))).toBe(false)

      const afterResume = await engine.readTranscript(live.sessionId)
      expect(afterResume.find((line) => line.content === '/mode listen')).toEqual(modeLine)

      await engine.close()
    })

    it('drops a dangling trailing tool-call line from history, leaving the transcript unchanged', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      await engine.updateProfile({ timezone: 'UTC' })
      const sessionId = await engine.startSession(new Date('2026-08-16T20:00:00.000Z'))
      await engine.setSessionMode(sessionId, 'general')
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:00.000Z',
        utcOffsetMinutes: 0,
        role: 'user',
        content: 'What is on my plate?',
      })
      // No matching tool result line: eviction happened between announcing
      // the call and dispatching it.
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:01.000Z',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'list_arcs', arguments: '{}' }],
      })

      const before = await engine.readTranscript(sessionId)

      const chat2 = new FakeChatProvider([{ text: 'Here you go.', toolCalls: [] }])
      const { session: resumed, report } = await AgentSession.resume(
        engine,
        testConfig(),
        chat2,
        sessionId,
        { now: () => new Date('2026-08-16T20:10:00.000Z') },
      )
      expect(report.historyMessageCount).toBe(1)
      expect(report.incompleteTurn).toEqual({ fromLineSequence: 1, droppedToolCallLines: 1 })

      // Unchanged by the rebuild itself, before any new turn runs: resume
      // never rewrites a transcript line, and this is checked at the point
      // where only the rebuild has happened.
      const afterResume = await engine.readTranscript(sessionId)
      expect(afterResume).toEqual(before)

      await collect(resumed.send('Anything?'))
      const messages = chat2.requests[0]?.messages ?? []
      expect(messages.some((m) => m.toolCalls !== undefined)).toBe(false)

      await engine.close()
    })

    it('drops a dangling assistant tool-call line even after a later resume pushes it into the middle of history', async () => {
      // The ordinary hibernate, resume, talk, hibernate cycle: a dangling
      // tool-call line is trailing on the first resume (a purely
      // positional trim would still catch it there), but the person's next
      // message appends a full, later turn after it, so on the second
      // resume that same line sits in the middle of the rebuild instead of
      // at the end. A trim that only ever looks at the tail would leave it
      // there, unanswered, and the next provider request would be a 400.
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      await engine.updateProfile({ timezone: 'UTC' })
      const sessionId = await engine.startSession(new Date('2026-08-16T20:00:00.000Z'))
      await engine.setSessionMode(sessionId, 'general')

      // Step 1: transcript ends mid-tool-call, exactly like the sibling
      // trailing-drop test above.
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:00.000Z',
        utcOffsetMinutes: 0,
        role: 'user',
        content: 'What is on my plate?',
      })
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:01.000Z',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'list_arcs', arguments: '{}' }],
      })

      // Step 2: resume once. The dangling line is trailing here.
      const chat2 = new FakeChatProvider([])
      const { report: firstReport } = await AgentSession.resume(
        engine,
        testConfig(),
        chat2,
        sessionId,
        { now: () => new Date('2026-08-16T20:10:00.000Z') },
      )
      expect(firstReport.incompleteTurn).toEqual({ fromLineSequence: 1, droppedToolCallLines: 1 })

      // Step 3: the person sends another message. appendBoth appends to
      // the same transcript, which now reads [user1, assistant(toolCall
      // call_1), user2, assistant(text)]: the dangling line is no longer
      // trailing.
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:15:00.000Z',
        utcOffsetMinutes: 0,
        role: 'user',
        content: 'Never mind, forget it.',
      })
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:15:01.000Z',
        role: 'assistant',
        content: 'No problem.',
      })

      // Step 4: resume again. The real tail (user2, then a plain assistant
      // reply) is complete, so this rebuild reports no incompleteTurn of
      // its own; the earlier loss was already reported by the first
      // resume above. What matters is whether the still-dangling call_1
      // line survived into the middle of this rebuild.
      const chat3 = new FakeChatProvider([{ text: 'Sure.', toolCalls: [] }])
      const { session: resumed, report: secondReport } = await AgentSession.resume(
        engine,
        testConfig(),
        chat3,
        sessionId,
        { now: () => new Date('2026-08-16T20:20:00.000Z') },
      )
      expect(secondReport.incompleteTurn).toBeUndefined()

      await collect(resumed.send('Anything?'))
      const messages = chat3.requests[0]?.messages ?? []
      expect(messages.every((message) => message.toolCalls === undefined)).toBe(true)

      await engine.close()
    })

    it('reports incompleteTurn for a user line with nothing after it', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const sessionId = await engine.startSession(new Date('2026-08-16T20:00:00.000Z'))
      await engine.setSessionMode(sessionId, 'general')
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:00.000Z',
        utcOffsetMinutes: 0,
        role: 'user',
        content: 'The object evicted right after this.',
      })

      const { report } = await AgentSession.resume(engine, testConfig(), chat, sessionId, {
        now: () => new Date('2026-08-16T20:10:00.000Z'),
      })
      expect(report.incompleteTurn).toEqual({ fromLineSequence: 1, droppedToolCallLines: 0 })

      await engine.close()
    })

    it('reports no incompleteTurn for a clean tail', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const sessionId = await engine.startSession(new Date('2026-08-16T20:00:00.000Z'))
      await engine.setSessionMode(sessionId, 'general')
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:00.000Z',
        utcOffsetMinutes: 0,
        role: 'user',
        content: 'A complete turn.',
      })
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:05.000Z',
        role: 'assistant',
        content: 'Understood.',
      })

      const { report } = await AgentSession.resume(engine, testConfig(), chat, sessionId, {
        now: () => new Date('2026-08-16T20:10:00.000Z'),
      })
      expect(report.incompleteTurn).toBeUndefined()

      await engine.close()
    })

    it('reports no incompleteTurn for an empty history evicted before the greeting landed', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const sessionId = await engine.startSession(new Date('2026-08-16T20:00:00.000Z'))
      await engine.setSessionMode(sessionId, 'general')

      const { report } = await AgentSession.resume(engine, testConfig(), chat, sessionId, {
        now: () => new Date('2026-08-16T20:10:00.000Z'),
      })
      expect(report.historyMessageCount).toBe(0)
      expect(report.incompleteTurn).toBeUndefined()

      await engine.close()
    })

    it('replays a plain remember call with its original ts, and skips the three commitment shapes', async () => {
      const summary = JSON.stringify({
        summary: 'A quiet check-in.',
        items: [],
        attributions: [],
        newArcs: [],
        newPersons: [],
        newEntities: [],
        pagePromotions: [],
        arcUpdates: [],
        personUpdates: [],
        constitutionUpdate: null,
        journalingUpdate: null,
      })
      const chat = new FakeChatProvider([{ text: summary, toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const sessionId = await engine.startSession(new Date('2026-08-16T20:00:00.000Z'))
      await engine.setSessionMode(sessionId, 'general')
      const rememberTs = '2026-08-16T20:00:05.000Z'

      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:00.000Z',
        role: 'user',
        content: 'Planning things.',
      })
      await engine.appendTranscript(sessionId, {
        ts: rememberTs,
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_remember',
            name: 'remember',
            arguments: JSON.stringify({ text: 'Watching Halcyon tonight', kind: 'intention' }),
          },
        ],
      })
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:06.000Z',
        role: 'tool',
        content: '{"ok":true}',
        toolCallId: 'call_remember',
      })
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:10.000Z',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_commitment',
            name: 'remember',
            arguments: JSON.stringify({ commitment: { label: 'See Nightfall', flavor: 'plan' } }),
          },
        ],
      })
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:11.000Z',
        role: 'tool',
        content: '{"ok":true,"commitmentId":"commit_x"}',
        toolCallId: 'call_commitment',
      })
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:15.000Z',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_revise',
            name: 'remember',
            arguments: JSON.stringify({
              reviseCommitment: { commitmentId: 'commit_x', label: 'See Nightfall, revised' },
            }),
          },
        ],
      })
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:16.000Z',
        role: 'tool',
        content: '{"ok":true,"commitmentId":"commit_x"}',
        toolCallId: 'call_revise',
      })
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:20.000Z',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_resolve',
            name: 'remember',
            arguments: JSON.stringify({
              resolveCommitment: { commitmentId: 'commit_x', outcome: 'done' },
            }),
          },
        ],
      })
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:21.000Z',
        role: 'tool',
        content: '{"ok":true,"commitmentId":"commit_x"}',
        toolCallId: 'call_resolve',
      })
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-16T20:00:25.000Z',
        role: 'assistant',
        content: 'Got it, noted.',
      })

      const { report } = await AgentSession.resume(engine, testConfig(), chat, sessionId, {
        now: () => new Date('2026-08-16T21:00:00.000Z'),
      })
      expect(report.incompleteTurn).toBeUndefined()

      await engine.endSession(sessionId)

      const paths = memoryPaths(dir, nodeStores())
      const sessionDir = await SessionStore.sessionDir(paths, sessionId)
      const summaryDoc = await readDocument(paths.files, join(sessionDir, 'summary.md'))
      const items = summaryDoc.meta.items as { text: string; ts: string }[]
      // Only the plain shape became an item: the three commitment shapes
      // already wrote straight to graph.jsonl when they were live, and
      // replaying them here would have double-recorded them.
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ text: 'Watching Halcyon tonight', ts: rememberTs })

      await engine.close()
    })

    it('reads back the persisted system prompt, falsified by mutating the stored string', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const live = await AgentSession.start(engine, testConfig(), chat, {
        now: () => new Date('2026-08-16T20:00:00.000Z'),
      })

      await engine.writeSessionSystemPrompt(live.sessionId, 'MUTATED SYSTEM PROMPT, NOT REAL')

      const chat2 = new FakeChatProvider([{ text: 'Hi.', toolCalls: [] }])
      const { session: resumed, report } = await AgentSession.resume(
        engine,
        testConfig(),
        chat2,
        live.sessionId,
        { now: () => new Date('2026-08-16T20:05:00.000Z') },
      )
      expect(report.systemPromptRestored).toBe(true)

      await collect(resumed.send('Hello again.'))
      expect(chat2.requests[0]?.system).toBe('MUTATED SYSTEM PROMPT, NOT REAL')

      await engine.close()
    })

    it('falls back to re-assembling the system prompt when none was persisted, and reports that it did', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const sessionId = await engine.startSession(new Date('2026-08-16T20:00:00.000Z'))
      await engine.setSessionMode(sessionId, 'general')
      // No system prompt was ever persisted for this session: it was
      // built directly through engine.startSession, bypassing
      // AgentSession.start entirely, so persistSystemPrompt never ran.
      const now = () => new Date('2026-08-16T20:05:00.000Z')
      const expected = await assembleSystemPrompt(engine, testConfig(), 'general', now, {})

      const chat2 = new FakeChatProvider([{ text: 'Hi.', toolCalls: [] }])
      const { session: resumed, report } = await AgentSession.resume(
        engine,
        testConfig(),
        chat2,
        sessionId,
        { now },
      )
      expect(report.systemPromptRestored).toBe(false)

      await collect(resumed.send('Hello.'))
      expect(chat2.requests[0]?.system).toBe(expected)

      await engine.close()
    })

    it('rebuilds mode from the durable session record rather than defaulting blindly', async () => {
      const chat = new FakeChatProvider([{ text: 'Listening.', toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const live = await AgentSession.start(engine, testConfig(), chat, { mode: 'listen' })

      const chat2 = new FakeChatProvider([{ text: 'Still listening.', toolCalls: [] }])
      const { session: resumed } = await AgentSession.resume(
        engine,
        testConfig(),
        chat2,
        live.sessionId,
      )
      expect(resumed.mode).toBe('listen')

      await engine.close()
    })

    it('falls back to general when a session has no recorded mode at all', async () => {
      const chat = new FakeChatProvider([{ text: 'Hi.', toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      // Built directly through the engine, bypassing setSessionMode, the
      // same "legacy or corrupt session" shape the design names.
      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'No mode was ever recorded for this one.',
      })

      const { session: resumed } = await AgentSession.resume(engine, testConfig(), chat, sessionId)
      expect(resumed.mode).toBe('general')

      await engine.close()
    })
  })

  describe('system prompt persistence guard', () => {
    it('guards every this.system assignment site with a matching persist call', async () => {
      const sourceDir = new URL('.', import.meta.url).pathname
      const source = await readFile(join(sourceDir, 'agent.ts'), 'utf8')

      const assignments = source.match(/this\.system\s*=(?!=)/g) ?? []
      // Exactly 3, matching the design's own citation (agent.ts:223, :303,
      // :514 at 8dc071f): the constructor's parameter assignment,
      // refreshSystemPrompt, and runTurn's inline update_profile
      // re-assembly. A count that moves here means a new assignment site
      // was added: go persist it at that site, then update this number
      // once the persist call is in place.
      expect(assignments.length).toBe(3)

      const constructorCalls = source.match(/new AgentSession\(/g) ?? []
      // start() and resume() are the only two callers of the private
      // constructor, so this is the constructor assignment site's other
      // half: each caller must persist right after construction, since the
      // constructor itself cannot await a write.
      expect(constructorCalls.length).toBe(2)

      const persistCalls = source.match(/(?:this|session)\.persistSystemPrompt\(\)/g) ?? []
      // Four call sites in total: one after each of the two
      // `new AgentSession(` calls above (covering the constructor's own
      // assignment), one in refreshSystemPrompt, and one in runTurn's
      // update_profile branch.
      expect(persistCalls.length).toBe(4)
    })
  })
})
