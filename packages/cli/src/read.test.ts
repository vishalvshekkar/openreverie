import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReverieConfig } from '@openreverie/core'
import {
  appendGraph,
  ensureMemoryTree,
  memoryPaths,
  newId,
  writeDocumentAtomic,
} from '@openreverie/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ReadDeps, runRead } from './read.js'

function testConfig(memoryDir: string): ReverieConfig {
  return {
    memoryDir,
    provider: { name: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    models: { chat: 'fake-chat', reflection: 'fake-reflect', embeddings: 'fake-embed' },
    safety: { mode: 'companion', resources: [] },
    dreaming: {
      enabled: false,
      cadence: 'daily',
      triggers: { afterSession: true, onStart: true, serverTimer: true },
      maxToolCalls: 10,
    },
  }
}

function fakeDeps(memoryDir: string, output: string[], colorEnabled = false): ReadDeps {
  return {
    loadConfig: async () => testConfig(memoryDir),
    write: (text: string) => output.push(text),
    colorEnabled,
  }
}

describe('runRead', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-read-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('lists the constitution, arcs, realms, and people with no arguments', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await writeDocumentAtomic({
      path: join(paths.arcsDir, 'marathon.md'),
      meta: { id: newId('doc'), name: 'Marathon training', status: 'active' },
      body: 'Training for the spring marathon.\n',
    })
    await writeDocumentAtomic({
      path: join(paths.realmsDir, 'health.md'),
      meta: { id: newId('doc'), name: 'Health' },
      body: 'A realm about health.\n',
    })
    await writeDocumentAtomic({
      path: join(paths.peopleDir, 'alex.md'),
      meta: {
        id: newId('doc'),
        name: 'Alex',
        node: 'person_1',
        opened: '2026-08-01T00:00:00.000Z',
      },
      body: 'This page is new. It grows as we talk.\n',
    })

    const output: string[] = []
    const exitCode = await runRead([], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    const joined = output.join('')
    expect(joined).toContain('Constitution')
    expect(joined).toContain('Marathon training')
    expect(joined).toContain('Health')
    expect(joined).toContain('Alex')
  })

  it('prints the constitution header and full body', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const output: string[] = []
    const exitCode = await runRead(['constitution'], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    const joined = output.join('')
    expect(joined).toContain('Constitution')
    expect(joined).toContain('This constitution is empty. It grows as we talk.')
  })

  it('matches an arc by a case-insensitive substring of its name', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await writeDocumentAtomic({
      path: join(paths.arcsDir, 'marathon.md'),
      meta: { id: newId('doc'), name: 'Marathon training', status: 'active' },
      body: 'Training for the spring marathon.\n',
    })

    const output: string[] = []
    const exitCode = await runRead(['arc', 'MARATHON'], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    const joined = output.join('')
    expect(joined).toContain('Marathon training')
    expect(joined).toContain('active')
    expect(joined).toContain('Training for the spring marathon.')
  })

  it('lists candidates and exits non-zero when a name is ambiguous', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await writeDocumentAtomic({
      path: join(paths.peopleDir, 'alex-smith.md'),
      meta: {
        id: newId('doc'),
        name: 'Alex Smith',
        node: 'person_1',
        opened: '2026-08-01T00:00:00.000Z',
      },
      body: 'This page is new. It grows as we talk.\n',
    })
    await writeDocumentAtomic({
      path: join(paths.peopleDir, 'alexis-park.md'),
      meta: {
        id: newId('doc'),
        name: 'Alexis Park',
        node: 'person_2',
        opened: '2026-08-01T00:00:00.000Z',
      },
      body: 'This page is new. It grows as we talk.\n',
    })

    const output: string[] = []
    const exitCode = await runRead(['person', 'alex'], fakeDeps(dir, output))

    expect(exitCode).not.toBe(0)
    const joined = output.join('')
    expect(joined).toContain('Alex Smith')
    expect(joined).toContain('Alexis Park')
  })

  it('reports plainly and exits non-zero when nothing matches', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const output: string[] = []
    const exitCode = await runRead(['arc', 'does not exist'], fakeDeps(dir, output))

    expect(exitCode).not.toBe(0)
    expect(output.join('').toLowerCase()).toContain('no arc')
  })

  it('searches all three kinds for a bare name and prints the one unambiguous match', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await writeDocumentAtomic({
      path: join(paths.realmsDir, 'health.md'),
      meta: { id: newId('doc'), name: 'Health' },
      body: 'A realm about health.\n',
    })

    const output: string[] = []
    const exitCode = await runRead(['health'], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    expect(output.join('')).toContain('A realm about health.')
  })

  it('completes with no provider and no API key present in the environment', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await writeDocumentAtomic({
      path: join(paths.arcsDir, 'marathon.md'),
      meta: { id: newId('doc'), name: 'Marathon training', status: 'active' },
      body: 'Training for the spring marathon.\n',
    })

    const previousKey = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const output: string[] = []
      const exitCode = await runRead(['arc', 'marathon'], fakeDeps(dir, output))
      expect(exitCode).toBe(0)
      expect(output.join('')).toContain('Marathon training')
    } finally {
      if (previousKey !== undefined) process.env.OPENAI_API_KEY = previousKey
    }
  })

  it('colors the header when colorEnabled is true and stays plain when false', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const colored: string[] = []
    await runRead(['constitution'], fakeDeps(dir, colored, true))
    expect(colored.join('')).toContain('\x1b[35m')

    const plain: string[] = []
    await runRead(['constitution'], fakeDeps(dir, plain, false))
    expect(plain.join('')).not.toContain('\x1b[')
  })

  it('prints the config error plainly and exits with code 1 when loadConfig throws', async () => {
    const output: string[] = []
    const deps: ReadDeps = {
      loadConfig: async () => {
        throw new Error('No config found. Run: reverie setup')
      },
      write: (text: string) => output.push(text),
      colorEnabled: false,
    }

    const exitCode = await runRead([], deps)

    expect(exitCode).toBe(1)
    expect(output.join('')).toContain('No config found. Run: reverie setup')
  })

  it('shows an empty people section instead of crashing when a memory folder predates the people directory', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await writeDocumentAtomic({
      path: join(paths.arcsDir, 'marathon.md'),
      meta: { id: newId('doc'), name: 'Marathon training', status: 'active' },
      body: 'Training for the spring marathon.\n',
    })
    // Simulate a memory folder created before the people directory existed.
    await rm(paths.peopleDir, { recursive: true, force: true })

    const output: string[] = []
    const exitCode = await runRead([], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    const joined = output.join('')
    expect(joined).not.toContain('ENOENT')
    expect(joined).toContain('Marathon training')
    expect(joined).toContain('People')
    expect(joined).toContain('(none yet)')
  })

  it('reports a missing memory folder plainly, not as zero arcs, for an arc lookup against a memoryDir that does not exist', async () => {
    const missingDir = join(dir, 'never-created')

    const output: string[] = []
    const exitCode = await runRead(['arc', 'marathon'], fakeDeps(missingDir, output))

    expect(exitCode).not.toBe(0)
    const joined = output.join('')
    expect(joined).not.toContain('ENOENT')
    // This must not be confused with "no arc matches that name": the
    // folder itself was never there, so reverie never got to look.
    expect(joined.toLowerCase()).not.toContain('no arc found')
    expect(joined).toContain('No memory folder found')
    expect(joined).toContain(missingDir)
  })

  it('reports a missing memory folder plainly, not as an empty overview, for a bare read against a memoryDir that does not exist', async () => {
    const missingDir = join(dir, 'never-created-overview')

    const output: string[] = []
    const exitCode = await runRead([], fakeDeps(missingDir, output))

    expect(exitCode).not.toBe(0)
    const joined = output.join('')
    expect(joined).not.toContain('ENOENT')
    // This must not be confused with a genuinely empty memory folder: no
    // "(none yet)" sections, no exit 0, since reverie never got to look.
    expect(joined).not.toContain('(none yet)')
    expect(joined).toContain('No memory folder found')
    expect(joined).toContain(missingDir)
  })

  it('reports plainly, without an ENOENT string, when constitution is read against a memory folder that does not exist', async () => {
    const missingDir = join(dir, 'never-created-either')

    const output: string[] = []
    const exitCode = await runRead(['constitution'], fakeDeps(missingDir, output))

    expect(exitCode).not.toBe(0)
    const joined = output.join('')
    expect(joined).not.toContain('ENOENT')
    expect(joined).toContain('No memory folder found')
  })

  it('reports a genuinely empty but existing memory folder as (none yet), exit 0, not as a missing folder', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const output: string[] = []
    const exitCode = await runRead([], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    const joined = output.join('')
    expect(joined).not.toContain('No memory folder found')
    expect(joined).not.toContain('ENOENT')
    expect(joined).toContain('Arcs')
    expect(joined).toContain('(none yet)')
  })

  it('names the file and the reason, not "run setup", when constitution.md exists but fails to parse as a document', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    // A person hand-editing their own memory folder can produce frontmatter
    // with no id. That is a real, expected way for this file to be broken,
    // and is a different problem than the folder not existing.
    await writeFile(paths.constitution, '---\nname: Not valid\n---\nBody text.\n', 'utf8')

    const output: string[] = []
    const exitCode = await runRead(['constitution'], fakeDeps(dir, output))

    expect(exitCode).not.toBe(0)
    const joined = output.join('')
    expect(joined).not.toContain('No memory folder found')
    expect(joined).not.toContain('reverie setup')
    expect(joined).toContain(paths.constitution)
    expect(joined.toLowerCase()).toContain('no id')
  })

  // Before this fix, loadCandidates called listDocuments(dir) with no
  // onSkip: a hand-edited arcs/grief.md with broken frontmatter would drop
  // out of the array silently, and "reverie read" would list the person's
  // arcs with grief simply absent, no different from a memory that never
  // had one.
  it('reports a broken arc file plainly in the overview listing, instead of omitting it as if it did not exist', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await writeDocumentAtomic({
      path: join(paths.arcsDir, 'marathon.md'),
      meta: { id: newId('doc'), name: 'Marathon training', status: 'active' },
      body: 'Training for the spring marathon.\n',
    })
    // A person hand-edits arcs/grief.md into broken frontmatter. The file
    // is still on disk; it just no longer parses.
    await writeFile(join(paths.arcsDir, 'grief.md'), '---\nname: Grief\n---\nBody text.\n', 'utf8')

    const output: string[] = []
    const exitCode = await runRead([], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    const joined = output.join('')
    expect(joined).toContain('Marathon training')
    expect(joined).toContain(join(paths.arcsDir, 'grief.md'))
    expect(joined.toLowerCase()).toContain('no id')
  })

  // Same defect, the sharper case the reviewer named directly: the person
  // asks for the exact broken page by name and, before this fix, got told
  // "no arc found" about a file sitting right there on disk.
  it('reports the broken file plainly for a named lookup, instead of saying no arc was found', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await writeFile(join(paths.arcsDir, 'grief.md'), '---\nname: Grief\n---\nBody text.\n', 'utf8')

    const output: string[] = []
    const exitCode = await runRead(['arc', 'grief'], fakeDeps(dir, output))

    expect(exitCode).not.toBe(0)
    const joined = output.join('')
    expect(joined.toLowerCase()).not.toContain('no arc found')
    expect(joined).toContain(join(paths.arcsDir, 'grief.md'))
    expect(joined.toLowerCase()).toContain('no id')
  })

  // Same case again through the bare, search-all-kinds path (no kind given).
  it('reports the broken file plainly for a bare search-all-kinds lookup, instead of saying nothing matched', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await writeFile(join(paths.peopleDir, 'sam.md'), '---\nname: Sam\n---\nBody text.\n', 'utf8')

    const output: string[] = []
    const exitCode = await runRead(['sam'], fakeDeps(dir, output))

    expect(exitCode).not.toBe(0)
    const joined = output.join('')
    expect(joined.toLowerCase()).not.toContain('no arc, realm, or person found')
    expect(joined).toContain(join(paths.peopleDir, 'sam.md'))
    expect(joined.toLowerCase()).toContain('no id')
  })

  it('finds a bare name that matches both an arc and a person, and reports it as ambiguous across kinds', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await writeDocumentAtomic({
      path: join(paths.arcsDir, 'phoenix.md'),
      meta: { id: newId('doc'), name: 'Phoenix', status: 'active' },
      body: 'An arc named Phoenix.\n',
    })
    await writeDocumentAtomic({
      path: join(paths.peopleDir, 'phoenix.md'),
      meta: {
        id: newId('doc'),
        name: 'Phoenix',
        node: 'person_1',
        opened: '2026-08-01T00:00:00.000Z',
      },
      body: 'This page is new. It grows as we talk.\n',
    })

    const output: string[] = []
    const exitCode = await runRead(['phoenix'], fakeDeps(dir, output))

    expect(exitCode).not.toBe(0)
    const joined = output.join('')
    expect(joined).toContain('More than one match')
    expect(joined).toContain('Phoenix (arc)')
    expect(joined).toContain('Phoenix (person)')
  })

  it('lists a node-only person (no page yet) alongside paged people in the overview', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await writeDocumentAtomic({
      path: join(paths.peopleDir, 'alex.md'),
      meta: { id: newId('doc'), name: 'Alex', node: 'person_paged', opened: '2026-08-01' },
      body: 'This page is new. It grows as we talk.\n',
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'person_paged',
        type: 'person',
        label: 'Alex',
        doc: join(paths.peopleDir, 'alex.md'),
      },
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'person_nodeonly',
        type: 'person',
        label: 'Renata',
      },
    ])

    const output: string[] = []
    const exitCode = await runRead([], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    const joined = output.join('')
    expect(joined).toContain('Alex')
    expect(joined).toContain('Renata (no page yet)')
  })

  // The exact defect this fix removes: before it, a person with a node but
  // no page was invisible to `reverie read person <name>`, and this
  // command claimed "No person found" about someone actually sitting in
  // the graph, right after the same class of dishonesty had already been
  // fixed once for a broken file on disk.
  it('reports a node-only person as known with no page, instead of claiming not found', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'person_nodeonly',
        type: 'person',
        label: 'Renata',
      },
    ])

    const output: string[] = []
    const exitCode = await runRead(['person', 'renata'], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    const joined = output.join('')
    expect(joined.toLowerCase()).not.toContain('no person found')
    expect(joined).toContain('Renata')
    expect(joined.toLowerCase()).toContain('no page yet')
  })

  it('reports a node-only person as known through the bare, kindless search too', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'person_nodeonly',
        type: 'person',
        label: 'Renata',
      },
    ])

    const output: string[] = []
    const exitCode = await runRead(['renata'], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    const joined = output.join('')
    expect(joined.toLowerCase()).not.toContain('no arc, realm, person, or entity found')
    expect(joined).toContain('Renata')
    expect(joined.toLowerCase()).toContain('no page yet')
  })

  it('reports "No person found" for a name that matches nothing at all, paged or node-only', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const output: string[] = []
    const exitCode = await runRead(['person', 'nobody'], fakeDeps(dir, output))

    expect(exitCode).not.toBe(0)
    expect(output.join('').toLowerCase()).toContain('no person found')
  })

  it('lists entities in the overview and looks one up by name, plainly noting entities have no page', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'entity_1',
        type: 'entity',
        label: 'Dune',
      },
    ])

    const overviewOutput: string[] = []
    await runRead([], fakeDeps(dir, overviewOutput))
    expect(overviewOutput.join('')).toContain('Dune')

    const lookupOutput: string[] = []
    const exitCode = await runRead(['entity', 'dune'], fakeDeps(dir, lookupOutput))
    expect(exitCode).toBe(0)
    const joined = lookupOutput.join('')
    expect(joined).toContain('Dune')
    expect(joined.toLowerCase()).toContain('no page')
  })

  it('reports "No entity found" for an entity name that matches nothing', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const output: string[] = []
    const exitCode = await runRead(['entity', 'nothing-here'], fakeDeps(dir, output))

    expect(exitCode).not.toBe(0)
    expect(output.join('').toLowerCase()).toContain('no entity found')
  })

  it('does not crash and treats a missing or corrupt graph log as empty', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    // No graph.jsonl written at all: ensureMemoryTree does not guarantee
    // the file exists until something is appended to it.

    const output: string[] = []
    const exitCode = await runRead([], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    expect(output.join('')).toContain('(none yet)')
  })
})
