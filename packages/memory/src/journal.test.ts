import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readDocument, writeDocumentAtomic } from './documents.js'
import {
  assembleJournalBody,
  JOURNALING_PROTOCOL_ABSENT,
  journalEntryFileName,
  journalEntryPath,
  readJournalingProtocol,
  readJournalingProtocolIfPresent,
  writeJournalEntry,
  writeJournalingProtocol,
} from './journal.js'
import { nodeStores } from './nodeStore.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'
import type { TranscriptLine } from './transcripts.js'

describe('journal entry filename and frontmatter', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-journal-'))
    paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('journalEntryFileName is entryDate, a dash, the doc id, and .md', () => {
    expect(journalEntryFileName('2026-08-16', 'doc_01JZZZ')).toBe('2026-08-16-doc_01JZZZ.md')
  })

  it('journalEntryPath joins the filename under journalDir', () => {
    expect(journalEntryPath(paths, '2026-08-16', 'doc_01JZZZ')).toBe(
      join(paths.journalDir, '2026-08-16-doc_01JZZZ.md'),
    )
  })

  it('two entries written on the same entryDate get distinct filenames and both sort by entryDate first', async () => {
    const first = await writeJournalEntry(paths, {
      method: 'gratitude',
      entryDate: '2026-08-16',
      recordedAt: '2026-08-16T09:00:00.000Z',
      session: 'session_01JAAA',
      body: 'Grateful for coffee.\n',
    })
    const second = await writeJournalEntry(paths, {
      method: 'open',
      entryDate: '2026-08-16',
      recordedAt: '2026-08-16T21:00:00.000Z',
      session: 'session_01JBBB',
      body: 'Just writing.\n',
    })
    expect(first.path).not.toBe(second.path)
    const entries = (await readdir(paths.journalDir)).sort()
    expect(entries).toHaveLength(2)
    expect(entries[0]?.startsWith('2026-08-16-')).toBe(true)
    expect(entries[1]?.startsWith('2026-08-16-')).toBe(true)
  })

  it('writes required frontmatter: id, kind, method, mode, entryDate, recordedAt, session', async () => {
    const doc = await writeJournalEntry(paths, {
      method: 'examen',
      entryDate: '2026-08-16',
      recordedAt: '2026-08-16T21:04:00.000Z',
      session: 'session_01JAAA',
      body: 'Right now, calm.\n',
    })
    expect(doc.meta.id).toMatch(/^doc_[0-9A-Z]{26}$/)
    expect(doc.meta.kind).toBe('journal')
    expect(doc.meta.method).toBe('examen')
    expect(doc.meta.mode).toBe('journal')
    expect(doc.meta.entryDate).toBe('2026-08-16')
    expect(doc.meta.recordedAt).toBe('2026-08-16T21:04:00.000Z')
    expect(doc.meta.session).toBe('session_01JAAA')
  })

  it('entryDate and recordedAt are independently settable and both round-trip unchanged, guarding future import', async () => {
    const written = await writeJournalEntry(paths, {
      method: 'open',
      entryDate: '2019-03-14',
      recordedAt: '2026-08-16T21:04:00.000Z',
      session: 'session_01JAAA',
      body: 'An old page, imported today.\n',
    })
    const read = await readDocument(paths.files, written.path)
    expect(read.meta.entryDate).toBe('2019-03-14')
    expect(read.meta.recordedAt).toBe('2026-08-16T21:04:00.000Z')
    expect(read.meta.entryDate).not.toBe(read.meta.recordedAt)
  })

  it('writes atomically, leaving no temp file behind', async () => {
    await writeJournalEntry(paths, {
      method: 'gratitude',
      entryDate: '2026-08-16',
      recordedAt: '2026-08-16T21:04:00.000Z',
      session: 'session_01JAAA',
      body: 'Grateful.\n',
    })
    const entries = await readdir(paths.journalDir)
    expect(entries.filter((name) => name.includes('.tmp-'))).toEqual([])
  })
})

describe('assembleJournalBody', () => {
  it('includes every non-synthetic user line verbatim and in order, for an unstructured method', () => {
    const transcript: TranscriptLine[] = [
      {
        ts: '2026-08-16T09:00:00.000Z',
        role: 'user',
        content: 'Whenever ready, just start writing.',
      },
      { ts: '2026-08-16T09:00:05.000Z', role: 'assistant', content: 'Go ahead, take your time.' },
      { ts: '2026-08-16T09:01:00.000Z', role: 'user', content: 'Today felt long but okay.' },
      { ts: '2026-08-16T09:02:00.000Z', role: 'tool', content: '{"ok":true}' },
      { ts: '2026-08-16T09:03:00.000Z', role: 'user', content: 'That is all for now.' },
    ]
    const body = assembleJournalBody(transcript, 'open')
    expect(body).toContain('Today felt long but okay.')
    expect(body).toContain('That is all for now.')
    expect(body).not.toContain('Go ahead, take your time.')
    expect(body).not.toContain('"ok":true')
    expect(body.indexOf('Today felt long but okay.')).toBeLessThan(
      body.indexOf('That is all for now.'),
    )
  })

  it('never contains transcript-sourced assistant or tool content, for any method, even if the implementation is loosened to include it', () => {
    // This test exists to be falsified deliberately in step 2 below, not
    // to pass unconditionally: see the falsification instruction there.
    const transcript: TranscriptLine[] = [
      { ts: '2026-08-16T09:00:00.000Z', role: 'user', content: 'Grateful for the quiet morning.' },
      {
        ts: '2026-08-16T09:00:05.000Z',
        role: 'assistant',
        content: 'What made that land for you?',
      },
    ]
    const body = assembleJournalBody(transcript, 'gratitude')
    expect(body).not.toContain('What made that land for you?')
  })

  it('excludes a synthetic user line while still including the ordinary lines around it', () => {
    const transcript: TranscriptLine[] = [
      {
        ts: '2026-08-16T09:00:00.000Z',
        role: 'user',
        content: 'Something before the mode switch.',
      },
      { ts: '2026-08-16T09:00:05.000Z', role: 'user', content: '/mode journal', synthetic: true },
      { ts: '2026-08-16T09:01:00.000Z', role: 'user', content: 'Something after the mode switch.' },
    ]
    const body = assembleJournalBody(transcript, 'open')
    expect(body).toContain('Something before the mode switch.')
    expect(body).toContain('Something after the mode switch.')
    expect(body).not.toContain('/mode journal')
  })

  it('interleaves the examen labels with the person answers, in the fixed order, and uses no label outside that method', () => {
    const transcript: TranscriptLine[] = [
      { ts: '2026-08-16T09:00:00.000Z', role: 'user', content: 'Tired but okay.' },
      { ts: '2026-08-16T09:01:00.000Z', role: 'user', content: 'Coffee with an old friend.' },
      { ts: '2026-08-16T09:02:00.000Z', role: 'user', content: 'A hard call with my sister.' },
      {
        ts: '2026-08-16T09:03:00.000Z',
        role: 'user',
        content: 'That I still care more than I show.',
      },
      { ts: '2026-08-16T09:04:00.000Z', role: 'user', content: 'Getting to bed earlier.' },
    ]
    const body = assembleJournalBody(transcript, 'examen')
    expect(body).toContain('Tired but okay.')
    expect(body).toContain('Coffee with an old friend.')
    expect(body).toContain('A hard call with my sister.')
    expect(body).toContain('That I still care more than I show.')
    expect(body).toContain('Getting to bed earlier.')
    const labelPattern = /\*\*([^*]+):\*\*/g
    const labelsFound = [...body.matchAll(labelPattern)].map((match) => match[1])
    const examenLabels = [
      'Right now',
      'Grateful for',
      'A moment that stirred something',
      'What that moment is telling me',
      'Looking ahead',
    ]
    for (const label of labelsFound) {
      expect(examenLabels).toContain(label)
    }
    expect(body.indexOf('Right now')).toBeLessThan(body.indexOf('Grateful for'))
    // The two assertions above cannot tell "labels emitted in the fixed
    // order" apart from "the first label silently absent": if labelsFound
    // omits 'Right now' entirely, indexOf returns -1, and -1 is still
    // less than any real index. This exact-sequence assertion is the one
    // that actually catches a missing or reordered label.
    expect(labelsFound).toEqual(examenLabels)
  })

  it('interleaves the thought record labels with the person answers, in the fixed order', () => {
    const transcript: TranscriptLine[] = [
      { ts: '2026-08-16T09:00:00.000Z', role: 'user', content: 'A meeting where I froze up.' },
      { ts: '2026-08-16T09:01:00.000Z', role: 'user', content: 'Anxious, about 70.' },
      {
        ts: '2026-08-16T09:02:00.000Z',
        role: 'user',
        content: 'Everyone thinks I am not prepared.',
      },
      { ts: '2026-08-16T09:03:00.000Z', role: 'user', content: 'I did answer two questions well.' },
      {
        ts: '2026-08-16T09:04:00.000Z',
        role: 'user',
        content: 'I stumbled on one thing, not everything.',
      },
      { ts: '2026-08-16T09:05:00.000Z', role: 'user', content: 'I can find one, actually.' },
      { ts: '2026-08-16T09:06:00.000Z', role: 'user', content: 'Down to about 40.' },
    ]
    const body = assembleJournalBody(transcript, 'thought_record')
    expect(body).toContain('**Situation:** A meeting where I froze up.')
    expect(body).toContain('**Automatic thought:** Everyone thinks I am not prepared.')
    expect(body).toContain('**Re-rated emotion:** Down to about 40.')
  })

  it('appends a surplus user line unlabeled rather than dropping it, for a structured method', () => {
    const transcript: TranscriptLine[] = [
      { ts: '2026-08-16T09:00:00.000Z', role: 'user', content: 'Calm.' },
      { ts: '2026-08-16T09:01:00.000Z', role: 'user', content: 'A walk outside.' },
      { ts: '2026-08-16T09:02:00.000Z', role: 'user', content: 'Nothing much today.' },
      { ts: '2026-08-16T09:03:00.000Z', role: 'user', content: 'Not sure.' },
      { ts: '2026-08-16T09:04:00.000Z', role: 'user', content: 'Just to rest.' },
      {
        ts: '2026-08-16T09:05:00.000Z',
        role: 'user',
        content: 'One more thing I forgot to say earlier.',
      },
    ]
    const body = assembleJournalBody(transcript, 'examen')
    expect(body).toContain('One more thing I forgot to say earlier.')
    expect(body).not.toContain('**Looking ahead:** One more thing I forgot to say earlier.')
  })
})

describe('journaling.md protocol read and write', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-journaling-'))
    paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('readJournalingProtocol returns the ABSENT sentinel when journaling.md does not exist', async () => {
    const protocol = await readJournalingProtocol(paths)
    expect(protocol).toBe(JOURNALING_PROTOCOL_ABSENT)
  })

  it('readJournalingProtocol returns the trimmed body when journaling.md exists', async () => {
    await writeDocumentAtomic(paths.files, {
      path: paths.journaling,
      meta: { id: 'doc_01JZZZ', kind: 'journaling', updated: '2026-08-16T21:04:00.000Z' },
      body: '  Gratitude, three times a week.  \n\n',
    })
    const protocol = await readJournalingProtocol(paths)
    expect(protocol).toBe('Gratitude, three times a week.')
  })

  it('readJournalingProtocolIfPresent returns undefined, not the sentinel, when absent', async () => {
    const protocol = await readJournalingProtocolIfPresent(paths)
    expect(protocol).toBeUndefined()
  })

  it('readJournalingProtocolIfPresent returns the body when present', async () => {
    await writeDocumentAtomic(paths.files, {
      path: paths.journaling,
      meta: { id: 'doc_01JZZZ', kind: 'journaling', updated: '2026-08-16T21:04:00.000Z' },
      body: 'Examen, most evenings.\n',
    })
    expect(await readJournalingProtocolIfPresent(paths)).toBe('Examen, most evenings.')
  })

  it('writeJournalingProtocol mints a new id on the very first write', async () => {
    const doc = await writeJournalingProtocol(
      paths,
      'Gratitude, three times a week.',
      new Date('2026-08-16T21:04:00.000Z'),
    )
    expect(doc.meta.id).toMatch(/^doc_[0-9A-Z]{26}$/)
    expect(doc.meta.kind).toBe('journaling')
    expect(doc.meta.updated).toBe('2026-08-16T21:04:00.000Z')
    expect(doc.body.trim()).toBe('Gratitude, three times a week.')
  })

  it('writeJournalingProtocol preserves the existing id on a revision', async () => {
    const first = await writeJournalingProtocol(
      paths,
      'Gratitude, three times a week.',
      new Date('2026-08-16T21:04:00.000Z'),
    )
    const second = await writeJournalingProtocol(
      paths,
      'Switched to the examen instead.',
      new Date('2026-08-17T10:00:00.000Z'),
    )
    expect(second.meta.id).toBe(first.meta.id)
    expect(second.body.trim()).toBe('Switched to the examen instead.')
    expect(second.meta.updated).toBe('2026-08-17T10:00:00.000Z')
  })

  it('writeJournalingProtocol is a full replace, never an append: the old body is gone after a revision', async () => {
    await writeJournalingProtocol(
      paths,
      'Gratitude, three times a week.',
      new Date('2026-08-16T21:04:00.000Z'),
    )
    const revised = await writeJournalingProtocol(
      paths,
      'Examen, most evenings.',
      new Date('2026-08-17T10:00:00.000Z'),
    )
    expect(revised.body).not.toContain('Gratitude')
  })

  // Defect: writeJournalingProtocol used to rebuild meta from scratch
  // (`{ id, kind: 'journaling', updated }`), throwing away every other
  // field a prior write had put there. That is what blocked a structured
  // journaling cadence field: the next prose rewrite, from either the
  // update_journaling_protocol tool or reflection's own rewrite, silently
  // erased it. These four tests match setSessionMode's read-merge-write
  // shape (packages/memory/src/engine.ts:863-866).
  it('preserves an unrelated pre-existing meta field across a rewrite', async () => {
    await writeDocumentAtomic(paths.files, {
      path: paths.journaling,
      meta: {
        id: 'doc_01JZZZ',
        kind: 'journaling',
        updated: '2026-08-16T21:04:00.000Z',
        cadence: 'daily',
      },
      body: 'Gratitude, three times a week.',
    })

    const revised = await writeJournalingProtocol(
      paths,
      'Switched to the examen instead.',
      new Date('2026-08-17T10:00:00.000Z'),
    )

    expect(revised.meta.cadence).toBe('daily')
  })

  it('still writes kind and a changed updated timestamp on a merged rewrite', async () => {
    await writeDocumentAtomic(paths.files, {
      path: paths.journaling,
      meta: {
        id: 'doc_01JZZZ',
        kind: 'journaling',
        updated: '2026-08-16T21:04:00.000Z',
        cadence: 'daily',
      },
      body: 'Gratitude, three times a week.',
    })

    const revised = await writeJournalingProtocol(
      paths,
      'Switched to the examen instead.',
      new Date('2026-08-17T10:00:00.000Z'),
    )

    expect(revised.meta.kind).toBe('journaling')
    expect(revised.meta.updated).toBe('2026-08-17T10:00:00.000Z')
    expect(revised.meta.updated).not.toBe('2026-08-16T21:04:00.000Z')
  })

  it('preserves the existing id across a merged rewrite', async () => {
    await writeDocumentAtomic(paths.files, {
      path: paths.journaling,
      meta: {
        id: 'doc_01JZZZ',
        kind: 'journaling',
        updated: '2026-08-16T21:04:00.000Z',
        cadence: 'daily',
      },
      body: 'Gratitude, three times a week.',
    })

    const revised = await writeJournalingProtocol(
      paths,
      'Switched to the examen instead.',
      new Date('2026-08-17T10:00:00.000Z'),
    )

    expect(revised.meta.id).toBe('doc_01JZZZ')
  })

  it('mints an id and writes normally when there is no pre-existing document to merge', async () => {
    const doc = await writeJournalingProtocol(
      paths,
      'Gratitude, three times a week.',
      new Date('2026-08-16T21:04:00.000Z'),
    )
    expect(doc.meta.id).toMatch(/^doc_[0-9A-Z]{26}$/)
    expect(doc.meta.kind).toBe('journaling')
    expect(doc.meta.updated).toBe('2026-08-16T21:04:00.000Z')
    expect(doc.meta.cadence).toBeUndefined()
  })
})
