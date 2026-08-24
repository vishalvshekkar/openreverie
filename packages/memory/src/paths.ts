// Layout of a memory folder: the fixed set of directories and files that
// make up one user's memory. Everything here is derived from a single root
// path so the rest of the engine never hardcodes a folder name.

import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newId, writeDocumentAtomic } from './documents.js'
import { starterProfileDocument } from './profile.js'
import { systemTimeZone } from './time.js'

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
}

export function memoryPaths(root: string): MemoryPaths {
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
  }
}

const CONSTITUTION_STARTER = 'This constitution is empty. It grows as we talk.\n'

export async function ensureMemoryTree(paths: MemoryPaths): Promise<void> {
  await mkdir(paths.root, { recursive: true })
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
    await mkdir(dir, { recursive: true })
  }

  const constitutionExists = await pathExists(paths.constitution)
  if (!constitutionExists) {
    await writeDocumentAtomic({
      path: paths.constitution,
      meta: { id: newId('doc') },
      body: CONSTITUTION_STARTER,
    })
  }

  // Unlike the constitution's starter (an empty sentence, since a person's
  // identity is unknown when a folder is created), the profile starter is
  // not empty: it carries the timezone of the machine reverie is running
  // on, marked as a system default rather than a fact the person
  // confirmed. That is what gives the per-message time stamp something to
  // render from in the very first session.
  const profileExists = await pathExists(paths.profile)
  if (!profileExists) {
    await writeDocumentAtomic(starterProfileDocument(paths.profile, systemTimeZone()))
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
  await ensureGitignoreLine(paths.root, DREAM_LOCK_IGNORE_LINE)
}

const DREAM_LOCK_IGNORE_LINE = 'dreams/.lock'

// Writes a fresh .gitignore seeded with the standing exclusions when none
// exists yet. When one already exists, appends the given line only if no
// existing line already matches it exactly, so a folder created before
// this rule existed picks it up on the next open without ever touching,
// reordering, or duplicating anything already there.
async function ensureGitignoreLine(root: string, line: string): Promise<void> {
  const gitignorePath = join(root, '.gitignore')
  const gitignoreExists = await pathExists(gitignorePath)
  if (!gitignoreExists) {
    await writeFile(gitignorePath, `index.db\n*.tmp-*\n${line}\n`, 'utf8')
    return
  }
  const existing = await readFile(gitignorePath, 'utf8')
  const alreadyPresent = existing.split('\n').some((row) => row.trim() === line)
  if (alreadyPresent) return
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  await appendFile(gitignorePath, `${separator}${line}\n`, 'utf8')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
