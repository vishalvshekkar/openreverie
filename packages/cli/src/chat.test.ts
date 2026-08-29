import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ReverieConfig } from '@openreverie/core'
import { toolDefinitions } from '@openreverie/core'
import {
  appendGraph,
  type EngineDeps,
  ensureMemoryTree,
  MemoryEngine,
  memoryPaths,
  newId,
  nodeStores,
  readDocument,
  writeDocumentAtomic,
} from '@openreverie/memory'
import { type ChatProvider, FakeChatProvider, FakeEmbeddingProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ChatIo,
  countMemoryDocuments,
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
    dreaming: {
      enabled: false,
      cadence: 'daily',
      triggers: { afterSession: true, onStart: true, serverTimer: true },
      maxToolCalls: 10,
    },
  }
}

function fakeDeps(chat: FakeChatProvider): EngineDeps {
  return {
    chat,
    embeddings: new FakeEmbeddingProvider(),
    reflectionModel: 'fake-reflect',
    embeddingModel: 'fake-embed',
    timezone: 'UTC',
  }
}

function emptyReflectionJson(summary: string): string {
  return JSON.stringify({
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

// Like waitForPrompt, but waits for the Nth you> prompt rather than the
// first, for tests that need to script an answer to one prompt and then
// observe the next one before acting (e.g. triggering Ctrl-C once the
// selection-state prompt is actually up).
async function waitForPromptCount(output: string[], count: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (output.filter((chunk) => chunk.includes('you> ')).length >= count) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for ${count} you> prompts`)
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

    await expect(runChat({ engine, config, chat, io })).resolves.toEqual({ interrupted: false })

    const joined = output.join('')
    expect(joined).toContain('Hi there. Good to hear from you.')
    expect(joined).toContain('reflecting on this session...')
    expect(joined).toContain(config.memoryDir)
    expect(joined).toContain('companion')

    const summaries = await sessionSummaryFiles(dir)
    expect(summaries).toHaveLength(1)

    await engine.close()
  })

  it('renders a finished tool call as a dim, done-form notice in scrollback', async () => {
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
    expect(joined).toContain('[searched memory]')
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
      nodeStores().files,
      path.join(dir, 'sessions', summaries[0] as string, 'summary.md'),
    )
    expect(summary.meta.skipped).toBe(true)
    expect(chat.requests).toHaveLength(1)

    await engine.close()
  })

  // Before this fix, session.end() had no try/catch here: a reflection
  // failure on /bye (a provider error, or any other throw inside
  // MemoryEngine.endSession) propagated out of runChat entirely, past
  // index.ts, into main().catch(), and printed a raw stack trace with exit
  // code 1 instead of the plain message every other failure path in this
  // loop already gives.
  it('does not crash on /bye when reflection fails, and tells the user their conversation is saved and will be retried', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      { text: 'Hi there.', toolCalls: [] },
      // No third scripted reply: reflectSession's chat.complete() call
      // inside session.end() throws when the fake provider's script runs
      // out, standing in for a real provider error (a 429 or 500).
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['hello', '/bye'])

    await expect(runChat({ engine, config, chat, io })).resolves.toEqual({ interrupted: false })

    const joined = output.join('')
    expect(joined).toContain('reflecting on this session...')
    expect(joined).toContain('could not finish reflecting')
    expect(joined).toContain('reflected the next time reverie starts')
    expect(joined).not.toContain('Saved and reflected.')

    // The session is genuinely unreflected, not just reported that way:
    // no summary.md exists yet, so a future runMaintenance() will retry it.
    const summaries = await sessionSummaryFiles(dir)
    expect(summaries).toHaveLength(0)

    await engine.close()
  })

  // The first version of the /bye fix wrapped session.end() in try/catch
  // but only called printWarnings() on the success branch, so a warning
  // resolveNarratives had already recorded earlier in the same reflection
  // (the arc page skipped below) would be silently dropped if something
  // later in that same reflection then threw. This proves both halves are
  // covered: the skip is recorded as a warning, and it still reaches the
  // screen even though the reflection as a whole fails.
  //
  // The later throw is arcsDir itself being unwritable, not a timing-based
  // interruption of the hello turn: chmod happens once, before the engine
  // ever opens, and arcsDir is not touched by the hello turn at all, so
  // there is no race with any in-flight write to synchronize against. The
  // scripted reflection reply both fails to update the (deleted) Health
  // page and proposes a genuinely new arc, whose page write into the now
  // read-only arcsDir is what throws.
  it('still prints a warning recorded earlier in reflection when reflection later fails outright on /bye', async () => {
    const paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')

    const arcDocPath = path.join(paths.arcsDir, 'health.md')
    await writeDocumentAtomic(paths.files, {
      path: arcDocPath,
      meta: { id: newId('doc'), name: 'Health' },
      body: 'Original arc narrative.\n',
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_health',
        type: 'arc',
        label: 'Health',
        doc: arcDocPath,
      },
    ])
    // The user hand-deletes the page; the graph node and its doc pointer
    // both stay exactly as they were.
    await rm(arcDocPath)

    // Revoking write on arcsDir up front does not disturb anything before
    // materializeNew's createArc call: reading the existing Health arc
    // only needs read and execute, and the hello turn never touches
    // arcsDir at all.
    await chmod(paths.arcsDir, 0o500)

    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      { text: 'Hi there.', toolCalls: [] },
      {
        text: JSON.stringify({
          summary: 'Talked about health and started running.',
          items: [{ text: 'Started running', kind: 'event' }],
          attributions: [],
          newArcs: [
            {
              name: 'Running',
              realm: 'Fitness',
              reason: 'mentioned starting a new habit',
              itemIndexes: [0],
              narrative: 'Just started running.',
            },
          ],
          newPersons: [],
          newEntities: [],
          pagePromotions: [],
          arcUpdates: [{ arcId: 'arc_health', note: 'Should be skipped, the page is gone.' }],
          personUpdates: [],
          constitutionUpdate: null,
          journalingUpdate: null,
        }),
        toolCalls: [],
      },
    ])

    let engine: MemoryEngine
    try {
      engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const config = testConfig(dir)
      const { io, output } = scriptedIo(['hello', '/bye'])

      await expect(runChat({ engine, config, chat, io })).resolves.toEqual({ interrupted: false })

      const joined = output.join('')
      expect(joined).toContain('could not finish reflecting')
      expect(joined).toContain('note:')
      expect(joined).toContain('Health')

      await engine.close()
    } finally {
      await chmod(paths.arcsDir, 0o700)
    }
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
    await expect(done).resolves.toEqual({ interrupted: false })

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
    await expect(done).resolves.toEqual({ interrupted: true })

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

  it('reports interrupted: true when a second Ctrl-C ends the session idle at the prompt', async () => {
    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output, triggerInterrupt } = pendingQuestionIo()

    const done = runChat({ engine, config, chat, io })
    await waitForPrompt(output)

    triggerInterrupt() // first: reminder only, question() stays pending
    triggerInterrupt() // second: aborts the pending question() and exits

    const result = await done

    expect(result).toEqual({ interrupted: true })
    await engine.close()
  })

  it('reports interrupted: false on a normal /bye exit', async () => {
    const chat = new FakeChatProvider([{ text: emptyReflectionJson('done'), toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io } = scriptedIo(['/bye'])

    const result = await runChat({ engine, config, chat, io })

    expect(result).toEqual({ interrupted: false })
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

    await expect(runChat({ engine, config, chat, io })).resolves.toEqual({ interrupted: false })

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

    await expect(runChat({ engine, config, chat, io })).resolves.toEqual({ interrupted: true })

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

    await expect(runChat({ engine, config, chat, io })).resolves.toEqual({ interrupted: false })

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

    await expect(runChat({ engine, config, chat, io })).resolves.toEqual({ interrupted: false })

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

    await expect(runChat({ engine, config, chat, io })).resolves.toEqual({ interrupted: true })

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

describe('command loop', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'openreverie-chat-loop-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // Only requests with a `tools` field are conversation turns (the
  // greeting and each session.send()); the reflection call on /bye omits
  // `tools` entirely, so this skips it rather than mistaking its giant
  // reflection prompt (also sent as a 'user' message) for something typed
  // at the you> prompt.
  function lastUserMessage(chat: FakeChatProvider): string | undefined {
    for (let i = chat.requests.length - 1; i >= 0; i--) {
      const req = chat.requests[i]
      if (req?.tools === undefined) continue
      const messages = req.messages
      for (let j = messages.length - 1; j >= 0; j--) {
        if (messages[j]?.role === 'user') return messages[j]?.content
      }
    }
    return undefined
  }

  it('never sends an unknown command to the model', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      { text: emptyReflectionJson('Nothing happened.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['/moed listen', '/bye'])

    await runChat({ engine, config, chat, io })

    expect(lastUserMessage(chat)).toBeUndefined()
    expect(output.join('')).toContain('Unknown command: /moed. Type /help to see what there is.')

    await engine.close()
  })

  it('sends an ordinary line to the model unchanged', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      { text: 'Hi there.', toolCalls: [] },
      { text: emptyReflectionJson('Said hello.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io } = scriptedIo(['hello there', '/bye'])

    await runChat({ engine, config, chat, io })

    expect(lastUserMessage(chat)).toMatch(/hello there$/)

    await engine.close()
  })

  it('sends a doubled slash through as a literal slash', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      { text: 'Noted.', toolCalls: [] },
      { text: emptyReflectionJson('Talked about slashes.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io } = scriptedIo(['//mode', '/bye'])

    await runChat({ engine, config, chat, io })

    expect(lastUserMessage(chat)).toMatch(/\/mode$/)

    await engine.close()
  })

  it('reflects and exits on EOF, through the command table', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      { text: emptyReflectionJson('A short session.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    // No answers scripted: the first question() throws, exactly as a
    // closed readline stream does, which the loop treats like /bye.
    const { io, output } = scriptedIo([])

    await runChat({ engine, config, chat, io })

    expect(output.join('')).toContain('reflecting on this session')

    await engine.close()
  })

  // The bug this whole unit exists for: bare /mode used to list modes and
  // then let the very next line typed fall through parseInput and reach
  // the model as an ordinary chat message, so /mode then deep silently
  // sent "deep" to the companion instead of switching. lastUserMessage
  // being undefined after this run is the actual regression check; the
  // status strip check on top of it confirms the mode really did switch
  // (not just that nothing was sent), the same way the existing "shows
  // the new mode on the next strip" test at describe('status strip')
  // verifies /mode <name>.
  it('enters a selection state on bare /mode and switches on the next line, never sending that line to the model', async () => {
    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['/mode', 'deep', '/bye'])

    await runChat({ engine, config, chat, io, interactive: true })

    expect(lastUserMessage(chat)).toBeUndefined()

    // Three prompts run in this script (/mode, deep, /bye), so three strips
    // are printed: the one before /mode and the one before deep are both
    // still "general" (the mode has not switched yet when that second
    // strip is drawn, only after the "deep" line is read and processed),
    // and the third, before /bye, is the first to show the switch.
    const strips = output
      .join('')
      .split('\n')
      .filter((line) => line.includes(' · '))
    expect(strips.length).toBeGreaterThanOrEqual(3)
    expect(strips[0]).toContain('general · ')
    expect(strips[1]).toContain('general · ')
    expect(strips[2]).toContain('deep · ')

    await engine.close()
  })

  it('accepts a numbered selection the same way as a typed name', async () => {
    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    // 5 is "deep" in MODE_NAMES order, per the numbered list /mode prints.
    const { io, output } = scriptedIo(['/mode', '5', '/bye'])

    await runChat({ engine, config, chat, io, interactive: true })

    expect(lastUserMessage(chat)).toBeUndefined()
    const strips = output
      .join('')
      .split('\n')
      .filter((line) => line.includes(' · '))
    expect(strips.length).toBeGreaterThanOrEqual(3)
    expect(strips[2]).toContain('deep · ')

    await engine.close()
  })

  it('leaves the mode unchanged on an empty line after /mode, sends nothing to the model, and keeps working afterward', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      { text: 'Hi there.', toolCalls: [] },
      { text: emptyReflectionJson('Said hello.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['/mode', '', 'hello', '/bye'])

    await runChat({ engine, config, chat, io, interactive: true })

    expect(output.join('')).toContain('Mode unchanged.')
    // The empty line never reached the model, and neither did anything
    // that looks like a mode name; the ordinary "hello" typed right after
    // still goes through normally.
    expect(lastUserMessage(chat)).toMatch(/hello$/)

    const strips = output
      .join('')
      .split('\n')
      .filter((line) => line.includes(' · '))
    for (const strip of strips) expect(strip).toContain('general · ')

    await engine.close()
  })

  it('leaves the mode unchanged on unrecognised input after /mode, without sending it to the model', async () => {
    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['/mode', 'purple', '/bye'])

    await runChat({ engine, config, chat, io, interactive: true })

    expect(output.join('')).toContain('Mode unchanged.')
    expect(lastUserMessage(chat)).toBeUndefined()

    await engine.close()
  })

  // Second Ctrl-C must still exit cleanly (interrupted: true, pending
  // question() actually unblocked) while the loop is sitting at the
  // selection-state prompt, exactly as it does at the ordinary you>
  // prompt. This only holds because the selection line is read through
  // the same io.question() call the ordinary prompt uses, wired to the
  // same cancelPending() contract; a nested question() call inside the
  // command itself would not get this for free.
  it('does not break the second Ctrl-C exit contract while awaiting a mode selection', async () => {
    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output, triggerInterrupt, answerPending, cancelCount } = pendingQuestionIo()

    const done = runChat({ engine, config, chat, io })
    await waitForPrompt(output)
    answerPending('/mode')
    await waitForPromptCount(output, 2)

    triggerInterrupt() // first: reminder only, question() stays pending
    triggerInterrupt() // second: aborts the pending question() and exits

    await expect(done).resolves.toEqual({ interrupted: true })
    expect(cancelCount.value).toBeGreaterThanOrEqual(1)

    await engine.close()
  })

  // Before this fix, EOF while a mode selection was pending was consumed
  // as the selection itself: the synthesized '/bye' failed to match any
  // mode, so commandModeSelect printed a spurious "Mode unchanged." before
  // the loop's next iteration finally saw EOF again and exited. That exit
  // only worked because question() happened to reject a second time too.
  // This fake proves the fix no longer depends on that: the third call to
  // question() never settles at all (a real closed stream that blocks
  // instead of rejecting again), so a correct loop must exit on the very
  // first EOF and never make that third call. The old code parks on it
  // forever; the explicit 2000ms timeout is what turns that hang into a
  // failed test instead of a wedged suite.
  it('exits on the first EOF during a pending mode selection, without a second read and without printing Mode unchanged', async () => {
    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const output: string[] = []
    let calls = 0
    const io: ChatIo = {
      question(prompt: string) {
        output.push(prompt)
        calls += 1
        if (calls === 1) return Promise.resolve('/mode')
        if (calls === 2) return Promise.reject(new Error('readline closed'))
        // A closed stream that blocks rather than rejecting again. The
        // fixed loop must never reach this call.
        return new Promise<string>(() => {})
      },
      write(text: string) {
        output.push(text)
      },
      onInterrupt() {},
      cancelPending() {},
    }

    await expect(runChat({ engine, config, chat, io })).resolves.toEqual({ interrupted: false })

    expect(output.join('')).not.toContain('Mode unchanged.')
    expect(calls).toBe(2)

    await engine.close()
  }, 2000)

  // The owner was asked directly whether a typed command like /bye at the
  // mode selection prompt should run or cancel the selection, and chose
  // deliberately to keep cancelling: see the comment at the decision point
  // in commands.ts. This locks that choice in with a test, since it looks
  // enough like an oversight that a future contributor would plausibly
  // "fix" it. The check that matters most is the last one: /bye typed here
  // must never reach the model, which is the original bug this whole
  // selection-state feature exists to prevent.
  it('cancels the selection on a typed /bye, prints Mode unchanged, does not exit, and never sends it to the model', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      { text: emptyReflectionJson('Looked at modes, then left.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    // First /bye lands at the selection prompt and only cancels it; the
    // second /bye is read as an ordinary command on the next iteration and
    // actually ends the session.
    const { io, output } = scriptedIo(['/mode', '/bye', '/bye'])

    await expect(runChat({ engine, config, chat, io })).resolves.toEqual({ interrupted: false })

    expect(output.join('')).toContain('Mode unchanged.')
    expect(output.join('')).toContain('reflecting on this session')
    expect(lastUserMessage(chat)).toBeUndefined()

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

  // Defect 1, 2026-08-25 dreaming investigation: dreamingModel used to fall
  // back to config.models.reflection when no dreaming model was set, which
  // is exactly how one real user's dreaming broke permanently (dreaming
  // runs a tool loop; a reasoning-effort reflection model rejects function
  // tools with an HTTP 400). It must resolve through resolveDreamingModel,
  // which falls back to models.chat instead.
  it('resolves dreamingModel via resolveDreamingModel, never falling back to reflectionModel', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openreverie-cli-context-model-'))
    try {
      let seenDreamingModel: string | undefined
      const result = await openCliContext({
        loadConfig: async () => testConfig(dir),
        buildChat: () => new FakeChatProvider([]),
        buildEmbeddings: () => new FakeEmbeddingProvider(),
        openEngine: async (config, deps) => {
          seenDreamingModel = deps.dreamingModel
          return MemoryEngine.open(config.memoryDir, deps)
        },
      })

      expect(result.ok).toBe(true)
      if (result.ok) await result.engine.close()
      expect(seenDreamingModel).toBe('fake-chat')
      expect(seenDreamingModel).not.toBe('fake-reflect')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Defect 3, 2026-08-25 dreaming investigation: `reverie dream --force`
  // used to fail with "another process is already dreaming" because
  // MemoryEngine.open()'s own un-awaited onStart trigger grabbed the lock
  // before the dream command's explicit dreamNow call got to it, in the
  // same process. suppressDreamOnStart is how the dream command's own
  // engine open turns that background trigger off for itself, without
  // touching the config or any other subcommand's behavior.
  it('suppressDreamOnStart forces triggers.onStart off for this engine open only, leaving the rest of dreaming config untouched', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openreverie-cli-context-suppress-'))
    try {
      let seenDreaming: EngineDeps['dreaming']
      const result = await openCliContext({
        loadConfig: async () => ({
          ...testConfig(dir),
          dreaming: {
            enabled: true,
            cadence: 'daily',
            triggers: { afterSession: true, onStart: true, serverTimer: true },
            maxToolCalls: 10,
          },
        }),
        buildChat: () => new FakeChatProvider([]),
        buildEmbeddings: () => new FakeEmbeddingProvider(),
        openEngine: async (config, deps) => {
          seenDreaming = deps.dreaming
          return MemoryEngine.open(config.memoryDir, deps, { maintenance: false })
        },
        suppressDreamOnStart: true,
      })

      expect(result.ok).toBe(true)
      if (result.ok) await result.engine.close()
      expect(seenDreaming?.enabled).toBe(true)
      expect(seenDreaming?.triggers.onStart).toBe(false)
      expect(seenDreaming?.triggers.afterSession).toBe(true)
      expect(seenDreaming?.triggers.serverTimer).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('leaves triggers.onStart alone when suppressDreamOnStart is not set', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openreverie-cli-context-nosuppress-'))
    try {
      let seenDreaming: EngineDeps['dreaming']
      const result = await openCliContext({
        loadConfig: async () => ({
          ...testConfig(dir),
          dreaming: {
            enabled: true,
            cadence: 'daily',
            triggers: { afterSession: true, onStart: true, serverTimer: true },
            maxToolCalls: 10,
          },
        }),
        buildChat: () => new FakeChatProvider([]),
        buildEmbeddings: () => new FakeEmbeddingProvider(),
        openEngine: async (config, deps) => {
          seenDreaming = deps.dreaming
          return MemoryEngine.open(config.memoryDir, deps, { maintenance: false })
        },
      })

      expect(result.ok).toBe(true)
      if (result.ok) await result.engine.close()
      expect(seenDreaming?.triggers.onStart).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('tags a config load failure with kind: config', async () => {
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
      expect(result.kind).toBe('config')
    }
  })

  it('tags a provider construction failure with kind: provider', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openreverie-cli-context-kind-'))
    try {
      const result = await openCliContext({
        loadConfig: async () => testConfig(dir),
        buildChat: () => {
          throw new Error('unknown provider: openai2')
        },
        buildEmbeddings: () => new FakeEmbeddingProvider(),
        openEngine: async (config, deps) => MemoryEngine.open(config.memoryDir, deps),
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.kind).toBe('provider')
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('tags an engine-open failure with kind: config', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openreverie-cli-context-openfail-'))
    try {
      const result = await openCliContext({
        loadConfig: async () => testConfig(dir),
        buildChat: () => new FakeChatProvider([]),
        buildEmbeddings: () => new FakeEmbeddingProvider(),
        openEngine: async () => {
          throw new Error('engine open failed: disk full')
        },
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.kind).toBe('config')
        expect(result.message).toBe('engine open failed: disk full')
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('shows a startup phrase while the engine is opening and clears the line when it resolves', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openreverie-cli-context-spinner-'))
    try {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const output: string[] = []
      const intervals: Array<() => void> = []
      let releaseOpen!: () => void
      const gate = new Promise<void>((resolve) => {
        releaseOpen = resolve
      })
      const pending = openCliContext({
        loadConfig: async () => testConfig(dir),
        buildChat: () => chat,
        buildEmbeddings: () => new FakeEmbeddingProvider(),
        openEngine: async () => {
          await gate
          return engine
        },
        write: (text: string) => output.push(text),
        colorEnabled: true,
        setInterval: (fn: () => void, _ms: number) => {
          intervals.push(fn)
          return intervals.length
        },
        clearInterval: () => {},
      })

      // One microtask flush lets loadConfig settle and the spinner start
      // while openEngine is still pending on the gate.
      await Promise.resolve()
      expect(output[0]).toContain('Getting my thoughts in order...')

      intervals[0]?.()
      expect(output[1]).toContain('Looking back...')

      releaseOpen()
      const result = await pending
      expect(result.ok).toBe(true)
      // The clear follows the last phrase; nothing stays stranded on the
      // line for whatever the session prints next.
      expect(output[output.length - 1]).toBe('\r\x1b[K')
      if (result.ok) {
        await result.engine.close()
      } else {
        await engine.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('clears the startup spinner when the engine open fails, instead of leaving a stranded phrase', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openreverie-cli-context-spinner-fail-'))
    try {
      const output: string[] = []
      const intervals: Array<() => void> = []
      let releaseFail!: (err: Error) => void
      const gate = new Promise<MemoryEngine>((_resolve, reject) => {
        releaseFail = reject
      })
      const pending = openCliContext({
        loadConfig: async () => testConfig(dir),
        buildChat: () => new FakeChatProvider([]),
        buildEmbeddings: () => new FakeEmbeddingProvider(),
        openEngine: async () => gate,
        write: (text: string) => output.push(text),
        colorEnabled: true,
        setInterval: (fn: () => void, _ms: number) => {
          intervals.push(fn)
          return intervals.length
        },
        clearInterval: () => {},
      })

      await Promise.resolve()
      expect(output[0]).toContain('Getting my thoughts in order...')

      releaseFail(new Error('engine open failed: disk full'))
      const result = await pending
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toBe('engine open failed: disk full')
      }
      expect(output[output.length - 1]).toBe('\r\x1b[K')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('countMemoryDocuments', () => {
  it('counts the constitution plus every realm, arc, and person document', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openreverie-count-'))
    try {
      const paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await writeDocumentAtomic(paths.files, {
        path: path.join(paths.realmsDir, 'health.md'),
        meta: { id: newId('doc'), name: 'Health' },
        body: 'A realm.\n',
      })
      await writeDocumentAtomic(paths.files, {
        path: path.join(paths.arcsDir, 'checkup.md'),
        meta: { id: newId('doc'), name: 'Checkup', status: 'active' },
        body: 'An arc.\n',
      })
      await writeDocumentAtomic(paths.files, {
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

  it('does not count a skipped session summary, matching what reindex actually indexes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openreverie-count-skip-'))
    try {
      const paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')

      const reflectedDir = path.join(paths.sessionsDir, '2026-08-01-session_reflected')
      await mkdir(reflectedDir, { recursive: true })
      await writeDocumentAtomic(paths.files, {
        path: path.join(reflectedDir, 'summary.md'),
        meta: {
          id: newId('doc'),
          kind: 'summary',
          session: 'session_reflected',
          date: '2026-08-01',
        },
        body: 'A real session summary.\n',
      })

      const skippedDir = path.join(paths.sessionsDir, '2026-08-02-session_skipped')
      await mkdir(skippedDir, { recursive: true })
      await writeDocumentAtomic(paths.files, {
        path: path.join(skippedDir, 'summary.md'),
        meta: {
          id: newId('doc'),
          kind: 'summary',
          session: 'session_skipped',
          date: '2026-08-02',
          skipped: true,
          reason: 'no user messages in this session',
        },
        body: 'This session had no user messages, so there was nothing to reflect on.\n',
      })

      const count = await countMemoryDocuments(dir)
      // constitution + 1 reflected session summary; the skipped session's
      // summary is not indexed by reindexAll and must not be counted here.
      expect(count).toBe(2)
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
  // toolNotice is the permanent scrollback line, written once a tool call
  // is known to have finished, so it renders the DONE form of the shared
  // @openreverie/core label (see toolLabel), lowercased to match the
  // CLI's own dim, lowercase, bracketed aesthetic. The running form (the
  // spinner's toolStatusLabel) is covered separately in the runChat
  // scenarios below, since it is not exported on its own.
  it('maps each known tool to its honest, specific done notice', () => {
    expect(toolNotice('remember')).toBe('[remembered]')
    expect(toolNotice('set_mode')).toBe('[switched mode]')
    expect(toolNotice('search_memory')).toBe('[searched memory]')
    expect(toolNotice('read_document')).toBe('[read that back]')
    expect(toolNotice('read_transcript')).toBe('[read a past conversation]')
    expect(toolNotice('graph_query')).toBe('[traced connections]')
    expect(toolNotice('list_arcs')).toBe('[reviewed your storylines]')
    expect(toolNotice('list_realms')).toBe('[reviewed your life areas]')
    expect(toolNotice('list_people')).toBe('[looked over people]')
    expect(toolNotice('list_entities')).toBe('[looked over things]')
    expect(toolNotice('update_profile')).toBe('[updated your profile]')
    expect(toolNotice('declare_journal_method')).toBe('[set the journal format]')
    expect(toolNotice('update_journaling_protocol')).toBe('[updated your journal setup]')
    expect(toolNotice('dream_feedback')).toBe('[noted your reaction]')
  })

  it('falls back to a plain, truthful notice for an unknown tool', () => {
    expect(toolNotice('some_future_tool')).toBe('[used: some_future_tool]')
  })

  // forget is parked, not shipped: it has no notice of its own and falls
  // back to the same plain, truthful default as any other unlisted tool.
  it('has no notice of its own for forget, since the feature is parked', () => {
    expect(toolNotice('forget')).toBe('[used: forget]')
  })

  // The gap this guards: a hand-maintained label table sitting next to a
  // tool list that grows in a different file. When toolDefinitions() grew
  // from eight to thirteen, five names were never added to the CLI's old
  // TOOL_NOTICES table and fell through to the generic "[using: name]"
  // fallback. The canonical table now lives in @openreverie/core (see
  // tool-labels.test.ts for the guard on both its running and done
  // forms); this test derives the expected names from toolDefinitions()
  // itself too, never a hardcoded list, so a gap in the CLI's own
  // done-form rendering cannot reopen silently either.
  it('has a specific done notice for every tool the agent can actually call', () => {
    for (const tool of toolDefinitions()) {
      expect(toolNotice(tool.name)).not.toBe(`[used: ${tool.name}]`)
    }
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

describe('runChat status line', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'openreverie-chat-status-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('shows an animated thinking line that clears before the reply text, when colorEnabled is true', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      { text: 'Hi there.', toolCalls: [] },
      { text: emptyReflectionJson('Said hi.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['hello', '/bye'])

    await runChat({
      engine,
      config,
      chat,
      io,
      colorEnabled: true,
      setInterval: () => 1,
      clearInterval: () => {},
      now: () => 0,
    })

    const joined = output.join('')
    const clearIndex = joined.indexOf('\r\x1b[K')
    const textIndex = joined.indexOf('Hi there.')
    expect(clearIndex).toBeGreaterThanOrEqual(0)
    expect(clearIndex).toBeLessThan(textIndex)
    expect(joined).toContain('thinking')

    await engine.close()
  })

  it('shows the honest tool label while a tool call runs, distinct from the permanent bracketed notice', async () => {
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

    await runChat({
      engine,
      config,
      chat,
      io,
      colorEnabled: true,
      setInterval: () => 1,
      clearInterval: () => {},
      now: () => 0,
    })

    const joined = output.join('')
    // The permanent, dim, bracketed notice line, in the DONE form: printed
    // once the call is known to have finished (flushed here by the
    // following 'text' event) and left on screen.
    expect(joined).toContain('[searched memory]')
    // The status line's own bare, spinner-framed render of the RUNNING
    // form, distinct in wording from the DONE notice above (not just in
    // framing): with the tick fake here never firing, start() renders
    // exactly once, on the first frame, so the full frame is asserted
    // rather than just the word "searching memory".
    expect(joined).toContain('\r\x1b[2m| searching memory\x1b[0m\x1b[K')

    await engine.close()
  })

  // The running/done flip, proven two ways, and only one of them
  // discriminates a revert of the flush timing itself. toolNotice always
  // renders the DONE form now (it never has access to the running form at
  // all), so a revert of chat.ts back to writing the permanent notice
  // immediately at the 'tool' event would still print '[remembered]', the
  // same string as today, just too early: string content alone cannot
  // catch that regression. The doneNoticeIndex/spinnerIndex ordering
  // check below is what actually catches it, since the immediate-write
  // revert writes the notice before the spinner's first frame rather
  // than after. The not.toContain('[remembering]') assertion below is
  // kept as a real but separate guard: it would only fire if toolNotice
  // itself regressed to rendering the running form, which is covered
  // independently in describe('toolNotice') above and in
  // tool-labels.test.ts's parity guard, not by anything in this test.
  it('writes the DONE form to permanent scrollback, only the RUNNING form to the spinner', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      {
        text: '',
        toolCalls: [
          { id: 'call_1', name: 'remember', arguments: JSON.stringify({ text: 'a note' }) },
        ],
      },
      { text: 'Noted.', toolCalls: [] },
      { text: emptyReflectionJson('Remembered something.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['remember this', '/bye'])

    await runChat({
      engine,
      config,
      chat,
      io,
      colorEnabled: true,
      setInterval: () => 1,
      clearInterval: () => {},
      now: () => 0,
    })

    const spinnerIndex = output.indexOf('\r\x1b[2m| remembering\x1b[0m\x1b[K')
    const doneNoticeIndex = output.indexOf('\x1b[2m[remembered]\x1b[0m\n')

    expect(spinnerIndex).toBeGreaterThanOrEqual(0)
    expect(doneNoticeIndex).toBeGreaterThan(spinnerIndex)

    const joined = output.join('')
    // A separate, narrower guard than the ordering check above: the
    // running-form bracket must never appear at all, in permanent
    // scrollback or anywhere else.
    expect(joined).not.toContain('[remembering]')

    await engine.close()
  })

  // Two tool calls back to back, in the same round, per Task 3's own
  // requirement: the first tool's DONE line must be flushed before the
  // second tool's spinner starts, not held until the whole turn ends. The
  // discriminating check is each tool's own done notice landing after its
  // own spinner (firstToolDoneIndex > firstToolSpinnerIndex): comparing
  // the first tool's done index only against the second tool's spinner
  // index would not by itself catch an immediate-write revert, since an
  // immediate-write notice for call_1 still lands before call_2's spinner
  // even though it landed at the wrong moment relative to call_1's own
  // spinner.
  it('flushes the first tool call as DONE before starting the second tool call as RUNNING', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      {
        text: '',
        toolCalls: [
          { id: 'call_1', name: 'remember', arguments: JSON.stringify({ text: 'a note' }) },
          {
            id: 'call_2',
            name: 'search_memory',
            arguments: JSON.stringify({ query: 'a note' }),
          },
        ],
      },
      { text: 'Done with both.', toolCalls: [] },
      { text: emptyReflectionJson('Did two things.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['remember this and look it up', '/bye'])

    await runChat({
      engine,
      config,
      chat,
      io,
      colorEnabled: true,
      setInterval: () => 1,
      clearInterval: () => {},
      now: () => 0,
    })

    const firstToolSpinnerIndex = output.indexOf('\r\x1b[2m| remembering\x1b[0m\x1b[K')
    const firstToolDoneIndex = output.indexOf('\x1b[2m[remembered]\x1b[0m\n')
    const secondToolSpinnerIndex = output.indexOf('\r\x1b[2m| searching memory\x1b[0m\x1b[K')
    const secondToolDoneIndex = output.indexOf('\x1b[2m[searched memory]\x1b[0m\n')

    expect(firstToolSpinnerIndex).toBeGreaterThanOrEqual(0)
    expect(firstToolDoneIndex).toBeGreaterThanOrEqual(0)
    expect(secondToolSpinnerIndex).toBeGreaterThanOrEqual(0)
    expect(secondToolDoneIndex).toBeGreaterThanOrEqual(0)
    // The discriminating check: the first tool's own done notice lands
    // after the first tool's own spinner, not written immediately when
    // the 'tool' event for call_1 arrived.
    expect(firstToolDoneIndex).toBeGreaterThan(firstToolSpinnerIndex)
    // The first tool's permanent notice lands before the second tool's
    // spinner ever starts: the first call is fully narrated as finished
    // before the second call is narrated as running at all.
    expect(firstToolDoneIndex).toBeLessThan(secondToolSpinnerIndex)
    // And the second tool's own done notice only lands after its own
    // spinner started, same as the first.
    expect(secondToolDoneIndex).toBeGreaterThan(secondToolSpinnerIndex)

    await engine.close()
  })

  // Non-TTY / piped output has no spinner at all (createStatusLine is a
  // no-op when colorEnabled is false, which is runChat's own default).
  // Without a spinner, the running-form notice is the only record that a
  // tool call started, so it is written immediately, and the done-form
  // notice still follows once the call actually finishes: "started, then
  // finished" is the whole record in a piped log.
  it('writes both a RUNNING notice and a DONE notice, in order, when there is no spinner to show progress', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      {
        text: '',
        toolCalls: [
          { id: 'call_1', name: 'remember', arguments: JSON.stringify({ text: 'a note' }) },
        ],
      },
      { text: 'Noted.', toolCalls: [] },
      { text: emptyReflectionJson('Remembered something.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['remember this', '/bye'])

    // No colorEnabled passed: defaults to false, so createStatusLine's
    // start()/stop() are no-ops and canRender is false.
    await runChat({ engine, config, chat, io })

    const runningIndex = output.indexOf('[remembering]\n')
    const doneIndex = output.indexOf('[remembered]\n')

    expect(runningIndex).toBeGreaterThanOrEqual(0)
    expect(doneIndex).toBeGreaterThanOrEqual(0)
    expect(runningIndex).toBeLessThan(doneIndex)

    await engine.close()
  })

  // The mirror image of the test above: with a spinner able to render,
  // the running form lives there and only the done form ever reaches
  // permanent scrollback, so a future change to the canRender check above
  // cannot quietly start double-printing for every color-capable session.
  it('writes exactly one permanent notice for a tool call when the spinner can render it live', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      {
        text: '',
        toolCalls: [
          { id: 'call_1', name: 'remember', arguments: JSON.stringify({ text: 'a note' }) },
        ],
      },
      { text: 'Noted.', toolCalls: [] },
      { text: emptyReflectionJson('Remembered something.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['remember this', '/bye'])

    await runChat({
      engine,
      config,
      chat,
      io,
      colorEnabled: true,
      setInterval: () => 1,
      clearInterval: () => {},
      now: () => 0,
    })

    const bracketedNotices = output.filter(
      (line) => line.includes('[remembered]') || line.includes('[remembering]'),
    )
    expect(bracketedNotices).toHaveLength(1)
    expect(bracketedNotices[0]).toContain('[remembered]')

    await engine.close()
  })

  // set_mode's own DONE notice describes the call that produced the mode
  // switch, so it must land in scrollback before the '[mode: ...]' notice
  // that switch produced, not after: the tool call is fully finished
  // before its effect is announced.
  it('flushes the set_mode DONE notice before the mode notice it produced', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      {
        text: '',
        toolCalls: [
          { id: 'call_1', name: 'set_mode', arguments: JSON.stringify({ mode: 'decompress' }) },
        ],
      },
      { text: 'Switched.', toolCalls: [] },
      { text: emptyReflectionJson('Switched mode.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['switch to decompress', '/bye'])

    await runChat({ engine, config, chat, io })

    const doneIndex = output.indexOf('[switched mode]\n')
    const modeIndex = output.indexOf('[mode: decompress]\n')

    expect(doneIndex).toBeGreaterThanOrEqual(0)
    expect(modeIndex).toBeGreaterThanOrEqual(0)
    expect(doneIndex).toBeLessThan(modeIndex)

    await engine.close()
  })

  // The regression this guards: agent.ts yields the 'tool' event BEFORE
  // awaiting dispatchTool. If a second Ctrl-C lands in the window right
  // after that event is handled, chat.ts's for-await loop breaks before
  // the generator ever resumes past the yield, so dispatchTool never
  // runs at all, and the tool call never happened. Before this fix, the
  // finally backstop still flushed the DONE form there, which meant the
  // CLI could print "[remembered]" in permanent scrollback for a
  // remember() that never wrote anything: the interface lying about the
  // memory. This test fires the interrupt handler synchronously from
  // inside the write of the tool's own RUNNING notice (the non-TTY path,
  // where that notice is written immediately, giving a reliable hook
  // into the exact window), twice, so interruptLevel is already >= 2 by
  // the time chat.ts's break check runs right after handling that event.
  it('writes an INTERRUPTED notice, never the DONE form, for a tool call cut off before dispatchTool ever ran', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      {
        text: '',
        toolCalls: [
          { id: 'call_1', name: 'remember', arguments: JSON.stringify({ text: 'a note' }) },
        ],
      },
      { text: 'Noted.', toolCalls: [] },
      { text: emptyReflectionJson('Remembered something.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const output: string[] = []
    let handler: (() => void) | undefined
    let fired = false
    const io: ChatIo = {
      async question(prompt) {
        output.push(prompt)
        return 'remember this'
      },
      write(text) {
        output.push(text)
        // The non-TTY RUNNING notice for the pending 'remember' call:
        // exactly the write that happens right after the 'tool' event is
        // processed and right before chat.ts's interruptLevel check.
        // Firing the handler twice here reaches interruptLevel >= 2
        // before that check runs, so the break happens before the
        // generator resumes to actually call dispatchTool.
        if (text === '[remembering]\n' && !fired) {
          fired = true
          handler?.()
          handler?.()
        }
      },
      onInterrupt(h) {
        handler = h
      },
      cancelPending() {},
    }

    await expect(runChat({ engine, config, chat, io })).resolves.toEqual({ interrupted: true })

    const joined = output.join('')
    expect(joined).toContain('[remembering, interrupted]')
    expect(joined).not.toContain('[remembered]')

    // Independent evidence beyond wording: dispatchTool's own call to
    // MemoryEngine's remember path appends a role: 'tool' transcript
    // line once it actually runs. If that line exists, the call ran
    // regardless of what the notice said; its absence is what actually
    // proves dispatchTool never dispatched at all.
    const transcript = await soleTranscript(dir)
    expect(transcript.some((line) => line.role === 'tool')).toBe(false)

    await engine.close()
  })

  it('stays completely silent when colorEnabled is false, matching the existing no-escape guarantee', async () => {
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

    await engine.close()
  })

  // The status line has zero coverage of its stop-on-error invariant: if
  // an error path never stops it, the spinner keeps animating forever
  // over the next prompt, since neither error path (the provider throwing
  // mid turn, or either way the greeting can fail) ever emits a 'done'
  // event, which is the only other thing that stops it. Each of the three
  // tests below was confirmed to fail when its corresponding stop() call
  // was removed (see task-13-report.md for the exact failure output),
  // then confirmed to pass again once restored.

  it('clears the status line before the error message when the provider throws mid turn, in the main send loop', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      // No text at all before the throw (throwAfterTextEvents: 0 fires
      // right after the one, empty, always-yielded chunk): the 'thinking'
      // frame is still the last thing on screen when the error hits, so
      // only the catch block's own statusLine.stop() (not the 'text'
      // branch, which never runs on this path) can clear it.
      { text: '', toolCalls: [], throwAfterTextEvents: 0 },
      { text: emptyReflectionJson('Hit a snag.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['hello', '/bye'])

    await runChat({
      engine,
      config,
      chat,
      io,
      colorEnabled: true,
      setInterval: () => 1,
      clearInterval: () => {},
      now: () => 0,
    })

    const joined = output.join('')
    const errorIndex = output.findIndex((chunk) => chunk.includes('could not reach the model'))
    expect(errorIndex).toBeGreaterThan(0)
    // The write immediately before the error message must be the bare
    // clear, not a stranded animated frame: the frame is only ever
    // written by start()/tick, and the clear is only ever written by
    // stop(), so this is the direct proof the line was actually stopped
    // before the error text landed, in the correct order, not merely
    // stopped at some later point.
    expect(output[errorIndex - 1]).toBe('\r\x1b[K')
    expect(joined).toContain('thinking')

    await engine.close()
  })

  it('clears the status line when the greeting fails outright, even though that path never emits a done event', async () => {
    const chat = new FakeChatProvider([
      // Fails before yielding any real text: greet() sees only 'thinking'
      // and then ends, with no 'text' or 'done' event ever reaching
      // chat.ts's runGreeting. Only its unconditional finally can clear
      // the line.
      { text: '', toolCalls: [], throwAfterTextEvents: 0 },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['/bye'])

    await runChat({
      engine,
      config,
      chat,
      io,
      colorEnabled: true,
      setInterval: () => 1,
      clearInterval: () => {},
      now: () => 0,
    })

    const promptIndex = output.findIndex((chunk) => chunk.includes('you> '))
    expect(promptIndex).toBeGreaterThan(0)
    expect(output[promptIndex - 1]).toBe('\r\x1b[K')

    await engine.close()
  })

  it('clears the status line when the greeting times out, even though that path never emits a done event', async () => {
    vi.useFakeTimers()
    try {
      const hangingChat: ChatProvider = {
        name: 'hanging',
        async complete() {
          throw new Error('not used in this test')
        },
        stream() {
          // Never yields and never settles: the same shape core's own
          // agent.test.ts uses to force the greeting's 20 second timeout.
          return (async function* () {
            await new Promise<never>(() => {})
          })()
        },
      }
      const engine = await MemoryEngine.open(dir, {
        chat: hangingChat,
        embeddings: new FakeEmbeddingProvider(),
        reflectionModel: 'fake-reflect',
        embeddingModel: 'fake-embed',
        timezone: 'UTC',
      })
      const config = testConfig(dir)
      const { io, output } = scriptedIo(['/bye'])

      const done = runChat({
        engine,
        config,
        chat: hangingChat,
        io,
        colorEnabled: true,
        setInterval: () => 1,
        clearInterval: () => {},
        now: () => 0,
      })
      let settled = false
      done.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )

      // agent.ts's withTimeout is the only place in the whole runtime that
      // calls setTimeout on this path (the greeting's 20 second timer), so
      // vi.getTimerCount() going non-zero is an unambiguous signal that
      // runChat's real (unfaked) async setup, MemoryEngine.open()'s session
      // bookkeeping, assembling the system prompt, has reached the point of
      // registering it. Advancing the fake clock by 0ms fires nothing by
      // itself, but vitest's tickAsync always schedules its work through
      // the real setTimeout captured before faking began, so each call
      // still costs one real event-loop turn: exactly what lets that real
      // setup interleave and eventually reach the registration. Waiting
      // for the signal itself, rather than guessing how many turns it
      // needs, keeps this deterministic no matter how fast or loaded the
      // machine is: the number of turns the real setup needs is fixed by
      // its own code, not by the clock (registering the timeout takes on
      // the order of tens of turns; settling after it fires below, which
      // shares this same cap, takes on the order of thousands, since it
      // includes the /bye path and reflection). maxWaitTurns only bounds
      // how long we are willing to wait for that fixed number of turns to
      // happen, generously past what either wait ever actually needs, so
      // the cap is reached only when something is genuinely stuck, not
      // when the machine is merely slow.
      const maxWaitTurns = 20_000
      let turnsWaited = 0
      while (vi.getTimerCount() === 0 && turnsWaited < maxWaitTurns) {
        await vi.advanceTimersByTimeAsync(0)
        turnsWaited++
      }
      expect(
        vi.getTimerCount(),
        `the greeting's timeout was never registered after ${maxWaitTurns} real event-loop turns; runChat's setup (MemoryEngine session bookkeeping, system prompt assembly) appears stuck before ever reaching agent.ts's withTimeout`,
      ).toBeGreaterThan(0)

      // The timeout is now known to be registered, so one precise jump
      // past its 20 second threshold fires it deterministically: no more
      // guesswork about how many small steps are needed to cross it. This
      // mirrors agent.ts's own exported GREETING_TIMEOUT_MS default (the
      // CLI passes no greetingTimeoutMs, so AgentSession.start falls back
      // to it); if that default ever changes, the assertion below on
      // settled, not a bare vitest timeout, is what will say so.
      const greetingTimeoutMs = 20_000
      await vi.advanceTimersByTimeAsync(greetingTimeoutMs + 1)

      // Firing the timer is not the same as runChat having finished
      // reacting to it: unwinding the generator, running the /bye path,
      // and reflection all still have to happen. None of that depends on
      // fake time (withTimeout's setTimeout is the only timer anywhere on
      // this path), so it only needs more real event-loop turns, the same
      // kind used above, not more virtual time.
      let settleTurnsWaited = 0
      while (!settled && settleTurnsWaited < maxWaitTurns) {
        await vi.advanceTimersByTimeAsync(0)
        settleTurnsWaited++
      }
      expect(
        settled,
        `the greeting's timeout fired but runChat never settled within ${maxWaitTurns} real event-loop turns afterward; check whether the timeout still throws at ${greetingTimeoutMs}ms and whether the /bye reflection path is parked on the hanging provider`,
      ).toBe(true)

      await done

      const promptIndex = output.findIndex((chunk) => chunk.includes('you> '))
      expect(promptIndex).toBeGreaterThan(0)
      expect(output[promptIndex - 1]).toBe('\r\x1b[K')

      await engine.close()
    } finally {
      vi.useRealTimers()
    }
  }, 30_000)

  it('stops the status line before writing the interrupt message, so no frame is left stranded in scrollback', async () => {
    const chat = new FakeChatProvider([{ text: 'Good to see you.', toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const output: string[] = []
    let handler: (() => void) | undefined
    let fired = false
    // The status line's first (and, with this fake tick that never fires,
    // only) frame for the greeting's 'thinking' event, written the
    // instant statusLine.start('thinking') runs, before the model has
    // produced anything. Firing the interrupt right on this exact write
    // simulates Ctrl-C landing while the spinner is on screen.
    const thinkingFrame = '\r\x1b[2m| thinking\x1b[0m\x1b[K'
    const io: ChatIo = {
      async question(prompt) {
        output.push(prompt)
        return '/bye'
      },
      write(text) {
        output.push(text)
        if (text === thinkingFrame && !fired) {
          fired = true
          handler?.()
        }
      },
      onInterrupt(h) {
        handler = h
      },
      cancelPending() {},
    }

    await runChat({
      engine,
      config,
      chat,
      io,
      colorEnabled: true,
      setInterval: () => 1,
      clearInterval: () => {},
      now: () => 0,
    })

    const frameIndex = output.indexOf(thinkingFrame)
    expect(frameIndex).toBeGreaterThanOrEqual(0)
    // The very next write after the frame must be the bare clear, then
    // the interrupt message: without stopping the line first, the
    // message would be written directly after the frame with nothing
    // erasing it.
    expect(output[frameIndex + 1]).toBe('\r\x1b[K')
    expect(output[frameIndex + 2]?.toLowerCase()).toContain('finishing this reply')

    await engine.close()
  })
})

describe('status strip', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'openreverie-chat-strip-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('prints nothing when the terminal is not interactive', async () => {
    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['/bye'])

    await runChat({ engine, config, chat, io, interactive: false })

    expect(output.join('')).not.toContain(' · ')

    await engine.close()
  })

  it('prints the strip with no escape sequences when colour is off but the terminal is interactive', async () => {
    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['/bye'])

    await runChat({ engine, config, chat, io, interactive: true, colorEnabled: false })

    const text = output.join('')
    expect(text).toContain('general · warm')
    expect(text).not.toContain(String.fromCharCode(27))

    await engine.close()
  })

  it('shows the new mode on the next strip after a mode change', async () => {
    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['/mode listen', '/bye'])

    await runChat({ engine, config, chat, io, interactive: true })

    const strips = output
      .join('')
      .split('\n')
      .filter((line) => line.includes(' · '))
    // Assert the strips exist before indexing, so deleting the wiring fails
    // here with a count instead of an undefined tripping up toContain.
    expect(strips.length).toBeGreaterThanOrEqual(2)
    expect(strips[0]).toContain('general · ')
    expect(strips[1]).toContain('listen · ')

    await engine.close()
  })

  // The spinner and the strip never write in the same frame.
  it('writes no strip while a reply is streaming', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you.', toolCalls: [] },
      { text: 'Hi there.', toolCalls: [] },
      { text: emptyReflectionJson('Said hello.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['hello', '/bye'])

    await runChat({ engine, config, chat, io, interactive: true })

    const flat = output.join('')
    const stripIndex = flat.lastIndexOf(' · ')
    const replyIndex = flat.indexOf('reverie> ')
    expect(stripIndex).toBeGreaterThan(replyIndex)

    await engine.close()
  })
})
