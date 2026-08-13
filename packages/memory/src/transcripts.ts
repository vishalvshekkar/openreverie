// Append-only transcript session store. Each session gets a directory
// named sessions/YYYY-MM-DD-<sessionId>, holding transcript.jsonl (the
// verbatim message log, appended during conversation) and, once reflection
// has run, summary.md. Transcripts are sacred: this module never edits or
// deletes a line once it is written. There is deliberately no delete or
// rewrite API here.

import { access, appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolCall } from '@openreverie/providers'
import { newId } from './documents.js'
import type { MemoryPaths } from './paths.js'

export interface TranscriptLine {
  ts: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
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

  static async start(paths: MemoryPaths, now: Date): Promise<SessionStore> {
    const sessionId = newId('session')
    const dir = join(paths.sessionsDir, `${formatDate(now)}-${sessionId}`)
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

  static async listSessions(
    paths: MemoryPaths,
  ): Promise<{ sessionId: string; date: string; reflected: boolean }[]> {
    const entries = await readdir(paths.sessionsDir, { withFileTypes: true })
    const dirNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    const sessions: { sessionId: string; date: string; reflected: boolean }[] = []
    for (const dirName of dirNames) {
      const match = dirName.match(SESSION_DIR_PATTERN)
      if (!match) continue
      const date = match[1] as string
      const sessionId = match[2] as string
      const reflected = await pathExists(join(paths.sessionsDir, dirName, SUMMARY_FILE))
      sessions.push({ sessionId, date, reflected })
    }
    return sessions
  }
}

function formatDate(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
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
