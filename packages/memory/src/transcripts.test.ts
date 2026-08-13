import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'
import { SessionStore, type TranscriptLine } from './transcripts.js'

describe('SessionStore', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-memory-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('start creates a session directory named with the date and session id', async () => {
    const now = new Date('2026-08-13T21:04:11Z')
    const store = await SessionStore.start(paths, now)

    expect(store.sessionId).toMatch(/^session_[0-9A-Z]{26}$/)
    expect(store.dir).toBe(join(paths.sessionsDir, `2026-08-13-${store.sessionId}`))

    const transcript = await readFile(join(store.dir, 'transcript.jsonl'), 'utf8')
    expect(transcript).toBe('')
  })

  it('round-trips appended lines in order', async () => {
    const now = new Date('2026-08-13T21:04:11Z')
    const store = await SessionStore.start(paths, now)

    const lines: TranscriptLine[] = [
      { ts: '2026-08-13T21:04:11Z', role: 'user', content: 'hello there' },
      { ts: '2026-08-13T21:04:12Z', role: 'assistant', content: 'hi, how are you' },
      {
        ts: '2026-08-13T21:04:13Z',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'remember', arguments: '{"text":"likes tea"}' }],
      },
      {
        ts: '2026-08-13T21:04:14Z',
        role: 'tool',
        content: 'noted',
        toolCallId: 'call_1',
      },
    ]

    for (const line of lines) {
      await store.appendLine(line)
    }

    const read = await SessionStore.readTranscript(paths, store.sessionId)
    expect(read).toEqual(lines)
  })

  it('readTranscript on a freshly started session returns an empty array', async () => {
    const now = new Date('2026-08-13T21:04:11Z')
    const store = await SessionStore.start(paths, now)

    const read = await SessionStore.readTranscript(paths, store.sessionId)
    expect(read).toEqual([])
  })

  it('open finds an existing session directory by id', async () => {
    const now = new Date('2026-08-13T21:04:11Z')
    const started = await SessionStore.start(paths, now)
    await started.appendLine({ ts: now.toISOString(), role: 'user', content: 'hello' })

    const opened = await SessionStore.open(paths, started.sessionId)
    expect(opened.dir).toBe(started.dir)
    expect(opened.sessionId).toBe(started.sessionId)

    const read = await SessionStore.readTranscript(paths, opened.sessionId)
    expect(read).toEqual([{ ts: now.toISOString(), role: 'user', content: 'hello' }])
  })

  it('open rejects an unknown session id', async () => {
    await expect(SessionStore.open(paths, 'session_doesnotexist')).rejects.toThrow(
      'session_doesnotexist',
    )
  })

  it('listSessions reports reflected false before and true after summary.md is written', async () => {
    const now = new Date('2026-08-13T21:04:11Z')
    const store = await SessionStore.start(paths, now)
    await store.appendLine({ ts: now.toISOString(), role: 'user', content: 'hello' })

    const before = await SessionStore.listSessions(paths)
    expect(before).toEqual([{ sessionId: store.sessionId, date: '2026-08-13', reflected: false }])

    await writeFile(join(store.dir, 'summary.md'), '---\nid: doc_x\n---\nSummary text.\n', 'utf8')

    const after = await SessionStore.listSessions(paths)
    expect(after).toEqual([{ sessionId: store.sessionId, date: '2026-08-13', reflected: true }])
  })

  it('listSessions returns multiple sessions sorted by directory name', async () => {
    const first = await SessionStore.start(paths, new Date('2026-08-13T09:00:00Z'))
    const second = await SessionStore.start(paths, new Date('2026-08-14T09:00:00Z'))

    const sessions = await SessionStore.listSessions(paths)
    expect(sessions).toEqual([
      { sessionId: first.sessionId, date: '2026-08-13', reflected: false },
      { sessionId: second.sessionId, date: '2026-08-14', reflected: false },
    ])
  })

  it('readTranscript silently drops a truncated final line from a crash mid-append', async () => {
    const now = new Date('2026-08-13T21:04:11Z')
    const store = await SessionStore.start(paths, now)

    const validLine = { ts: now.toISOString(), role: 'user' as const, content: 'hello' }
    await store.appendLine(validLine)

    const transcriptFile = join(store.dir, 'transcript.jsonl')
    await appendFile(transcriptFile, '{"ts":"2026-08-13T21:04:12Z","role":"assistant","c', 'utf8')

    const read = await SessionStore.readTranscript(paths, store.sessionId)
    expect(read).toEqual([validLine])
  })

  it('readTranscript throws for malformed JSON in the middle of a transcript', async () => {
    const now = new Date('2026-08-13T21:04:11Z')
    const store = await SessionStore.start(paths, now)

    const transcriptFile = join(store.dir, 'transcript.jsonl')
    await writeFile(
      transcriptFile,
      '{"ts":"2026-08-13T21:04:11Z","role":"user","content":"hello"}\n',
      'utf8',
    )
    await appendFile(transcriptFile, 'malformed\n', 'utf8')
    await appendFile(
      transcriptFile,
      '{"ts":"2026-08-13T21:04:12Z","role":"assistant","content":"hi"}\n',
      'utf8',
    )

    await expect(SessionStore.readTranscript(paths, store.sessionId)).rejects.toThrow(
      /Malformed JSON in transcript for session.*line 2/,
    )
  })
})
