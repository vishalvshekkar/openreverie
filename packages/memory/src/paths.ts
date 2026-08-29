// Layout of a memory folder: the fixed set of directories and files that
// make up one user's memory. Everything here is derived from a single root
// path so the rest of the engine never hardcodes a folder name.

import { join } from 'node:path'
import { newId, writeDocumentAtomic } from './documents.js'
import { starterProfileDocument } from './profile.js'
import type { AppendOnlyStore, FileStore, MemoryStores } from './store.js'

export interface MemoryPaths {
  root: string
  constitution: string
  profile: string
  migrationsLog: string
  journalDir: string
  journaling: string
  realmsDir: string
  arcsDir: string
  peopleDir: string
  sessionsDir: string
  rollupsDailyDir: string
  rollupsWeeklyDir: string
  graphLog: string
  proposals: string
  indexDb: string
  dreamsDir: string
  dreamLog: string
  // sessions/log.jsonl, beside the session directories, mirroring
  // dreamsDir/dreamLog's own layout. This cannot collide with a session
  // directory: both SessionStore.listSessions and its findSessionDir
  // helper (transcripts.ts) gate every entry of sessionsDir on
  // SESSION_DIR_PATTERN (`^\d{4}-\d{2}-\d{2}-session_[0-9A-Za-z]+$`)
  // before treating it as a session, so a bare `log.jsonl` entry never
  // matches and is silently skipped by both. walkAllDocuments's own
  // sessionsDir scan (engine.ts) has no such gate, but it only ever joins
  // each entry name with `summary.md` and tries to read that path; joining
  // a file (not a directory) with a further path segment fails to open,
  // which that scan already tolerates as "no summary.md yet, not reflected".
  reflectionLog: string
  files: FileStore
  logs: AppendOnlyStore
}

// `stores` is required, not defaulted, because store.ts (which FileStore
// and AppendOnlyStore come from) imports nothing and so cannot construct a
// default implementation for this function to fall back to. Every caller
// passes one explicitly; nodeStore.ts's nodeStores() is what self-hosted
// callers (cli, server, tests) pass. See
// docs/superpowers/specs/2026-08-27-hostable-engine-design.md, P0-1.
export function memoryPaths(root: string, stores: MemoryStores): MemoryPaths {
  return {
    root,
    constitution: join(root, 'constitution.md'),
    profile: join(root, 'profile.md'),
    migrationsLog: join(root, 'migrations.jsonl'),
    journalDir: join(root, 'journal'),
    journaling: join(root, 'journaling.md'),
    realmsDir: join(root, 'realms'),
    arcsDir: join(root, 'arcs'),
    peopleDir: join(root, 'people'),
    sessionsDir: join(root, 'sessions'),
    rollupsDailyDir: join(root, 'rollups', 'daily'),
    rollupsWeeklyDir: join(root, 'rollups', 'weekly'),
    graphLog: join(root, 'graph.jsonl'),
    proposals: join(root, 'proposals.jsonl'),
    indexDb: join(root, 'index.db'),
    dreamsDir: join(root, 'dreams'),
    dreamLog: join(root, 'dreams', 'log.jsonl'),
    reflectionLog: join(root, 'sessions', 'log.jsonl'),
    files: stores.files,
    logs: stores.logs,
  }
}

const CONSTITUTION_STARTER = 'This constitution is empty. It grows as we talk.\n'

export async function ensureMemoryTree(paths: MemoryPaths, timezone: string): Promise<void> {
  await paths.files.mkdir(paths.root)
  for (const dir of [
    paths.realmsDir,
    paths.arcsDir,
    paths.peopleDir,
    paths.sessionsDir,
    paths.rollupsDailyDir,
    paths.rollupsWeeklyDir,
    paths.journalDir,
    paths.dreamsDir,
  ]) {
    await paths.files.mkdir(dir)
  }

  const constitutionExists = await paths.files.exists(paths.constitution)
  if (!constitutionExists) {
    await writeDocumentAtomic(paths.files, {
      path: paths.constitution,
      meta: { id: newId('doc') },
      body: CONSTITUTION_STARTER,
    })
  }

  // Unlike the constitution's starter (an empty sentence, since a person's
  // identity is unknown when a folder is created), the profile starter is
  // not empty: it carries the timezone the caller passed in, marked as a
  // system default rather than a fact the person confirmed. That is what
  // gives the per-message time stamp something to render from in the very
  // first session. The caller decides that zone, not this function: a
  // filesystem-free host has no ambient zone to guess from at all (see
  // time.ts's systemTimeZone comment), so ensureMemoryTree takes one
  // rather than reading Intl itself.
  const profileExists = await paths.files.exists(paths.profile)
  if (!profileExists) {
    await writeDocumentAtomic(paths.files, starterProfileDocument(paths.profile, timezone))
  }

  // Seed .gitignore to exclude the SQLite index, atomic-write temp files,
  // and the dream lock. The lock (dreams/.lock) has to exist as a real file
  // on disk, since the CLI and server share it purely through the
  // filesystem, but it must never enter the person's git history:
  // commitMemory's `git add -A` runs before the lock is released (the
  // written dream is already durable by the time it does), so without this
  // rule the lock gets staged and committed on every dream, and its later
  // deletion leaves the working tree reporting a pending removal forever
  // after. Ignoring the lock declaratively here, rather than reordering the
  // release, also covers a crashed run that leaves a stale lock behind.
  //
  // Skipped entirely when the store has no versioning capability: this is
  // git plumbing, not something a host with no git (a Durable Object) has
  // any use for, so there is nothing to seed.
  if (paths.files.capabilities.versioning) {
    await ensureGitignoreLine(paths.files, paths.root, DREAM_LOCK_IGNORE_LINE)
  }
}

const DREAM_LOCK_IGNORE_LINE = 'dreams/.lock'

// Writes a fresh .gitignore seeded with the standing exclusions when none
// exists yet. When one already exists, appends the given line only if no
// existing line already matches it exactly, so a folder created before
// this rule existed picks it up on the next open without ever touching,
// reordering, or duplicating anything already there.
//
// .gitignore is git plumbing, not a log: it is read whole and rewritten
// whole (through FileStore, not AppendOnlyStore), which is why this lives
// in paths.ts rather than being folded into one of the four log modules.
async function ensureGitignoreLine(files: FileStore, root: string, line: string): Promise<void> {
  const gitignorePath = join(root, '.gitignore')
  const gitignoreExists = await files.exists(gitignorePath)
  if (!gitignoreExists) {
    await files.writeFile(gitignorePath, `index.db\n*.tmp-*\n${line}\n`)
    return
  }
  const existing = await files.readFile(gitignorePath)
  const alreadyPresent = existing.split('\n').some((row) => row.trim() === line)
  if (alreadyPresent) return
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  // No AppendOnlyStore.appendFile equivalent here on purpose: .gitignore is
  // not a log (see the comment above this function), and FileStore has no
  // append primitive of its own, so an append becomes an explicit
  // read-then-writeFile. FileStore.writeFile is atomic (temp file, then
  // rename), which the original appendFile call was not; the bytes it
  // produces are identical, only the transient temp file is new.
  await files.writeFile(gitignorePath, `${existing}${separator}${line}\n`)
}
