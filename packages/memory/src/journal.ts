// Journal entry primitives: filename, frontmatter, and the atomic write.
// journal/ holds entries only, one markdown file per entry, never edited
// in place after it is written (see paths.ts and the journal mode spec,
// section 2). This module also holds journaling.md's protocol read/write
// helpers; see the comment above writeJournalingProtocol below.

import { join } from 'node:path'
import { type Document, newId, readDocument, writeDocumentAtomic } from './documents.js'
import type { MemoryPaths } from './paths.js'
import type { TranscriptLine } from './transcripts.js'

export type JournalMethod =
  | 'expressive_writing'
  | 'gratitude'
  | 'examen'
  | 'thought_record'
  | 'morning_pages'
  | 'open'

export interface JournalEntryInput {
  method: JournalMethod
  entryDate: string
  recordedAt: string
  session: string
  body: string
}

export function journalEntryFileName(entryDate: string, id: string): string {
  return `${entryDate}-${id}.md`
}

export function journalEntryPath(paths: MemoryPaths, entryDate: string, id: string): string {
  return join(paths.journalDir, journalEntryFileName(entryDate, id))
}

// The one place a journal entry file is created. entryDate (event time)
// and recordedAt (record time) are both taken from the caller rather than
// derived from each other, on purpose: see the journal mode spec, section
// 3, on why the split exists before an importer does.
export async function writeJournalEntry(
  paths: MemoryPaths,
  input: JournalEntryInput,
): Promise<Document> {
  const id = newId('doc')
  const path = journalEntryPath(paths, input.entryDate, id)
  await writeDocumentAtomic({
    path,
    meta: {
      id,
      kind: 'journal',
      method: input.method,
      mode: 'journal',
      entryDate: input.entryDate,
      recordedAt: input.recordedAt,
      session: input.session,
    },
    body: input.body,
  })
  return readDocument(path)
}

const EXAMEN_LABELS = [
  'Right now',
  'Grateful for',
  'A moment that stirred something',
  'What that moment is telling me',
  'Looking ahead',
] as const

const THOUGHT_RECORD_LABELS = [
  'Situation',
  'Emotion and intensity',
  'Automatic thought',
  'Evidence for',
  'Evidence against',
  'Balanced alternative',
  'Re-rated emotion',
] as const

const STRUCTURED_METHOD_LABELS: Partial<Record<JournalMethod, readonly string[]>> = {
  examen: EXAMEN_LABELS,
  thought_record: THOUGHT_RECORD_LABELS,
}

// Deterministic, not another LLM call. The only lines that ever reach the
// body are the person's own non-synthetic user-role lines, verbatim and
// never paraphrased: no assistant content, no tool content, and no
// synthetic user line (the modes spec's own /mode <name> line, written on
// the person's behalf rather than typed by them). For the two structured
// methods, a fixed set of labels this module owns is interleaved with the
// answers in order; the labels are code, never text read back out of the
// transcript. See the design decision in the plan task above for what
// happens when the number of answers does not match the label count.
export function assembleJournalBody(transcript: TranscriptLine[], method: JournalMethod): string {
  const userLines = transcript.filter((line) => line.role === 'user' && !line.synthetic)
  const labels = STRUCTURED_METHOD_LABELS[method]
  if (!labels) {
    return userLines.map((line) => line.content).join('\n\n')
  }
  return userLines
    .map((line, index) => {
      const label = labels[index]
      return label ? `**${label}:** ${line.content}` : line.content
    })
    .join('\n\n')
}

export const JOURNALING_PROTOCOL_ABSENT =
  'journaling.md does not exist yet: this person has never set up journal mode before. ' +
  'Run the first-time setup conversation before beginning any method (see the journal mode ' +
  'spec, section 7), and once it concludes, write journaling.md in full.'

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

// Only the specific "file does not exist" case is handled here; a
// permissions error or a corrupt file propagates, the same way any other
// document-read failure in this codebase already does. See the journal
// mode spec, section 4.4.
export async function readJournalingProtocol(paths: MemoryPaths): Promise<string> {
  try {
    const doc = await readDocument(paths.journaling)
    return doc.body.trim()
  } catch (err) {
    if (isEnoent(err)) return JOURNALING_PROTOCOL_ABSENT
    throw err
  }
}

export async function readJournalingProtocolIfPresent(
  paths: MemoryPaths,
): Promise<string | undefined> {
  try {
    const doc = await readDocument(paths.journaling)
    return doc.body.trim()
  } catch (err) {
    if (isEnoent(err)) return undefined
    throw err
  }
}

// The one place journaling.md is written, from either surface (the live
// update_journaling_protocol tool or reflection's journalingUpdate field).
// Always a full replace of the body, never a diff or an append, matching
// the "never edited in place" rule journal entries themselves follow.
// Any read failure other than the file being absent (a corrupt hand edit,
// for instance) is treated the same as absent here, unlike the read
// helpers above: a write should not be blocked by a document that already
// cannot be parsed.
export async function writeJournalingProtocol(
  paths: MemoryPaths,
  body: string,
  now: Date,
): Promise<Document> {
  let id: string
  try {
    const existing = await readDocument(paths.journaling)
    id = typeof existing.meta.id === 'string' ? existing.meta.id : newId('doc')
  } catch {
    id = newId('doc')
  }
  await writeDocumentAtomic({
    path: paths.journaling,
    meta: { id, kind: 'journaling', updated: now.toISOString() },
    body,
  })
  return readDocument(paths.journaling)
}
