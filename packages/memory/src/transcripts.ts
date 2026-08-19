// Append-only transcript session store. Each session gets a directory
// named sessions/YYYY-MM-DD-<sessionId>, holding transcript.jsonl (the
// verbatim message log, appended during conversation) and, once reflection
// has run, summary.md. Transcripts are sacred: this module never edits or
// deletes a line once it is written. There is deliberately no delete or
// rewrite API here.

import type { FileHandle } from 'node:fs/promises'
import {
  access,
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolCall } from '@openreverie/providers'
import { decodeTime, ulid } from 'ulid'
import { z } from 'zod'
import { newId, readDocument } from './documents.js'
import type { MemoryPaths } from './paths.js'
import { formatLocalDate, localDateFromStored } from './time.js'

export interface TranscriptLine {
  // A UTC instant, ISO 8601: record time, when this line was written down.
  ts: string
  // The offset from UTC, in minutes, of the person's timezone at the moment
  // this line was written (330 for IST, -300 for US Eastern in winter).
  // Optional because lines written before this field existed do not have
  // it, and nothing backfills it: there is no source of truth for what
  // timezone a past session was actually written in, and a wrong guess
  // presented with the confidence of a real value is worse than an honest
  // gap. Storing the offset that was actually in effect is what lets a past
  // session be rendered in the wall clock it really happened in, even after
  // the person moves.
  utcOffsetMinutes?: number
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  // Set only on lines the system wrote on the user's behalf, never on a
  // line the person typed or spoke. true or absent, never false: the
  // absence of the key means exactly what false would mean, which is why
  // no existing transcript needs migrating and no reader written before
  // this field existed breaks on it.
  synthetic?: true
}

// A small, mutable piece of per-session metadata, kept in its own file
// rather than as a marker line in the transcript. The transcript is
// append-only, and mixing a value that is rewritten on every mode change
// into that stream would mean either breaking append-only or accumulating
// one line per change that every transcript reader then has to filter out.
export const sessionMetaSchema = z.object({ mode: z.string().optional() }).passthrough()
export type SessionMeta = z.infer<typeof sessionMetaSchema>

export interface PublicTranscriptLine extends TranscriptLine {
  lineSequence: number
}

export interface TranscriptPageInput {
  lines: PublicTranscriptLine[]
}

export interface StoredSessionDescription {
  sessionId: string
  createdAt: string
  updatedAt: string
  transcript: {
    lineCount: number
    userCount: number
    assistantCount: number
    toolCount: number
  }
}

const TRANSCRIPT_FILE = 'transcript.jsonl'
const SUMMARY_FILE = 'summary.md'
const SESSION_META_FILE = 'session.json'
const SESSION_DIR_PATTERN = /^(\d{4}-\d{2}-\d{2})-(session_[0-9A-Za-z]+)$/

export class SessionStore {
  readonly sessionId: string
  readonly dir: string

  private constructor(sessionId: string, dir: string) {
    this.sessionId = sessionId
    this.dir = dir
  }

  // The directory's date prefix is a disambiguator, not a claim: every
  // consumer that needs a session's logical day derives it (see
  // listSessions), and every consumer that needs its path uses dirName.
  // Naming a new directory with the local day just keeps the common case
  // free of divergence for a human browsing the folder. The timezone
  // defaults to UTC because a bare call has no profile to read; the only
  // production caller, MemoryEngine.startSession, always passes the real
  // zone.
  static async start(paths: MemoryPaths, now: Date, timezone = 'UTC'): Promise<SessionStore> {
    const sessionId = newId('session')
    const dir = join(paths.sessionsDir, `${formatLocalDate(now, timezone)}-${sessionId}`)
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, TRANSCRIPT_FILE), '', 'utf8')
    return new SessionStore(sessionId, dir)
  }

  static async open(paths: MemoryPaths, sessionId: string): Promise<SessionStore> {
    const dir = await findSessionDir(paths, sessionId)
    return new SessionStore(sessionId, dir)
  }

  async appendLine(line: TranscriptLine): Promise<void> {
    await appendFile(join(this.dir, TRANSCRIPT_FILE), `${JSON.stringify(line)}\n`, 'utf8')
  }

  static async readTranscript(paths: MemoryPaths, sessionId: string): Promise<TranscriptLine[]> {
    const dir = await findSessionDir(paths, sessionId)
    const raw = await readFile(join(dir, TRANSCRIPT_FILE), 'utf8')
    const lines = raw.split('\n')
    const result: TranscriptLine[] = []

    // A crash during append can leave a partial final line. This is silently
    // dropped because it never fully landed. Malformed lines elsewhere indicate
    // interior corruption and throw an error naming the session and line number.
    // Blank lines are skipped anywhere.

    let lastNonBlankIndex = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (line !== undefined && line.length > 0) {
        lastNonBlankIndex = i
        break
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i]
      if (rawLine === undefined || rawLine.length === 0) continue

      try {
        const parsed = JSON.parse(rawLine) as TranscriptLine
        result.push(parsed)
      } catch {
        if (i === lastNonBlankIndex) {
          continue
        }
        throw new Error(`Malformed JSON in transcript for session ${sessionId} at line ${i + 1}`)
      }
    }

    return result
  }

  static async readTranscriptPage(
    paths: MemoryPaths,
    sessionId: string,
  ): Promise<PublicTranscriptLine[]> {
    const lines = await SessionStore.readTranscript(paths, sessionId)
    return lines.map((line, index) => ({ lineSequence: index + 1, ...line }))
  }

  static async describe(paths: MemoryPaths): Promise<StoredSessionDescription[]> {
    const sessions = await SessionStore.listSessions(paths)
    const result: StoredSessionDescription[] = []
    for (const session of sessions) {
      const lines = await SessionStore.readTranscript(paths, session.sessionId)
      const createdAt = createdAtForSession(session.sessionId, `${session.date}T00:00:00.000Z`)
      result.push({
        sessionId: session.sessionId,
        createdAt,
        updatedAt: lines.at(-1)?.ts ?? createdAt,
        transcript: {
          lineCount: lines.length,
          userCount: lines.filter((line) => line.role === 'user').length,
          assistantCount: lines.filter((line) => line.role === 'assistant').length,
          toolCount: lines.filter((line) => line.role === 'tool').length,
        },
      })
    }
    return result
  }

  static async writeMeta(paths: MemoryPaths, sessionId: string, meta: SessionMeta): Promise<void> {
    const dir = await findSessionDir(paths, sessionId)
    const target = join(dir, SESSION_META_FILE)
    const tmpPath = `${target}.tmp-${ulid()}`
    await writeFile(tmpPath, `${JSON.stringify(meta)}\n`, 'utf8')
    await rename(tmpPath, target)
  }

  // A missing file, an unreadable one, and one that fails to parse all mean
  // the same thing: this session has no recorded mode. Never a default.
  static async readMeta(paths: MemoryPaths, sessionId: string): Promise<SessionMeta | undefined> {
    let dir: string
    try {
      dir = await findSessionDir(paths, sessionId)
    } catch {
      return undefined
    }
    let raw: string
    try {
      raw = await readFile(join(dir, SESSION_META_FILE), 'utf8')
    } catch {
      return undefined
    }
    try {
      const parsed = sessionMetaSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  // The one way anything resolves a session directory from an id. It
  // matches on the id suffix and never on the date prefix, which is what
  // lets the prefix be treated as an opaque disambiguator rather than a
  // claim about which calendar day the session belongs to.
  static async sessionDir(paths: MemoryPaths, sessionId: string): Promise<string> {
    return findSessionDir(paths, sessionId)
  }

  // The first line of a session's transcript, read through a bounded chunk
  // rather than by parsing the whole file. Used to derive a session's
  // logical local day without paying O(every transcript ever written) on a
  // path that runs at every session start.
  static async readFirstLine(
    paths: MemoryPaths,
    sessionId: string,
  ): Promise<TranscriptLine | undefined> {
    const dir = await findSessionDir(paths, sessionId)
    return readFirstTranscriptLine(dir)
  }

  static async listSessions(paths: MemoryPaths): Promise<
    {
      sessionId: string
      dirName: string
      date: string
      reflected: boolean
      skipped: boolean
    }[]
  > {
    const entries = await readdir(paths.sessionsDir, { withFileTypes: true })
    const dirNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    const sessions: {
      sessionId: string
      dirName: string
      date: string
      reflected: boolean
      skipped: boolean
    }[] = []
    for (const dirName of dirNames) {
      const match = dirName.match(SESSION_DIR_PATTERN)
      if (!match) continue
      const prefixDate = match[1] as string
      const sessionId = match[2] as string
      const sessionDirPath = join(paths.sessionsDir, dirName)
      const summaryPath = join(sessionDirPath, SUMMARY_FILE)
      const reflected = await pathExists(summaryPath)

      let skipped = false
      let summaryDate: string | undefined
      if (reflected) {
        try {
          const doc = await readDocument(summaryPath)
          skipped = doc.meta.skipped === true
          if (typeof doc.meta.date === 'string') summaryDate = doc.meta.date
        } catch {
          // A summary.md that fails to parse is reflected (it exists) but
          // its skipped status is unknowable; treat it as not skipped
          // rather than throwing listSessions out for every caller. The
          // same catch means "no date available", so the derivation falls
          // through to the transcript below instead of inventing one,
          // which keeps a hand-broken summary from re-dating its session.
          skipped = false
        }
      }

      // Cheapest source first. A reflected session's date was already
      // derived and frozen into its summary at reflection time, so reading
      // it back costs nothing extra: listSessions is opening that file for
      // the skipped check anyway.
      let date = prefixDate
      if (summaryDate !== undefined) {
        date = summaryDate
      } else {
        const first = await readFirstTranscriptLine(sessionDirPath)
        if (first !== undefined && typeof first.utcOffsetMinutes === 'number') {
          date = localDateFromStored(first.ts, first.utcOffsetMinutes)
        }
      }

      // dirName is the directory exactly as readdir produced it. It is the
      // only value here that may ever be used to build a path. date is for
      // windowing, grouping, and display only.
      sessions.push({ sessionId, dirName, date, reflected, skipped })
    }
    return sessions
  }
}

function createdAtForSession(sessionId: string, fallback: string): string {
  const separator = sessionId.indexOf('_')
  if (separator < 0) return fallback
  try {
    return new Date(
      decodeTime(sessionId.slice(separator + 1) as Parameters<typeof decodeTime>[0]),
    ).toISOString()
  } catch {
    return fallback
  }
}

async function findSessionDir(paths: MemoryPaths, sessionId: string): Promise<string> {
  const entries = await readdir(paths.sessionsDir, { withFileTypes: true })
  const match = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(`-${sessionId}`))
  if (!match) {
    throw new Error(`No session directory found for ${sessionId} in ${paths.sessionsDir}.`)
  }
  return join(paths.sessionsDir, match.name)
}

const FIRST_LINE_CHUNK_BYTES = 8192

// One handle, one chunk, split at the first newline, one JSON.parse, handle
// closed. 8 KB is more than enough for a first line. Anything unreadable,
// unparseable, or absent comes back as undefined rather than throwing: the
// caller's job is to fall back, not to fail.
async function readFirstTranscriptLine(dir: string): Promise<TranscriptLine | undefined> {
  let handle: FileHandle | undefined
  try {
    handle = await open(join(dir, TRANSCRIPT_FILE), 'r')
    const buffer = Buffer.alloc(FIRST_LINE_CHUNK_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, FIRST_LINE_CHUNK_BYTES, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const newline = text.indexOf('\n')
    const first = newline >= 0 ? text.slice(0, newline) : text
    if (first.trim().length === 0) return undefined
    return JSON.parse(first) as TranscriptLine
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
