// Reads reverie's own record from the filesystem, with no engine, no
// provider, and no network call anywhere in this path. `MemoryEngine.open`
// runs runMaintenance (engine.ts), which can fire live reflection and
// embedding calls, and constructing a provider needs a resolvable API key.
// Reading your own record must work with the provider offline or
// unconfigured, so this module is built only from loadConfig (to learn the
// memory folder location), memoryPaths, listDocuments, and readDocument:
// pure filesystem, nothing else.
//
// Named documents (arcs, realms, paged people) come from their own
// frontmatter. A person known only as a node, and every entity (which
// never gets a page in this release), have no document at all, so those
// come from graph.jsonl instead, read with readGraph: a plain append-only
// log, no database and no network, so this stays free of the index and the
// engine either way.

import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ReverieConfig } from '@openreverie/core'
import {
  type Document,
  type GraphNode,
  type GraphState,
  listDocuments,
  memoryPaths,
  readDocument,
  readGraph,
} from '@openreverie/memory'
import { magenta } from './colors.js'

export interface ReadDeps {
  loadConfig: () => Promise<ReverieConfig>
  write: (text: string) => void
  colorEnabled: boolean
}

type NamedKind = 'arc' | 'realm' | 'person' | 'entity'
// Arcs, realms, and people are backed by a document on disk (loadCandidates
// walks their directory). Entities never get a page in this release at
// all, so they are resolved entirely from the graph, never through
// loadCandidates; keeping this as its own narrower type is what lets
// TypeScript confirm loadCandidates is never asked to look for one.
type DocumentBackedKind = 'arc' | 'realm' | 'person'

interface Candidate {
  name: string
  path: string
}

// Node-only people (a node with no doc) and every entity (which never gets
// a doc in this release) are known only through the graph, never through a
// document on disk. graph.jsonl is a plain append-only log with no
// database and no network, so reading it here keeps this module's
// guarantee: it works with the provider offline or unconfigured. A
// missing or corrupt graph log is treated as empty, the same way a missing
// people/ directory is treated as an empty listing below.
async function loadGraph(paths: ReturnType<typeof memoryPaths>): Promise<GraphState> {
  try {
    return await readGraph(paths)
  } catch {
    return { nodes: new Map(), edges: new Map() }
  }
}

function nodesOfType(graph: GraphState, type: 'person' | 'entity'): GraphNode[] {
  return [...graph.nodes.values()].filter((node) => node.type === type)
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
  if (first === 'arc' || first === 'realm' || first === 'person' || first === 'entity') {
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
//
// onSkip is listDocuments' own skip-and-report hook (see documents.ts):
// every caller of loadCandidates must pass one, the same way the engine
// passes onDocSkip everywhere. Dropping it here was the defect: a file a
// person hand-edited into broken frontmatter would silently vanish from
// every read.ts listing and lookup instead of being reported.
async function loadCandidates(
  paths: ReturnType<typeof memoryPaths>,
  kind: DocumentBackedKind,
  onSkip: (path: string, reason: string) => void,
): Promise<Candidate[]> {
  const dir = kind === 'arc' ? paths.arcsDir : kind === 'realm' ? paths.realmsDir : paths.peopleDir
  let docs: Document[]
  try {
    docs = await listDocuments(dir, onSkip)
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

// A file that failed to parse has no readable name field to match a query
// against, only a path. Its filename (without .md) is the next best thing:
// it is what the person actually typed to create the page in the first
// place, and it is what they are most likely to type again when reading it
// back. This is only ever used once name-matching against real candidates
// has already come up empty.
function matchesSkippedPath(path: string, query: string): boolean {
  return matches(basename(path, '.md'), query)
}

async function printOneOfKind(
  paths: ReturnType<typeof memoryPaths>,
  kind: NamedKind,
  name: string,
  deps: ReadDeps,
): Promise<number> {
  if (kind === 'entity') {
    return printEntityLookup(paths, name, deps)
  }

  const skips: { path: string; reason: string }[] = []
  const candidates = await loadCandidates(paths, kind, (path, reason) => {
    skips.push({ path, reason })
  })
  const found = candidates.filter((c) => matches(c.name, name))

  if (found.length === 0) {
    // Before reporting nothing found, check whether the query actually
    // names a page that is sitting right there on disk, just broken.
    // Reporting "no arc found" about that page would be the same defect
    // as treating a broken read as an empty one: it tells the person
    // reverie is keeping nothing, when the truth is reverie could not
    // read what it has.
    const skip = skips.find((s) => matchesSkippedPath(s.path, name))
    if (skip) {
      deps.write(`${skip.reason}\n`)
      return 1
    }
    // A person with a node but no page is now the common case (see the
    // remember-by-default round of work): reporting "not found" about
    // someone actually sitting in the graph is the same class of
    // dishonesty this command already had to be fixed for once before.
    if (kind === 'person') {
      const nodeOnlyResult = await printNodeOnlyPersonLookup(paths, name, deps)
      if (nodeOnlyResult !== undefined) return nodeOnlyResult
    }
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

// A person known only as a graph node, with no page yet. Returns undefined
// (not a code) when nothing in the graph matches, so the caller falls
// through to the ordinary "not found" message; returns an actual exit code
// once it has something honest to say instead.
async function printNodeOnlyPersonLookup(
  paths: ReturnType<typeof memoryPaths>,
  name: string,
  deps: ReadDeps,
): Promise<number | undefined> {
  const graph = await loadGraph(paths)
  const found = nodesOfType(graph, 'person')
    .filter((node) => node.doc === undefined)
    .filter((node) => matches(node.label, name))

  if (found.length === 0) return undefined
  if (found.length > 1) {
    deps.write(`More than one person matches "${name}":\n`)
    for (const node of found) deps.write(`  - ${node.label} (no page yet)\n`)
    return 1
  }

  const node = found[0]
  if (!node) return undefined
  deps.write(
    `${node.label} is in your memory, with no page yet: there is nothing written about them, ` +
      'but they are known.\n',
  )
  return 0
}

// Entities never get a page in this release, so there is never a document
// to read for one; this looks them up in the graph directly and says so
// plainly instead of pretending a page exists.
async function printEntityLookup(
  paths: ReturnType<typeof memoryPaths>,
  name: string,
  deps: ReadDeps,
): Promise<number> {
  const graph = await loadGraph(paths)
  const found = nodesOfType(graph, 'entity').filter((node) => matches(node.label, name))

  if (found.length === 0) {
    deps.write(`No entity found matching "${name}".\n`)
    return 1
  }
  if (found.length > 1) {
    deps.write(`More than one entity matches "${name}":\n`)
    for (const node of found) deps.write(`  - ${node.label}\n`)
    return 1
  }

  const node = found[0]
  if (!node) return 1
  deps.write(
    `${node.label} is known as an entity in your memory. Entities have no page in this release.\n`,
  )
  return 0
}

interface SearchMatch {
  name: string
  label: string
  // A document-backed match (arc, realm, a paged person) carries a path to
  // read. A graph-only match (a node-only person, any entity) carries a
  // plain honest line to print instead, since there is no document at all.
  path?: string
  honestNote?: string
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

  const kinds: { kind: DocumentBackedKind; label: string }[] = [
    { kind: 'arc', label: 'arc' },
    { kind: 'realm', label: 'realm' },
    { kind: 'person', label: 'person' },
  ]
  const found: SearchMatch[] = []
  const skips: { path: string; reason: string }[] = []
  for (const { kind, label } of kinds) {
    const candidates = await loadCandidates(paths, kind, (path, reason) => {
      skips.push({ path, reason })
    })
    for (const candidate of candidates) {
      if (matches(candidate.name, name)) found.push({ ...candidate, label })
    }
  }

  // A person with a node but no page yet, and every entity, are known
  // only through the graph. Leaving them out of the bare, kindless search
  // would tell someone reverie has never heard of a name that is actually
  // sitting right there, the same dishonesty this fix exists to remove.
  const graph = await loadGraph(paths)
  for (const node of nodesOfType(graph, 'person')) {
    if (node.doc !== undefined) continue
    if (matches(node.label, name)) {
      found.push({
        name: node.label,
        label: 'person',
        honestNote: `${node.label} is in your memory, with no page yet: there is nothing written about them, but they are known.`,
      })
    }
  }
  for (const node of nodesOfType(graph, 'entity')) {
    if (matches(node.label, name)) {
      found.push({
        name: node.label,
        label: 'entity',
        honestNote: `${node.label} is known as an entity in your memory. Entities have no page in this release.`,
      })
    }
  }

  if (found.length === 0) {
    // Same reasoning as printOneOfKind: a broken page whose filename
    // matches what was typed must be reported, not folded into "nothing
    // matches at all", which is the search-all-kinds equivalent of the
    // same defect.
    const skip = skips.find((s) => matchesSkippedPath(s.path, name))
    if (skip) {
      deps.write(`${skip.reason}\n`)
      return 1
    }
    deps.write(`No arc, realm, person, or entity found matching "${name}".\n`)
    return 1
  }
  if (found.length > 1) {
    deps.write(`More than one match for "${name}":\n`)
    for (const candidate of found) deps.write(`  - ${candidate.name} (${candidate.label})\n`)
    return 1
  }

  const match = found[0]
  if (!match) return 1
  if (match.path) {
    const doc = await readDocument(match.path)
    printDocument(deps, match.name, doc)
    return 0
  }
  if (match.honestNote) {
    deps.write(`${match.honestNote}\n`)
    return 0
  }
  return 1
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

  const arcSkips: string[] = []
  const arcs = await loadCandidates(paths, 'arc', (_path, reason) => arcSkips.push(reason))
  deps.write(`\n${magenta('Arcs', deps.colorEnabled)}\n`)
  // A directory with nothing readable in it is not the same as a directory
  // with nothing in it at all: (none yet) must only say the first of those
  // two things, or a broken page reads as if it were never written.
  if (arcs.length === 0 && arcSkips.length === 0) deps.write('  (none yet)\n')
  for (const arc of arcs) deps.write(`  - ${arc.name}\n`)
  for (const reason of arcSkips) deps.write(`  ! ${reason}\n`)

  const realmSkips: string[] = []
  const realms = await loadCandidates(paths, 'realm', (_path, reason) => realmSkips.push(reason))
  deps.write(`\n${magenta('Realms', deps.colorEnabled)}\n`)
  if (realms.length === 0 && realmSkips.length === 0) deps.write('  (none yet)\n')
  for (const realm of realms) deps.write(`  - ${realm.name}\n`)
  for (const reason of realmSkips) deps.write(`  ! ${reason}\n`)

  const peopleSkips: string[] = []
  const people = await loadCandidates(paths, 'person', (_path, reason) => peopleSkips.push(reason))
  const graph = await loadGraph(paths)
  // A person node with no doc is exactly the node-only case this whole fix
  // is for: known, but not yet worth a page. Listed alongside paged people,
  // distinguishably, rather than being invisible.
  const nodeOnlyPeople = nodesOfType(graph, 'person').filter((node) => node.doc === undefined)
  deps.write(`\n${magenta('People', deps.colorEnabled)}\n`)
  if (people.length === 0 && nodeOnlyPeople.length === 0 && peopleSkips.length === 0) {
    deps.write('  (none yet)\n')
  }
  for (const person of people) deps.write(`  - ${person.name}\n`)
  for (const node of nodeOnlyPeople) deps.write(`  - ${node.label} (no page yet)\n`)
  for (const reason of peopleSkips) deps.write(`  ! ${reason}\n`)

  const entities = nodesOfType(graph, 'entity')
  deps.write(`\n${magenta('Entities', deps.colorEnabled)}\n`)
  if (entities.length === 0) deps.write('  (none yet)\n')
  for (const entity of entities) deps.write(`  - ${entity.label}\n`)

  deps.write(
    '\nUse: reverie read constitution, reverie read arc <name>, reverie read realm <name>, ' +
      'reverie read person <name>, or reverie read entity <name>.\n',
  )
  return 0
}
