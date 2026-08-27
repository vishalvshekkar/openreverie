// An in-memory implementation of the two store interfaces from store.ts.
// Two things this buys, per docs/superpowers/specs/2026-08-27-hostable-engine-design.md
// P0-1: a hermetic, fast test double with no temp directories, and a
// working sketch of what a Durable Object's storage-backed implementation
// has to satisfy (no real filesystem, single-threaded, no git).
//
// This is not a filesystem emulator. It tracks directories and files as
// two plain maps and enforces just enough of node:fs/promises' error
// behavior (ENOENT on a missing path, idempotent recursive mkdir) that
// code written against FileStore/AppendOnlyStore cannot tell the
// difference from NodeFileStore/NodeAppendStore. See memoryStore.test.ts
// for the two implementations exercised side by side.

import type { AppendOnlyStore, FileStore, MemoryStores } from './store.js'

function enoent(op: string, path: string): NodeJS.ErrnoException {
  const err = new Error(
    `ENOENT: no such file or directory, ${op} '${path}'`,
  ) as NodeJS.ErrnoException
  err.code = 'ENOENT'
  return err
}

// Directories are tracked separately from files so exists()/readdir()/stat()
// can tell a directory apart from a file the way a real filesystem does.
// Paths are plain strings split on '/', which matches every path this
// package ever builds (all of them come from node:path's join on POSIX-style
// separators; this codebase does not run on Windows).
function parentOf(path: string): string | undefined {
  const trimmed = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path
  const idx = trimmed.lastIndexOf('/')
  if (idx < 0) return undefined
  if (idx === 0) return '/'
  return trimmed.slice(0, idx)
}

function baseNameOf(path: string): string {
  const trimmed = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path
  const idx = trimmed.lastIndexOf('/')
  return idx < 0 ? trimmed : trimmed.slice(idx + 1)
}

interface FileEntry {
  data: string
  mtimeMs: number
}

export class MemoryFileStore implements FileStore {
  readonly capabilities: { versioning: boolean; locking: boolean }
  private files = new Map<string, FileEntry>()
  private dirs = new Set<string>(['/'])

  constructor(
    capabilities: { versioning: boolean; locking: boolean } = {
      versioning: true,
      locking: true,
    },
  ) {
    this.capabilities = capabilities
  }

  async readFile(path: string): Promise<string> {
    const entry = this.files.get(path)
    if (entry === undefined) throw enoent('open', path)
    return entry.data
  }

  // Atomic in the sense that matters to a caller: the write either lands
  // in full or (on the synchronous single-threaded engine this runs
  // against) is not observed half-done. There is no real temp-file dance
  // here since there is no real filesystem to crash mid-rename on.
  async writeFile(path: string, data: string): Promise<void> {
    const parent = parentOf(path)
    if (parent !== undefined) this.mkdirSync(parent)
    this.files.set(path, { data, mtimeMs: Date.now() })
  }

  async rename(from: string, to: string): Promise<void> {
    const entry = this.files.get(from)
    if (entry === undefined) throw enoent('rename', from)
    const parent = parentOf(to)
    if (parent !== undefined) this.mkdirSync(parent)
    this.files.set(to, entry)
    this.files.delete(from)
  }

  async mkdir(path: string): Promise<void> {
    this.mkdirSync(path)
  }

  private mkdirSync(path: string): void {
    const segments: string[] = []
    let current = path
    while (current !== undefined && !this.dirs.has(current)) {
      segments.push(current)
      current = parentOf(current) as string
    }
    for (const dir of segments.reverse()) this.dirs.add(dir)
  }

  async readdir(path: string): Promise<string[]> {
    if (!this.dirs.has(path)) throw enoent('scandir', path)
    const names = new Set<string>()
    for (const dir of this.dirs) {
      if (dir !== path && parentOf(dir) === path) names.add(baseNameOf(dir))
    }
    for (const file of this.files.keys()) {
      if (parentOf(file) === path) names.add(baseNameOf(file))
    }
    return [...names].sort()
  }

  async stat(path: string): Promise<{ mtimeMs: number; size: number }> {
    const entry = this.files.get(path)
    if (entry === undefined) throw enoent('stat', path)
    return { mtimeMs: entry.mtimeMs, size: Buffer.byteLength(entry.data, 'utf8') }
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path)
  }

  async rm(path: string): Promise<void> {
    if (!this.files.has(path)) throw enoent('unlink', path)
    this.files.delete(path)
  }
}

export class MemoryAppendStore implements AppendOnlyStore {
  private logs = new Map<string, string[]>()

  async create(path: string): Promise<void> {
    if (!this.logs.has(path)) this.logs.set(path, [])
  }

  async appendLines(path: string, lines: string[]): Promise<void> {
    if (lines.length === 0) return
    const existing = this.logs.get(path)
    if (existing === undefined) {
      this.logs.set(path, [...lines])
    } else {
      existing.push(...lines)
    }
  }

  async readAll(path: string): Promise<string[]> {
    return [...(this.logs.get(path) ?? [])]
  }

  async readRange(path: string, from: number, count: number): Promise<string[]> {
    if (count <= 0) return []
    return (this.logs.get(path) ?? []).slice(from, from + count)
  }
}

export function memoryStores(capabilities?: {
  versioning: boolean
  locking: boolean
}): MemoryStores {
  return { files: new MemoryFileStore(capabilities), logs: new MemoryAppendStore() }
}
