// Layout of a memory folder: the fixed set of directories and files that
// make up one user's memory. Everything here is derived from a single root
// path so the rest of the engine never hardcodes a folder name.

import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newId, writeDocumentAtomic } from './documents.js'
import { starterProfileDocument } from './profile.js'
import { systemTimeZone } from './time.js'

export interface MemoryPaths {
  root: string
  constitution: string
  profile: string
  migrationsLog: string
  realmsDir: string
  arcsDir: string
  peopleDir: string
  sessionsDir: string
  rollupsDailyDir: string
  rollupsWeeklyDir: string
  graphLog: string
  proposals: string
  indexDb: string
}

export function memoryPaths(root: string): MemoryPaths {
  return {
    root,
    constitution: join(root, 'constitution.md'),
    profile: join(root, 'profile.md'),
    migrationsLog: join(root, 'migrations.jsonl'),
    realmsDir: join(root, 'realms'),
    arcsDir: join(root, 'arcs'),
    peopleDir: join(root, 'people'),
    sessionsDir: join(root, 'sessions'),
    rollupsDailyDir: join(root, 'rollups', 'daily'),
    rollupsWeeklyDir: join(root, 'rollups', 'weekly'),
    graphLog: join(root, 'graph.jsonl'),
    proposals: join(root, 'proposals.jsonl'),
    indexDb: join(root, 'index.db'),
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

  // Seed .gitignore to exclude the SQLite index and atomic-write temp files
  const gitignorePath = join(paths.root, '.gitignore')
  const gitignoreExists = await pathExists(gitignorePath)
  if (!gitignoreExists) {
    await writeFile(gitignorePath, 'index.db\n*.tmp-*\n', 'utf8')
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
