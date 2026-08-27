// The Node implementation of the two store interfaces from store.ts, over
// today's node:fs/promises code. This is where the atomic write that used
// to live in documents.ts now lives: moved verbatim, not reimplemented, so
// temp file naming is unchanged (see writeDocumentAtomic in documents.ts,
// which now normalizes frontmatter and delegates the write itself here).

import {
  access,
  appendFile,
  mkdir as fsMkdir,
  readdir as fsReaddir,
  readFile as fsReadFile,
  rename as fsRename,
  rm as fsRm,
  stat as fsStat,
  writeFile as fsWriteFile,
  open,
} from 'node:fs/promises'
import { ulid } from 'ulid'
import type { AppendOnlyStore, FileStore, MemoryStores } from './store.js'

export class NodeFileStore implements FileStore {
  readonly capabilities = { versioning: true, locking: true }

  async readFile(path: string): Promise<string> {
    return fsReadFile(path, 'utf8')
  }

  // Moved from packages/memory/src/documents.ts's writeDocumentAtomic,
  // which used to do the temp-write-then-rename inline. Same temp path
  // shape (`${path}.tmp-${ulid()}`), same rename call, so any test that
  // pins temp file naming keeps passing unchanged.
  async writeFile(path: string, data: string): Promise<void> {
    const tmpPath = `${path}.tmp-${ulid()}`
    await fsWriteFile(tmpPath, data, 'utf8')
    await fsRename(tmpPath, path)
  }

  async rename(from: string, to: string): Promise<void> {
    await fsRename(from, to)
  }

  async mkdir(path: string): Promise<void> {
    await fsMkdir(path, { recursive: true })
  }

  async readdir(path: string): Promise<string[]> {
    // node:fs/promises' own readdir order is OS-dependent (see store.ts's
    // FileStore.readdir comment for the contract this satisfies). Sorted
    // here so this implementation and MemoryFileStore's, which has always
    // sorted, cannot be told apart by order the way memoryStore.test.ts's
    // conformance suite compares them.
    return (await fsReaddir(path)).sort()
  }

  async stat(path: string): Promise<{ mtimeMs: number; size: number }> {
    const info = await fsStat(path)
    return { mtimeMs: info.mtimeMs, size: info.size }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }

  async rm(path: string): Promise<void> {
    await fsRm(path)
  }
}

// Chunk size for readRange's bounded reads. 8 KB matches the constant
// transcripts.ts used for readFirstTranscriptLine before this module
// absorbed it: enough for any normal transcript line, small enough that
// deriving one session's logical day at session-list time does not cost
// reading the whole transcript.
const RANGE_CHUNK_BYTES = 8192

export class NodeAppendStore implements AppendOnlyStore {
  async create(path: string): Promise<void> {
    // appendFile on a path that does not exist creates it; appending ''
    // creates an empty file without writing a record. This mirrors what
    // SessionStore.start used to do directly.
    await appendFile(path, '', 'utf8')
  }

  async appendLines(path: string, lines: string[]): Promise<void> {
    if (lines.length === 0) return
    const text = lines.map((line) => `${line}\n`).join('')
    await appendFile(path, text, 'utf8')
  }

  async readAll(path: string): Promise<string[]> {
    let raw: string
    try {
      raw = await fsReadFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw err
    }
    return dropTrailingArtifact(raw.split('\n'))
  }

  // A bounded read of `count` records starting at 0-based index `from`,
  // implemented as growing chunk reads from the front of the file rather
  // than a whole-file read followed by a slice. That distinction is the
  // entire reason this method exists (see store.ts): readFirstLine calls
  // this with (path, 0, 1) once per session at listSessions time, and a
  // whole-file read there would reintroduce the O(every transcript ever
  // written) cost the original chunked implementation was written to
  // avoid.
  async readRange(path: string, from: number, count: number): Promise<string[]> {
    if (count <= 0) return []
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(path, 'r')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw err
    }
    try {
      const lines: string[] = []
      let leftover = ''
      let offset = 0
      const target = from + count
      for (;;) {
        const buffer = Buffer.alloc(RANGE_CHUNK_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, RANGE_CHUNK_BYTES, offset)
        offset += bytesRead
        if (bytesRead === 0) {
          // EOF. Whatever is left in `leftover` is the final line if the
          // file did not end with a trailing newline; if it did, leftover
          // is '' here and there is nothing to add, matching readAll's
          // rule that a trailing newline is a separator, not a record.
          if (leftover.length > 0) lines.push(leftover)
          break
        }
        const text = leftover + buffer.subarray(0, bytesRead).toString('utf8')
        const parts = text.split('\n')
        leftover = parts.pop() ?? ''
        lines.push(...parts)
        if (lines.length >= target) break
      }
      return lines.slice(from, target)
    } finally {
      await handle.close()
    }
  }
}

function dropTrailingArtifact(lines: string[]): string[] {
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    return lines.slice(0, -1)
  }
  return lines
}

export function nodeStores(): MemoryStores {
  return { files: new NodeFileStore(), logs: new NodeAppendStore() }
}
