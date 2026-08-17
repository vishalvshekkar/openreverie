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
    expect(before).toEqual([
      {
        sessionId: store.sessionId,
        dirName: `2026-08-13-${store.sessionId}`,
        date: '2026-08-13',
        reflected: false,
        skipped: false,
      },
    ])

    await writeFile(join(store.dir, 'summary.md'), '---\nid: doc_x\n---\nSummary text.\n', 'utf8')

    const after = await SessionStore.listSessions(paths)
    expect(after).toEqual([
      {
        sessionId: store.sessionId,
        dirName: `2026-08-13-${store.sessionId}`,
        date: '2026-08-13',
        reflected: true,
        skipped: false,
      },
    ])
  })

  it('listSessions returns multiple sessions sorted by directory name', async () => {
    const first = await SessionStore.start(paths, new Date('2026-08-13T09:00:00Z'))
    const second = await SessionStore.start(paths, new Date('2026-08-14T09:00:00Z'))

    const sessions = await SessionStore.listSessions(paths)
    expect(sessions).toEqual([
      {
        sessionId: first.sessionId,
        dirName: `2026-08-13-${first.sessionId}`,
        date: '2026-08-13',
        reflected: false,
        skipped: false,
      },
      {
        sessionId: second.sessionId,
        dirName: `2026-08-14-${second.sessionId}`,
        date: '2026-08-14',
        reflected: false,
        skipped: false,
      },
    ])
  })

  it('listSessions reports skipped true when the summary carries skipped: true in its frontmatter', async () => {
    const now = new Date('2026-08-13T21:04:11Z')
    const store = await SessionStore.start(paths, now)

    await writeFile(
      join(store.dir, 'summary.md'),
      '---\nid: doc_x\nskipped: true\nreason: no user messages in this session\n---\nNothing happened.\n',
      'utf8',
    )

    const sessions = await SessionStore.listSessions(paths)
    expect(sessions).toEqual([
      {
        sessionId: store.sessionId,
        dirName: `2026-08-13-${store.sessionId}`,
        date: '2026-08-13',
        reflected: true,
        skipped: true,
      },
    ])
  })

  it('sessionDir resolves a session directory by its id suffix, never by its date prefix', async () => {
    const store = await SessionStore.start(paths, new Date('2026-08-13T21:04:11Z'))

    const dir = await SessionStore.sessionDir(paths, store.sessionId)
    expect(dir).toBe(join(paths.sessionsDir, `2026-08-13-${store.sessionId}`))

    await expect(SessionStore.sessionDir(paths, 'session_nope')).rejects.toThrow(
      'No session directory found for session_nope',
    )
  })

  it('listSessions reports skipped false for a summary with no skipped field at all', async () => {
    const now = new Date('2026-08-13T21:04:11Z')
    const store = await SessionStore.start(paths, now)

    await writeFile(join(store.dir, 'summary.md'), '---\nid: doc_x\n---\nSummary text.\n', 'utf8')

    const sessions = await SessionStore.listSessions(paths)
    expect(sessions[0]?.skipped).toBe(false)
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

  it('describes durable sessions and assigns one-based sequences after excluding blank and partial lines', async () => {
    const store = await SessionStore.start(paths, new Date('2026-08-13T21:04:11Z'))
    const first = { ts: '2026-08-13T21:04:11.000Z', role: 'user' as const, content: 'hello' }
    const second = { ts: '2026-08-13T21:04:12.000Z', role: 'assistant' as const, content: 'hi' }
    await appendFile(
      join(store.dir, 'transcript.jsonl'),
      `${JSON.stringify(first)}\n\n${JSON.stringify(second)}\n{"ts":"partial`,
      'utf8',
    )

    await expect(SessionStore.describe(paths)).resolves.toEqual([
      expect.objectContaining({
        sessionId: store.sessionId,
        updatedAt: second.ts,
        transcript: { lineCount: 2, userCount: 1, assistantCount: 1, toolCount: 0 },
      }),
    ])
    await expect(SessionStore.readTranscriptPage(paths, store.sessionId)).resolves.toEqual([
      { lineSequence: 1, ...first },
      { lineSequence: 2, ...second },
    ])
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

  it('reports the summary-derived date while still reporting the directory name it lives in', async () => {
    const store = await SessionStore.start(paths, new Date('2026-08-15T21:00:00Z'), 'UTC')
    await store.appendLine({
      ts: '2026-08-15T21:00:00.000Z',
      utcOffsetMinutes: 330,
      role: 'user',
      content: 'Late one.',
    })
    await writeFile(
      join(store.dir, 'summary.md'),
      '---\nid: doc_x\ndate: 2026-08-16\n---\nSummary text.\n',
      'utf8',
    )

    const sessions = await SessionStore.listSessions(paths)
    expect(sessions).toEqual([
      {
        sessionId: store.sessionId,
        dirName: `2026-08-15-${store.sessionId}`,
        date: '2026-08-16',
        reflected: true,
        skipped: false,
      },
    ])
  })

  it('derives an unreflected session date from the first transcript line, and falls back to the prefix without an offset', async () => {
    const withOffset = await SessionStore.start(paths, new Date('2026-08-15T21:00:00Z'), 'UTC')
    await withOffset.appendLine({
      ts: '2026-08-15T21:00:00.000Z',
      utcOffsetMinutes: 330,
      role: 'user',
      content: 'Late one.',
    })

    const withoutOffset = await SessionStore.start(paths, new Date('2026-08-14T21:00:00Z'), 'UTC')
    await withoutOffset.appendLine({
      ts: '2026-08-14T21:00:00.000Z',
      role: 'user',
      content: 'A line written before offsets existed.',
    })

    const empty = await SessionStore.start(paths, new Date('2026-08-13T21:00:00Z'), 'UTC')

    const sessions = await SessionStore.listSessions(paths)
    const byId = new Map(sessions.map((session) => [session.sessionId, session.date]))
    expect(byId.get(withOffset.sessionId)).toBe('2026-08-16')
    expect(byId.get(withoutOffset.sessionId)).toBe('2026-08-14')
    expect(byId.get(empty.sessionId)).toBe('2026-08-13')

    const first = await SessionStore.readFirstLine(paths, withOffset.sessionId)
    expect(first?.content).toBe('Late one.')
    expect(await SessionStore.readFirstLine(paths, empty.sessionId)).toBeUndefined()
  })
})
