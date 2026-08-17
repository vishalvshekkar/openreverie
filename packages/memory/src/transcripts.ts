// Append-only transcript session store. Each session gets a directory
// named sessions/YYYY-MM-DD-<sessionId>, holding transcript.jsonl (the
// verbatim message log, appended during conversation) and, once reflection
// has run, summary.md. Transcripts are sacred: this module never edits or
// deletes a line once it is written. There is deliberately no delete or
// rewrite API here.

import { access, appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolCall } from '@openreverie/providers'
import { decodeTime } from 'ulid'
import { newId, readDocument } from './documents.js'
import type { MemoryPaths } from './paths.js'
import { formatLocalDate } from './time.js'

export interface TranscriptLine {
  ts: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
}

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

  // The one way anything resolves a session directory from an id. It
  // matches on the id suffix and never on the date prefix, which is what
  // lets the prefix be treated as an opaque disambiguator rather than a
  // claim about which calendar day the session belongs to.
  static async sessionDir(paths: MemoryPaths, sessionId: string): Promise<string> {
    return findSessionDir(paths, sessionId)
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
      const date = match[1] as string
      const sessionId = match[2] as string
      const summaryPath = join(paths.sessionsDir, dirName, SUMMARY_FILE)
      const reflected = await pathExists(summaryPath)
      // A session only ever counts as skipped when its summary is both
      // present and explicitly marked that way: this is the single place
      // every consumer (recentSummaries, isFirstSession, rollup dates,
      // search indexing) reads that distinction from, instead of each one
      // re-reading summary.md's frontmatter itself.
      let skipped = false
      if (reflected) {
        try {
          const doc = await readDocument(summaryPath)
          skipped = doc.meta.skipped === true
        } catch {
          // A summary.md that fails to parse is reflected (it exists) but
          // its skipped status is unknowable; treat it as not skipped
          // rather than throwing listSessions out for every caller.
          skipped = false
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
