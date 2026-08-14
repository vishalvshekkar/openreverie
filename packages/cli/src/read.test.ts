import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReverieConfig } from '@openreverie/core'
import { ensureMemoryTree, memoryPaths, newId, writeDocumentAtomic } from '@openreverie/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ReadDeps, runRead } from './read.js'

function testConfig(memoryDir: string): ReverieConfig {
  return {
    memoryDir,
    provider: { name: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    models: { chat: 'fake-chat', reflection: 'fake-reflect', embeddings: 'fake-embed' },
    safety: { mode: 'companion', resources: [] },
    style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
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
})
