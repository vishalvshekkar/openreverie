import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadConfig, type ReverieConfig, saveConfig } from '@openreverie/core'
import {
  type EngineDeps,
  ensureMemoryTree,
  MemoryEngine,
  memoryPaths,
  newId,
  readDocument,
  writeDocumentAtomic,
} from '@openreverie/memory'
import { FakeChatProvider, FakeEmbeddingProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type ChatIo,
  countMemoryDocuments,
  createStylePersister,
  openCliContext,
  printWarnings,
  runChat,
  toolNotice,
} from './chat.js'
import { cyan, magenta } from './colors.js'

function testConfig(memoryDir: string): ReverieConfig {
  return {
    memoryDir,
    provider: { name: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    models: { chat: 'fake-chat', reflection: 'fake-reflect', embeddings: 'fake-embed' },
    safety: { mode: 'companion', resources: [] },
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

function emptyReflectionJson(summary: string): string {
  return JSON.stringify({
    summary,
    items: [],
    attributions: [],
    newArcs: [],
    newPersons: [],
    arcUpdates: [],
    personUpdates: [],
    constitutionUpdate: null,
  })
}

function scriptedIo(answers: string[]): { io: ChatIo; output: string[] } {
  const output: string[] = []
  const queue = [...answers]
  const io: ChatIo = {
    async question(prompt: string) {
      output.push(prompt)
      const next = queue.shift()
      if (next === undefined) {
        throw new Error('scripted io: no more answers left')
      }
      return next
    },
    write(text: string) {
      output.push(text)
    },
    onInterrupt() {
      // No-op: tests that exercise interrupt behavior use the fakes below.
    },
    cancelPending() {
      // No-op: nothing is ever left pending in this fake.
    },
  }
  return { io, output }
}

// Mirrors real node:readline/promises semantics (verified against the real
// module, not assumed): a pending question() does not settle merely
// because the registered interrupt handler runs. It only settles when
// answerPending() resolves it (as if the user pressed Enter) or
// cancelPending() rejects it (as if an AbortSignal fired), exactly the way
// index.ts's readlineChatIo wires a real rl.question()'s AbortSignal to
// the second Ctrl-C. This is the shape that let the old, instantly-
// resolving interrupt fake hide a real hang.
function pendingQuestionIo(): {
  io: ChatIo
  output: string[]
  triggerInterrupt: () => void
  answerPending: (text: string) => void
  cancelCount: { value: number }
} {
  const output: string[] = []
  let handler: (() => void) | undefined
  let pendingResolve: ((value: string) => void) | undefined
  let pendingReject: ((err: Error) => void) | undefined
  const cancelCount = { value: 0 }
  const io: ChatIo = {
    question(prompt: string) {
      output.push(prompt)
      return new Promise<string>((resolve, reject) => {
        pendingResolve = resolve
        pendingReject = reject
      })
    },
    write(text: string) {
      output.push(text)
    },
    onInterrupt(h: () => void) {
      handler = h
    },
    cancelPending() {
      cancelCount.value += 1
      pendingReject?.(new Error('The operation was aborted'))
      pendingResolve = undefined
      pendingReject = undefined
    },
  }
  return {
    io,
    output,
    triggerInterrupt: () => handler?.(),
    answerPending: (text: string) => {
      pendingResolve?.(text)
      pendingResolve = undefined
      pendingReject = undefined
    },
    cancelCount,
  }
}

// Polls output for the 'you> ' prompt instead of assuming a fixed number of
// microtask ticks, since AgentSession.start() does real async work before
// the REPL loop reaches its first question().
async function waitForPrompt(output: string[]): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (output.some((chunk) => chunk.includes('you> '))) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('timed out waiting for the you> prompt')
}

async function sessionSummaryFiles(memoryDir: string): Promise<string[]> {
  const sessionsDir = path.join(memoryDir, 'sessions')
  let entries: string[]
  try {
    entries = await readdir(sessionsDir)
  } catch {
    return []
  }
  const summaries: string[] = []
  for (const entry of entries) {
    const files = await readdir(path.join(sessionsDir, entry)).catch(() => [] as string[])
    if (files.includes('summary.md')) summaries.push(entry)
  }
  return summaries
}

// Reads the transcript.jsonl of the single session directory under
// memoryDir/sessions, for tests that need to see what actually got
// persisted rather than just the CLI's own terminal output.
async function soleTranscript(
  memoryDir: string,
): Promise<Array<{ role: string; content: string }>> {
  const sessionsDir = path.join(memoryDir, 'sessions')
  const entries = await readdir(sessionsDir)
  if (entries.length !== 1) {
    throw new Error(
      `soleTranscript: expected exactly one session directory, found ${entries.length}`,
    )
  }
  const raw = await readFile(
    path.join(sessionsDir, entries[0] as string, 'transcript.jsonl'),
    'utf8',
  )
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

describe('runChat', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'openreverie-chat-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('streams a hello then /bye session, reflects on exit, and never throws', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      { text: 'Hi there. Good to hear from you.', toolCalls: [] },
      { text: emptyReflectionJson('Said hello.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['hello', '/bye'])

    await expect(runChat({ engine, config, chat, io })).resolves.toBeUndefined()

    const joined = output.join('')
    expect(joined).toContain('Hi there. Good to hear from you.')
    expect(joined).toContain('reflecting on this session...')
    expect(joined).toContain(config.memoryDir)
    expect(joined).toContain('companion')

    const summaries = await sessionSummaryFiles(dir)
    expect(summaries).toHaveLength(1)

    await engine.close()
  })

  it('renders tool events as dim searching-memory notices', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      {
        text: '',
        toolCalls: [
          { id: 'call_1', name: 'search_memory', arguments: JSON.stringify({ query: 'run' }) },
        ],
      },
      { text: 'Found something.', toolCalls: [] },
      { text: emptyReflectionJson('Looked something up.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['what did we talk about', '/bye'])

    await runChat({ engine, config, chat, io })

    const joined = output.join('')
    expect(joined).toContain('[searching memory]')
    expect(joined).toContain('Found something.')

    await engine.close()
  })

  it('tells the user plainly when the agent got lost in its notes with no text reply', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      { text: '', toolCalls: [] },
      { text: emptyReflectionJson('Quiet session.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['are you there', '/bye'])

    await runChat({ engine, config, chat, io })

    const joined = output.join('').toLowerCase()
    expect(joined).toContain('lost')
    expect(joined).toContain('ask')

    await engine.close()
  })

  // Question rejecting on the very first call (EOF before anything is
  // typed) leaves the transcript with only the greeting, no user line.
  // That is exactly the empty-session case Part Two of this task covers:
  // the session ends via the same /bye path, but is skipped rather than
  // reflected, since there was never a user message for a reflection call
  // to run against.
  it('ends the session on EOF (question rejecting) just like /bye, and skips reflection since no user message was ever sent', async () => {
    const chat = new FakeChatProvider([{ text: 'Good to see you.', toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const output: string[] = []
    const io: ChatIo = {
      async question() {
        throw new Error('readline closed')
      },
      write(text) {
        output.push(text)
      },
      onInterrupt() {},
      cancelPending() {},
    }

    await runChat({ engine, config, chat, io })

    const joined = output.join('')
    expect(joined).toContain('reflecting on this session...')
    const summaries = await sessionSummaryFiles(dir)
    expect(summaries).toHaveLength(1)
    const summary = await readDocument(
      path.join(dir, 'sessions', summaries[0] as string, 'summary.md'),
    )
    expect(summary.meta.skipped).toBe(true)
    expect(chat.requests).toHaveLength(1)

    await engine.close()
  })

  it('reminds about /bye without hanging or aborting on the first Ctrl-C while idle at the prompt', async () => {
    // Only the greeting is ever scripted: the user never gets past the
    // idle prompt before answering /bye, so the session ends with no user
    // line and is skipped rather than reflected. No further scripted
    // response is needed.
    const chat = new FakeChatProvider([{ text: 'Good to see you.', toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output, triggerInterrupt, answerPending, cancelCount } = pendingQuestionIo()

    const done = runChat({ engine, config, chat, io })
    await waitForPrompt(output)

    triggerInterrupt()

    const joined = output.join('').toLowerCase()
    expect(joined).toContain('/bye')
    expect(joined).not.toContain('finishing this reply')
    expect(cancelCount.value).toBe(0)

    // The pending question is still alive (not aborted): answering it
    // normally proves the REPL kept waiting rather than exiting.
    answerPending('/bye')
    await expect(done).resolves.toBeUndefined()

    const joinedAfter = output.join('')
    expect(joinedAfter).toContain('reflecting on this session...')

    await engine.close()
  })

  it('exits without reflecting when a second Ctrl-C arrives idle at the prompt, actually unblocking question()', async () => {
    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output, triggerInterrupt, cancelCount } = pendingQuestionIo()

    const done = runChat({ engine, config, chat, io })
    await waitForPrompt(output)

    triggerInterrupt() // first: reminder only, question() stays pending
    triggerInterrupt() // second: aborts the pending question() and exits

    // If the pending question is never unblocked, this hangs until the
    // test's own timeout, which is exactly the bug (C1) this test guards.
    await expect(done).resolves.toBeUndefined()

    expect(cancelCount.value).toBeGreaterThanOrEqual(1)
    const joined = output.join('').toLowerCase()
    expect(joined).toContain('without reflecting')
    expect(joined).toContain('saved')
    expect(joined).not.toContain('reflecting on this session...')
    // The only request that can have reached the model is the greeting's
    // own (failed, since the script is empty) attempt, which always
    // carries an empty messages array; no user turn ever ran.
    expect(chat.requests.every((r) => r.messages.length === 0)).toBe(true)

    const summaries = await sessionSummaryFiles(dir)
    expect(summaries).toHaveLength(0)

    await engine.close()
  })

  it('finishes the streaming write on the first Ctrl-C mid-response, then reminds about /bye', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      { text: '', toolCalls: [], textChunks: ['Hel', 'lo the', 're.'] },
      { text: emptyReflectionJson('Said hi.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const output: string[] = []
    let handler: (() => void) | undefined
    let fired = false
    const answers = ['hello', '/bye']
    let cursor = 0
    const io: ChatIo = {
      async question(prompt) {
        output.push(prompt)
        const next = answers[cursor++]
        if (next === undefined) throw new Error('no more scripted answers')
        return next
      },
      write(text) {
        output.push(text)
        // Simulate a SIGINT arriving right after the first chunk of the
        // reply has already reached the terminal.
        if (text === 'Hel' && !fired) {
          fired = true
          handler?.()
        }
      },
      onInterrupt(h) {
        handler = h
      },
      cancelPending() {},
    }

    await expect(runChat({ engine, config, chat, io })).resolves.toBeUndefined()

    const joined = output.join('')
    expect(joined).toContain('Hel')
    expect(joined).toContain('lo the')
    expect(joined).toContain('re.')
    expect(joined.toLowerCase()).toContain('finishing this reply')
    expect(joined).toContain('reflecting on this session...')

    await engine.close()
  })

  it('stops streaming and exits without reflecting when a second Ctrl-C arrives mid-response', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      { text: '', toolCalls: [], textChunks: ['Hel', 'lo the', 're.'] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const output: string[] = []
    let handler: (() => void) | undefined
    let firedFirst = false
    let firedSecond = false
    const io: ChatIo = {
      async question(prompt) {
        output.push(prompt)
        return 'hello'
      },
      write(text) {
        output.push(text)
        if (text === 'Hel' && !firedFirst) {
          firedFirst = true
          handler?.()
        } else if (text === 'lo the' && !firedSecond) {
          firedSecond = true
          handler?.()
        }
      },
      onInterrupt(h) {
        handler = h
      },
      cancelPending() {},
    }

    await expect(runChat({ engine, config, chat, io })).resolves.toBeUndefined()

    const joined = output.join('')
    expect(joined).toContain('Hel')
    expect(joined).toContain('lo the')
    expect(joined).not.toContain('re.')
    expect(joined.toLowerCase()).toContain('without reflecting')
    // One request for the greeting, one for the user's turn that got cut
    // off; the second Ctrl-C stops before a third (reflection) request.
    expect(chat.requests).toHaveLength(2)

    const summaries = await sessionSummaryFiles(dir)
    expect(summaries).toHaveLength(0)

    await engine.close()
  })

  it('reports plainly when the model is unreachable mid-response instead of crashing', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      { text: 'partial', toolCalls: [], throwAfterTextEvents: 1 },
      { text: emptyReflectionJson('Hit a snag.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['hello', '/bye'])

    await expect(runChat({ engine, config, chat, io })).resolves.toBeUndefined()

    const joined = output.join('')
    expect(joined).toContain('partial')
    expect(joined.toLowerCase()).toContain('could not reach the model')

    await engine.close()
  })

  it('greets before the first prompt, streaming the greeting the same way it streams a reply', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you. How has the week been treating you?', toolCalls: [] },
      { text: 'Hi there.', toolCalls: [] },
      { text: emptyReflectionJson('Said hi.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['hello', '/bye'])

    await runChat({ engine, config, chat, io })

    const joined = output.join('')
    const greetingIndex = joined.indexOf('Good to see you. How has the week been treating you?')
    const promptIndex = joined.indexOf('you> ')
    expect(greetingIndex).toBeGreaterThanOrEqual(0)
    expect(greetingIndex).toBeLessThan(promptIndex)

    await engine.close()
  })

  it('prints nothing for the greeting when the provider fails, and still reaches the first prompt', async () => {
    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['/bye'])

    await expect(runChat({ engine, config, chat, io })).resolves.toBeUndefined()

    const joined = output.join('')
    expect(joined).toContain('you> ')
    expect(joined).not.toContain('reverie> ')

    await engine.close()
  })

  it('shows the responding message, not the idle message, on the first Ctrl-C during a streaming greeting', async () => {
    const chat = new FakeChatProvider([
      { text: '', toolCalls: [], textChunks: ['Hel', 'lo the', 're.'] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const output: string[] = []
    let handler: (() => void) | undefined
    let fired = false
    const io: ChatIo = {
      async question(prompt) {
        output.push(prompt)
        return '/bye'
      },
      write(text) {
        output.push(text)
        // A response is actively streaming (the greeting), the same as a
        // real turn: the first Ctrl-C here must say so, not the idle
        // message meant for sitting at the prompt with nothing running.
        if (text === 'Hel' && !fired) {
          fired = true
          handler?.()
        }
      },
      onInterrupt(h) {
        handler = h
      },
      cancelPending() {},
    }

    await runChat({ engine, config, chat, io })

    const joined = output.join('').toLowerCase()
    expect(joined).toContain('finishing this reply')

    await engine.close()
  })

  it('actually stops the greeting on a second Ctrl-C, instead of hanging after saying it stopped', async () => {
    const chat = new FakeChatProvider([
      { text: '', toolCalls: [], textChunks: ['Hel', 'lo the', 're.'] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const output: string[] = []
    let handler: (() => void) | undefined
    let firedFirst = false
    let firedSecond = false
    const io: ChatIo = {
      async question() {
        // A double Ctrl-C during the greeting must end runChat before it
        // ever asks a question; reaching this would mean the CLI said it
        // stopped and then kept waiting anyway.
        throw new Error('question() should not be called after a double Ctrl-C during the greeting')
      },
      write(text) {
        output.push(text)
        if (text === 'Hel' && !firedFirst) {
          firedFirst = true
          handler?.()
        } else if (text === 'lo the' && !firedSecond) {
          firedSecond = true
          handler?.()
        }
      },
      onInterrupt(h) {
        handler = h
      },
      cancelPending() {},
    }

    await expect(runChat({ engine, config, chat, io })).resolves.toBeUndefined()

    const joined = output.join('')
    expect(joined).toContain('Hel')
    expect(joined).toContain('lo the')
    expect(joined).not.toContain('re.')
    expect(joined.toLowerCase()).toContain('without reflecting')

    // The text already streamed before the second Ctrl-C persists, per
    // Task 10's abandonment guarantee (and the withTimeout fix that keeps
    // the underlying provider iterator unwinding on that path); the chunk
    // after the cutoff point does not.
    const transcript = await soleTranscript(dir)
    expect(transcript).toHaveLength(1)
    expect(transcript[0]).toMatchObject({ role: 'assistant', content: 'Hello the' })

    await engine.close()
  })
})

describe('printWarnings', () => {
  it('prints each warning as a dim note line', () => {
    const output: string[] = []
    const io = { write: (t: string) => output.push(t) }
    printWarnings(io, { warnings: ['index rebuild needed'] })
    const joined = output.join('')
    expect(joined).toContain('note: index rebuild needed')
  })

  it('prints nothing when there are no warnings', () => {
    const output: string[] = []
    const io = { write: (t: string) => output.push(t) }
    printWarnings(io, { warnings: [] })
    expect(output).toHaveLength(0)
  })
})

describe('openCliContext', () => {
  it('reports the run-setup message plainly when config is missing', async () => {
    const result = await openCliContext({
      loadConfig: async () => {
        throw new Error('No config found. Run: reverie setup')
      },
      buildChat: () => {
        throw new Error('should not be called')
      },
      buildEmbeddings: () => {
        throw new Error('should not be called')
      },
      openEngine: async () => {
        throw new Error('should not be called')
      },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toBe('No config found. Run: reverie setup')
    }
  })

  it('reports provider construction failures plainly, without opening the engine', async () => {
    let dir = ''
    dir = await mkdtemp(path.join(tmpdir(), 'openreverie-cli-context-'))
    try {
      let engineOpened = false
      const result = await openCliContext({
        loadConfig: async () => testConfig(dir),
        buildChat: () => {
          throw new Error('unknown provider: openai2')
        },
        buildEmbeddings: () => new FakeEmbeddingProvider(),
        openEngine: async (config, deps) => {
          engineOpened = true
          return MemoryEngine.open(config.memoryDir, deps)
        },
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toContain('unknown provider')
      }
      expect(engineOpened).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('opens the engine and returns it on success', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openreverie-cli-context-ok-'))
    try {
      const chat = new FakeChatProvider([])
      const result = await openCliContext({
        loadConfig: async () => testConfig(dir),
        buildChat: () => chat,
        buildEmbeddings: () => new FakeEmbeddingProvider(),
        openEngine: async (config, deps) => MemoryEngine.open(config.memoryDir, deps),
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.config.memoryDir).toBe(dir)
        await result.engine.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('countMemoryDocuments', () => {
  it('counts the constitution plus every realm, arc, and person document', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openreverie-count-'))
    try {
      const paths = memoryPaths(dir)
      await ensureMemoryTree(paths)
      await writeDocumentAtomic({
        path: path.join(paths.realmsDir, 'health.md'),
        meta: { id: newId('doc'), name: 'Health' },
        body: 'A realm.\n',
      })
      await writeDocumentAtomic({
        path: path.join(paths.arcsDir, 'checkup.md'),
        meta: { id: newId('doc'), name: 'Checkup', status: 'active' },
        body: 'An arc.\n',
      })
      await writeDocumentAtomic({
        path: path.join(paths.peopleDir, 'alex.md'),
        meta: {
          id: newId('doc'),
          name: 'Alex',
          node: 'person_1',
          opened: '2026-08-01T00:00:00.000Z',
        },
        body: 'This page is new. It grows as we talk.\n',
      })

      const count = await countMemoryDocuments(dir)
      expect(count).toBe(4) // constitution + 1 realm + 1 arc + 1 person
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('color helpers', () => {
  it('emit ANSI escapes when enabled', () => {
    expect(cyan('you> ', true)).toBe('\x1b[36myou> \x1b[0m')
    expect(magenta('reverie> ', true)).toBe('\x1b[35mreverie> \x1b[0m')
  })

  it('emit plain text with no escapes when disabled', () => {
    expect(cyan('you> ', false)).toBe('you> ')
    expect(magenta('reverie> ', false)).toBe('reverie> ')
  })
})

describe('toolNotice', () => {
  it('maps each known tool to its honest, specific notice', () => {
    expect(toolNotice('remember')).toBe('[remembering]')
    expect(toolNotice('resolve_proposal')).toBe('[updating memory]')
    expect(toolNotice('update_style')).toBe('[adjusting style]')
    expect(toolNotice('search_memory')).toBe('[searching memory]')
    expect(toolNotice('read_document')).toBe('[reading memory]')
    expect(toolNotice('read_transcript')).toBe('[reading memory]')
    expect(toolNotice('graph_query')).toBe('[checking connections]')
    expect(toolNotice('list_arcs')).toBe('[checking memory]')
    expect(toolNotice('list_realms')).toBe('[checking memory]')
  })

  it('falls back to a plain, truthful notice for an unknown tool', () => {
    expect(toolNotice('some_future_tool')).toBe('[using: some_future_tool]')
  })

  // forget is parked, not shipped: it has no notice of its own and falls
  // back to the same plain, truthful default as any other unlisted tool.
  it('has no notice of its own for forget, since the feature is parked', () => {
    expect(toolNotice('forget')).toBe('[using: forget]')
  })
})

describe('runChat speaker rendering', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'openreverie-chat-speaker-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('renders the reverie> tag before assistant text streams', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      { text: 'Hi there.', toolCalls: [] },
      { text: emptyReflectionJson('Said hi.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['hello', '/bye'])

    await runChat({ engine, config, chat, io })

    const joined = output.join('')
    const tagIndex = joined.indexOf('reverie> ')
    const textIndex = joined.indexOf('Hi there.')
    expect(tagIndex).toBeGreaterThanOrEqual(0)
    expect(tagIndex).toBeLessThan(textIndex)

    await engine.close()
  })

  it('renders colored you> and reverie> when colorEnabled is true', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      { text: 'Hi there.', toolCalls: [] },
      { text: emptyReflectionJson('Said hi.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['hello', '/bye'])

    await runChat({ engine, config, chat, io, colorEnabled: true })

    const joined = output.join('')
    expect(joined).toContain('\x1b[36myou> \x1b[0m')
    expect(joined).toContain('\x1b[35mreverie> \x1b[0m')

    await engine.close()
  })

  it('renders plain, uncolored you> and reverie> when colorEnabled is left off', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      { text: 'Hi there.', toolCalls: [] },
      { text: emptyReflectionJson('Said hi.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['hello', '/bye'])

    await runChat({ engine, config, chat, io })

    const joined = output.join('')
    expect(joined).not.toContain('\x1b[')
    expect(joined).toContain('you> ')
    expect(joined).toContain('reverie> ')

    await engine.close()
  })
})

describe('createStylePersister', () => {
  it('patches only the given axes and persists the result atomically to the same path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openreverie-style-persist-'))
    try {
      const configPath = path.join(dir, 'config.toml')
      const config = testConfig(dir)
      await saveConfig(config, configPath)

      const persist = createStylePersister(config, configPath)
      const result = await persist({ tone: 'direct' })

      expect(result).toEqual({ engagement: 'balanced', tone: 'direct', orientation: 'listening' })
      // The in-memory config object the running session holds is updated too,
      // not just the file on disk.
      expect(config.style).toEqual(result)

      const reloaded = await loadConfig(configPath)
      expect(reloaded.style).toEqual(result)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('applies a second patch on top of the first, leaving untouched axes alone', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openreverie-style-persist-2-'))
    try {
      const configPath = path.join(dir, 'config.toml')
      const config = testConfig(dir)
      await saveConfig(config, configPath)

      const persist = createStylePersister(config, configPath)
      await persist({ engagement: 'leading' })
      const result = await persist({ tone: 'snarky' })

      expect(result).toEqual({ engagement: 'leading', tone: 'snarky', orientation: 'listening' })
      const reloaded = await loadConfig(configPath)
      expect(reloaded.style).toEqual(result)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('runChat update_style tool notice', () => {
  it('renders [adjusting style] and persists the change through the wired toolDeps', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openreverie-chat-style-'))
    try {
      const configPath = path.join(dir, 'config.toml')
      const config = testConfig(dir)
      await saveConfig(config, configPath)

      const chat = new FakeChatProvider([
        { text: 'Good to see you.', toolCalls: [] },
        {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'update_style',
              arguments: JSON.stringify({ tone: 'direct' }),
            },
          ],
        },
        { text: 'Done, I will be more direct.', toolCalls: [] },
        { text: emptyReflectionJson('Changed tone.'), toolCalls: [] },
      ])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const { io, output } = scriptedIo(['talk to me more directly', '/bye'])

      await runChat({
        engine,
        config,
        chat,
        io,
        toolDeps: { updateStyle: createStylePersister(config, configPath) },
      })

      const joined = output.join('')
      expect(joined).toContain('[adjusting style]')
      expect(joined).toContain('Done, I will be more direct.')

      const reloaded = await loadConfig(configPath)
      expect(reloaded.style.tone).toBe('direct')

      await engine.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
