import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ReverieConfig } from '@openreverie/core'
import {
  type EngineDeps,
  ensureMemoryTree,
  MemoryEngine,
  memoryPaths,
  newId,
  writeDocumentAtomic,
} from '@openreverie/memory'
import { FakeChatProvider, FakeEmbeddingProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type ChatIo,
  countMemoryDocuments,
  openCliContext,
  printWarnings,
  runChat,
} from './chat.js'

function testConfig(memoryDir: string): ReverieConfig {
  return {
    memoryDir,
    provider: { name: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    models: { chat: 'fake-chat', reflection: 'fake-reflect', embeddings: 'fake-embed' },
    safety: { mode: 'companion', resources: [] },
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
    arcNarratives: [],
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
      // No-op: tests that exercise interrupt behavior use interruptingIo below.
    },
  }
  return { io, output }
}

// Simulates two Ctrl-C presses arriving while the REPL is waiting on the
// first question(): the handler registered by runChat is invoked twice
// before question() resolves, mirroring a signal firing mid-wait.
function interruptingIo(): { io: ChatIo; output: string[] } {
  const output: string[] = []
  let handler: (() => void) | undefined
  const io: ChatIo = {
    async question(prompt: string) {
      output.push(prompt)
      handler?.()
      handler?.()
      return '/bye'
    },
    write(text: string) {
      output.push(text)
    },
    onInterrupt(h: () => void) {
      handler = h
    },
  }
  return { io, output }
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
    expect(joined).toContain('[searching memory: search_memory]')
    expect(joined).toContain('Found something.')

    await engine.close()
  })

  it('tells the user plainly when the agent got lost in its notes with no text reply', async () => {
    const chat = new FakeChatProvider([
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

  it('ends the session and reflects on EOF (question rejecting) just like /bye', async () => {
    const chat = new FakeChatProvider([
      { text: emptyReflectionJson('Nothing was said.'), toolCalls: [] },
    ])
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
    }

    await runChat({ engine, config, chat, io })

    const joined = output.join('')
    expect(joined).toContain('reflecting on this session...')
    const summaries = await sessionSummaryFiles(dir)
    expect(summaries).toHaveLength(1)

    await engine.close()
  })

  it('exits without reflecting after a second interrupt, saving the transcript only', async () => {
    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = interruptingIo()

    await runChat({ engine, config, chat, io })

    const joined = output.join('').toLowerCase()
    expect(joined).toContain('without reflecting')
    expect(joined).toContain('saved')
    expect(joined).not.toContain('reflecting on this session...')
    expect(chat.requests).toHaveLength(0)

    const summaries = await sessionSummaryFiles(dir)
    expect(summaries).toHaveLength(0)

    await engine.close()
  })

  it('reports plainly when the model is unreachable mid-response instead of crashing', async () => {
    const chat = new FakeChatProvider([
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
  it('counts the constitution plus every realm and arc document', async () => {
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

      const count = await countMemoryDocuments(dir)
      expect(count).toBe(3) // constitution + 1 realm + 1 arc
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
