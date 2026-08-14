// Reads reverie's own record from the filesystem, with no engine, no
// provider, and no network call anywhere in this path. `MemoryEngine.open`
// runs runMaintenance (engine.ts), which can fire live reflection and
// embedding calls, and constructing a provider needs a resolvable API key.
// Reading your own record must work with the provider offline or
// unconfigured, so this module is built only from loadConfig (to learn the
// memory folder location), memoryPaths, listDocuments, and readDocument:
// pure filesystem, nothing else.
//
// Names come from document frontmatter, not the graph, which keeps this
// whole path free of the graph and the index.

import { stat } from 'node:fs/promises'
import type { ReverieConfig } from '@openreverie/core'
import { type Document, listDocuments, memoryPaths, readDocument } from '@openreverie/memory'
import { magenta } from './colors.js'

export interface ReadDeps {
  loadConfig: () => Promise<ReverieConfig>
  write: (text: string) => void
  colorEnabled: boolean
}

type NamedKind = 'arc' | 'realm' | 'person'

interface Candidate {
  name: string
  path: string
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  )
}

export async function runRead(args: string[], deps: ReadDeps): Promise<number> {
  let config: ReverieConfig
  try {
    config = await deps.loadConfig()
  } catch (err) {
    deps.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  const paths = memoryPaths(config.memoryDir)

  // A memory root that is not there at all is a different situation from
  // one that exists but happens to have nothing in it yet: the first is a
  // configuration problem (wrong path, or setup never finished), the
  // second is a genuinely empty, freshly usable memory folder. Checking
  // the root once, up front, before any of the per-kind listing below
  // (which treats a missing subdirectory as empty, not as an error) keeps
  // those two states from being reported as the same thing. Reporting a
  // missing root as "zero arcs, zero realms, zero people, exit 0" would
  // read as confirmation that nothing is being kept, when the truth is
  // that reverie could not look.
  if (!(await pathIsDirectory(paths.root))) {
    deps.write(`No memory folder found at ${paths.root}. Run: reverie setup\n`)
    return 1
  }

  if (args.length === 0) {
    return listOverview(paths, deps)
  }

  const [first, ...rest] = args
  if (first === 'constitution') {
    return printConstitution(paths, deps)
  }
  if (first === 'arc' || first === 'realm' || first === 'person') {
    const name = rest.join(' ').trim()
    if (name === '') {
      deps.write(`reverie read ${first} needs a name to look for.\n`)
      return 1
    }
    return printOneOfKind(paths, first, name, deps)
  }

  const name = args.join(' ').trim()
  return printSearchAllKinds(paths, name, deps)
}

// A memory folder made before people/ existed has no people directory to
// scandir, even though its root and its other directories are real. Since
// runRead never runs ensureMemoryTree (that would mean touching the
// filesystem beyond a plain read), a missing subdirectory here is treated
// as an empty one rather than left to throw a raw ENOENT at the caller.
// The root itself not existing at all is handled separately, up front in
// runRead, precisely so it is never confused with this case.
async function loadCandidates(
  paths: ReturnType<typeof memoryPaths>,
  kind: NamedKind,
): Promise<Candidate[]> {
  const dir = kind === 'arc' ? paths.arcsDir : kind === 'realm' ? paths.realmsDir : paths.peopleDir
  let docs: Document[]
  try {
    docs = await listDocuments(dir)
  } catch {
    return []
  }
  return docs.map((doc) => ({
    name: typeof doc.meta.name === 'string' ? doc.meta.name : '(untitled)',
    path: doc.path,
  }))
}

function matches(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.toLowerCase())
}

async function printOneOfKind(
  paths: ReturnType<typeof memoryPaths>,
  kind: NamedKind,
  name: string,
  deps: ReadDeps,
): Promise<number> {
  const candidates = await loadCandidates(paths, kind)
  const found = candidates.filter((c) => matches(c.name, name))

  if (found.length === 0) {
    deps.write(`No ${kind} found matching "${name}".\n`)
    return 1
  }
  if (found.length > 1) {
    deps.write(`More than one ${kind} matches "${name}":\n`)
    for (const candidate of found) deps.write(`  - ${candidate.name}\n`)
    return 1
  }

  const match = found[0]
  if (!match) return 1
  const doc = await readDocument(match.path)
  printDocument(deps, match.name, doc)
  return 0
}

async function printSearchAllKinds(
  paths: ReturnType<typeof memoryPaths>,
  name: string,
  deps: ReadDeps,
): Promise<number> {
  if (name === '') {
    deps.write('reverie read needs a name to look for.\n')
    return 1
  }

  const kinds: { kind: NamedKind; label: string }[] = [
    { kind: 'arc', label: 'arc' },
    { kind: 'realm', label: 'realm' },
    { kind: 'person', label: 'person' },
  ]
  const found: { name: string; path: string; label: string }[] = []
  for (const { kind, label } of kinds) {
    const candidates = await loadCandidates(paths, kind)
    for (const candidate of candidates) {
      if (matches(candidate.name, name)) found.push({ ...candidate, label })
    }
  }

  if (found.length === 0) {
    deps.write(`No arc, realm, or person found matching "${name}".\n`)
    return 1
  }
  if (found.length > 1) {
    deps.write(`More than one match for "${name}":\n`)
    for (const candidate of found) deps.write(`  - ${candidate.name} (${candidate.label})\n`)
    return 1
  }

  const match = found[0]
  if (!match) return 1
  const doc = await readDocument(match.path)
  printDocument(deps, match.name, doc)
  return 0
}

async function printConstitution(
  paths: ReturnType<typeof memoryPaths>,
  deps: ReadDeps,
): Promise<number> {
  let doc: Document
  try {
    doc = await readDocument(paths.constitution)
  } catch (err) {
    // A missing constitution.md (the file itself, not the folder: runRead
    // already checked the root exists before this runs) is reported the
    // same way as a missing folder, since it needs the same fix. A file
    // that exists but fails to parse, or is missing its id (both real
    // possibilities: this is a plain markdown file a person can and is
    // expected to hand-edit) is a different problem with a different fix,
    // so it gets readDocument's own message verbatim, naming the file and
    // the reason, instead of the wrong advice to re-run setup.
    if (isEnoent(err)) {
      deps.write(`No memory folder found at ${paths.root}. Run: reverie setup\n`)
      return 1
    }
    deps.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  printDocument(deps, 'Constitution', doc)
  return 0
}

function printDocument(deps: ReadDeps, name: string, doc: Document): void {
  const details: string[] = []
  if (typeof doc.meta.status === 'string') details.push(doc.meta.status)
  if (typeof doc.meta.updated === 'string') details.push(`updated ${doc.meta.updated}`)
  const header = details.length > 0 ? `${name} (${details.join(', ')})` : name

  deps.write(`${magenta(header, deps.colorEnabled)}\n\n`)
  deps.write(`${doc.body}\n`)
}

async function listOverview(
  paths: ReturnType<typeof memoryPaths>,
  deps: ReadDeps,
): Promise<number> {
  deps.write(`${magenta('Constitution', deps.colorEnabled)}\n`)

  const arcs = await loadCandidates(paths, 'arc')
  deps.write(`\n${magenta('Arcs', deps.colorEnabled)}\n`)
  if (arcs.length === 0) deps.write('  (none yet)\n')
  for (const arc of arcs) deps.write(`  - ${arc.name}\n`)

  const realms = await loadCandidates(paths, 'realm')
  deps.write(`\n${magenta('Realms', deps.colorEnabled)}\n`)
  if (realms.length === 0) deps.write('  (none yet)\n')
  for (const realm of realms) deps.write(`  - ${realm.name}\n`)

  const people = await loadCandidates(paths, 'person')
  deps.write(`\n${magenta('People', deps.colorEnabled)}\n`)
  if (people.length === 0) deps.write('  (none yet)\n')
  for (const person of people) deps.write(`  - ${person.name}\n`)

  deps.write(
    '\nUse: reverie read constitution, reverie read arc <name>, reverie read realm <name>, ' +
      'or reverie read person <name>.\n',
  )
  return 0
}
