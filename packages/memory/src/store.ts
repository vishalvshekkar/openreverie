// The two interfaces every filesystem touch in this package goes through.
// This module imports nothing (no node builtins, no other file in this
// package) so it can be shared with a host that has no filesystem at all,
// such as a Cloudflare Durable Object. See
// docs/superpowers/specs/2026-08-27-hostable-engine-design.md, P0-1, for
// the design reasoning.
//
// Two interfaces rather than one because documents are read and written
// whole while logs only grow. Through a single byte-level interface,
// appending one transcript line would mean read-modify-write of the whole
// file, which against a 2 MB stored-value cap forces chunked rows and
// rollover machinery. Giving appends their own interface deletes that: one
// log line is one row.

// Whole-file storage: markdown documents, session.json, process.jsonl,
// .gitignore, the SQLite index file. Every write is atomic (a full
// replacement of the file's contents, never a partial one observable by a
// concurrent reader).
export interface FileStore {
  // Implementations MUST reject with an error whose .code is 'ENOENT' when
  // path does not exist, matching node:fs/promises' own readFile. Callers
  // depend on that exact code to tell "file does not exist yet" apart from
  // any other read failure: journal.ts's isEnoent and profile.ts's
  // loadProfile both catch a readFile rejection and only treat it as
  // absence when err.code === 'ENOENT', letting anything else (a
  // permissions error, a corrupt read) propagate instead of being silently
  // swallowed.
  readFile(path: string): Promise<string>
  // Atomic: write goes to a temporary path first, then a rename lands it
  // at `path` in one filesystem operation. A reader never observes a
  // partially written file. The Node implementation moves the exact
  // temp-file-then-rename code that used to live in
  // packages/memory/src/documents.ts, so temp file naming does not change.
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  // Recursive, matching node:fs/promises mkdir's { recursive: true }: does
  // not throw if the directory (or any of its ancestors) already exists.
  mkdir(path: string): Promise<void>
  // Entry names only, not full paths, matching node:fs/promises readdir's
  // default (no withFileTypes). A caller that needs to distinguish files
  // from directories cannot do so through this interface; see the call
  // sites converted for P0-1 that used to filter on Dirent.isDirectory()
  // for why that distinction turned out to be unnecessary in practice.
  //
  // Returned in sorted (ascending, code-point) order, unlike
  // node:fs/promises' own readdir, whose order is OS-dependent and
  // unspecified. This is a deliberate part of the contract, not an
  // implementation accident: MemoryFileStore (memoryStore.ts) has always
  // sorted, NodeFileStore (nodeStore.ts) now sorts to match, and every
  // production caller that cares about order already sorts on its own
  // (documents.ts, transcripts.ts, engine.ts, engineDreams.ts,
  // migrations/utcToLocalRollups.ts) or only ever builds a Set from the
  // result, so stating the order here costs nothing on disk. What it buys:
  // the conformance suite in memoryStore.test.ts can compare the two
  // implementations' readdir output directly, without normalizing it with
  // its own .sort() first, which would hide a real divergence between them.
  readdir(path: string): Promise<string[]>
  stat(path: string): Promise<{ mtimeMs: number; size: number }>
  exists(path: string): Promise<boolean>
  rm(path: string): Promise<void>
  // What an implementation can actually do, so callers can skip work that
  // has no meaning on a given host rather than have it silently no-op or
  // throw. versioning: whether git auto-commit (gitSync.ts) makes sense,
  // and whether paths.ts should seed a .gitignore at all (there is nothing
  // to ignore-from-git on a host with no git). locking: whether the dream
  // file lock (dreamSchedule.ts) needs to do anything; a Durable Object is
  // single-threaded, so there is nothing for a lock to protect there.
  readonly capabilities: { versioning: boolean; locking: boolean }
}

// Append-only storage: graph.jsonl, proposals.jsonl, dreams/log.jsonl,
// migrations.jsonl, and each session's transcript.jsonl. Deliberately no
// write, rename, or rm method. That does not make append-only
// compiler-enforced (a caller holding both a FileStore and this file's
// path could still call files.writeFile on it), but it does mean the four
// log modules that only ever touch paths.logs (graph.ts, proposals.ts,
// transcripts.ts, dreamLog.ts) can be checked for the property at their
// imports: none of them import FileStore at all.
export interface AppendOnlyStore {
  // Creates an empty file at `path` if none exists. A no-op if one already
  // does. This exists because SessionStore.start used to create a fresh
  // transcript.jsonl by appending an empty string to a path that did not
  // exist yet; appendFile('', ...) both creates the file and appends
  // nothing, and create() is the honest name for that.
  create(path: string): Promise<void>
  // Each element of `lines` is one record, without a trailing newline.
  // appendLines writes each line followed by exactly one '\n', in order.
  // Calling with an empty array appends nothing (and does not create the
  // file; use create() first).
  appendLines(path: string, lines: string[]): Promise<void>
  // A record is a line; the newline is only the separator, so returned
  // lines never include it. Semantics, matched exactly by every log module
  // this replaced (graph.ts, proposals.ts, dreamLog.ts, transcripts.ts,
  // migrations/index.ts all did this by hand before P0-1):
  //   - A path that does not exist returns an empty array, not an error.
  //     This is what let readGraphLines, proposals' readLines, and
  //     readDreamLog treat "never written" and "written but empty" the
  //     same way.
  //   - The file's raw content is split on '\n'. If the content ends with
  //     a trailing newline (the normal case: every write here ends each
  //     line with '\n'), that split produces one trailing empty string
  //     that is an artifact of the separator, not a record, and it is
  //     dropped.
  //   - Interior blank lines (including a partially written final line
  //     from a crash mid-append, which is not the same as the trailing
  //     artifact above) are NOT filtered here. Every caller already does
  //     its own blank-line and malformed-JSON handling, sometimes
  //     differently (transcripts.ts silently drops a corrupt final line
  //     as an unfinished write; graph.ts throws on a corrupt interior
  //     line), so filtering here would take that decision away from the
  //     caller. readAll only removes the one artifact that every caller
  //     agrees is not a record.
  readAll(path: string): Promise<string[]>
  // A bounded read of `count` records starting at 0-based record index
  // `from`, with the same "missing file -> []" and trailing-artifact
  // rules as readAll. This exists for transcripts.ts's readFirstLine,
  // which reads a session's opening line to derive its logical local day
  // without paying to parse the whole transcript on every session start
  // (see SessionStore.listSessions). The Node implementation must satisfy
  // that: it reads bounded chunks from the front of the file rather than
  // reading the whole file and slicing, or the property it exists for is
  // gone.
  readRange(path: string, from: number, count: number): Promise<string[]>
}

export interface MemoryStores {
  files: FileStore
  logs: AppendOnlyStore
}
