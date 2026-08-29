// Append-only transcript session store. Each session gets a directory
// named sessions/YYYY-MM-DD-<sessionId>, holding transcript.jsonl (the
// verbatim message log, appended during conversation) and, once reflection
// has run, summary.md. Transcripts are sacred: this module never edits or
// deletes a line once it is written. There is deliberately no delete or
// rewrite API here.

import { join } from 'node:path'
import type { ToolCall } from '@openreverie/providers'
import { decodeTime } from 'ulid'
import { z } from 'zod'
import { newId, readDocument } from './documents.js'
import type { MemoryPaths } from './paths.js'
import { formatLocalDate, localDateFromStored } from './time.js'

// This module does two kinds of filesystem work. transcript.jsonl is a
// true append-only log (created once by SessionStore.start, appended to by
// appendLine, never rewritten) and stays on paths.logs throughout. Every
// other file a session directory holds (session.json, and the directory
// itself) is read and written whole, so those go through paths.files.

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
export const sessionMetaSchema = z
  .object({ mode: z.string().optional(), journalMethod: z.string().optional() })
  .passthrough()
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
  // Carried straight from listSessions, which already derives this from
  // whether summary.md exists on disk. The engine's public projection
  // needs to tell a reflected session apart from one that was interrupted
  // before reflection ran, and recomputing the same check here, a second
  // place, would let the two drift.
  reflected: boolean
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
    await paths.files.mkdir(dir)
    // create(), not appendLines with an empty array: the point is to make
    // an empty transcript.jsonl exist so a reader never has to distinguish
    // "session not started" from "session started, nothing said yet".
    await paths.logs.create(join(dir, TRANSCRIPT_FILE))
    return new SessionStore(sessionId, dir)
  }

  static async open(paths: MemoryPaths, sessionId: string): Promise<SessionStore> {
    const dir = await findSessionDir(paths, sessionId)
    return new SessionStore(sessionId, dir)
  }

  async appendLine(paths: MemoryPaths, line: TranscriptLine): Promise<void> {
    await paths.logs.appendLines(join(this.dir, TRANSCRIPT_FILE), [JSON.stringify(line)])
  }

  static async readTranscript(paths: MemoryPaths, sessionId: string): Promise<TranscriptLine[]> {
    const dir = await findSessionDir(paths, sessionId)
    const lines = await paths.logs.readAll(join(dir, TRANSCRIPT_FILE))
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
        reflected: session.reflected,
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

  // Routed through FileStore.writeFile, which now owns the exact
  // temp-file-then-rename dance this used to do inline
  // (`${target}.tmp-${ulid()}` then rename); the bytes on disk and the
  // temp file's name are unchanged.
  static async writeMeta(paths: MemoryPaths, sessionId: string, meta: SessionMeta): Promise<void> {
    const dir = await findSessionDir(paths, sessionId)
    const target = join(dir, SESSION_META_FILE)
    await paths.files.writeFile(target, `${JSON.stringify(meta)}\n`)
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
      raw = await paths.files.readFile(join(dir, SESSION_META_FILE))
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
    return readFirstTranscriptLine(paths, dir)
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
    // FileStore.readdir returns entry names only, not Dirent, so there is
    // no isDirectory() to filter on here anymore. That filter is dropped
    // rather than replaced: sessionsDir only ever holds session
    // directories in a well-formed memory folder, and a stray non-directory
    // entry would fail SESSION_DIR_PATTERN below or fall through the same
    // try/catch tolerance every read here already has, so behavior for a
    // well-formed folder is unchanged.
    const dirNames = (await paths.files.readdir(paths.sessionsDir)).sort()

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
      const reflected = await paths.files.exists(summaryPath)

      let skipped = false
      let summaryDate: string | undefined
      if (reflected) {
        try {
          const doc = await readDocument(paths.files, summaryPath)
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
        const first = await readFirstTranscriptLine(paths, sessionDirPath)
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
  // See the comment in listSessions: FileStore.readdir gives names only, so
  // the isDirectory() filter this used to have is dropped, not replaced.
  // Gated on SESSION_DIR_PATTERN, the same gate listSessions already uses,
  // rather than the bare endsWith it used to be: without it, a stray
  // non-directory entry in sessionsDir whose name happens to end with
  // `-${sessionId}` (nothing else in this folder is meant to live there,
  // but nothing used to stop it from matching either) would resolve as if
  // it were that session's own directory. This is the fail-closed shape
  // AGENTS.md asks for on a closed set of states: an entry that is not
  // shaped like a session directory can never match, not "matches unless
  // proven otherwise."
  const entries = await paths.files.readdir(paths.sessionsDir)
  const match = entries.find(
    (name) => SESSION_DIR_PATTERN.test(name) && name.endsWith(`-${sessionId}`),
  )
  if (!match) {
    throw new Error(`No session directory found for ${sessionId} in ${paths.sessionsDir}.`)
  }
  return join(paths.sessionsDir, match)
}

// A bounded read of just the first record, through AppendOnlyStore.readRange
// rather than the whole transcript. This is the reason readRange exists at
// all (see store.ts): deriving one session's logical local day at
// listSessions time must not cost reading every line of every transcript
// ever written. The Node implementation (nodeStore.ts) satisfies this with
// a real bounded chunk read; the one behavior delta from the old inline
// implementation is that a first line longer than the old 8 KB chunk used
// to silently fail to parse and fall back to the directory-prefix date,
// where the chunked readRange now keeps reading until it has one full line.
// That was never a decision, just an artifact of a fixed single read, so
// it is not preserved.
async function readFirstTranscriptLine(
  paths: MemoryPaths,
  dir: string,
): Promise<TranscriptLine | undefined> {
  try {
    const [first] = await paths.logs.readRange(join(dir, TRANSCRIPT_FILE), 0, 1)
    if (first === undefined || first.trim().length === 0) return undefined
    return JSON.parse(first) as TranscriptLine
  } catch {
    return undefined
  }
}
