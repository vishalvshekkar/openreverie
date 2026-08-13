import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendGraph,
  appendProposals,
  type EngineDeps,
  ensureMemoryTree,
  MemoryEngine,
  type MemoryPaths,
  memoryPaths,
  newId,
  type Proposal,
  SessionStore,
  writeDocumentAtomic,
} from '@openreverie/memory'
import { FakeChatProvider, FakeEmbeddingProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultCrisisResources, type ReverieConfig } from './config.js'
import { assembleSystemPrompt } from './context.js'
import { buildPersona } from './personas.js'

function testConfig(overrides: Partial<ReverieConfig> = {}): ReverieConfig {
  return {
    memoryDir: '/somewhere/memory',
    provider: { name: 'openai', apiKeyEnv: 'OPENREVERIE_TEST_KEY' },
    models: { chat: 'gpt-5', reflection: 'gpt-5-mini', embeddings: 'text-embedding-3-small' },
    safety: { mode: 'companion', resources: defaultCrisisResources },
    ...overrides,
  }
}

function fakeDeps(chat: FakeChatProvider): EngineDeps {
  return {
    chat,
    embeddings: new FakeEmbeddingProvider(),
    reflectionModel: 'fake-reflect',
    embeddingModel: 'fake-embed',
  }
}

describe('assembleSystemPrompt', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-context-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('leads with the persona, then renders every populated section in the specified order with its details', async () => {
    await writeDocumentAtomic({
      path: paths.constitution,
      meta: { id: newId('doc') },
      body: 'The user prefers direct, unflinching honesty over comfort.\n',
    })

    const realmPath = join(paths.realmsDir, 'fitness.md')
    await writeDocumentAtomic({
      path: realmPath,
      meta: { id: newId('doc'), name: 'Fitness' },
      body: 'Running, lifting, and sleep consistency.\n',
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'realm_fitness',
        type: 'realm',
        label: 'Fitness',
        doc: realmPath,
      },
    ])

    const arcId = 'arc_marathon'
    const arcPath = join(paths.arcsDir, 'marathon.md')
    await writeDocumentAtomic({
      path: arcPath,
      meta: {
        id: newId('doc'),
        name: 'Marathon Training',
        status: 'active',
        updated: '2026-08-10',
      },
      body: 'Training for the fall marathon.\n',
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: arcId,
        type: 'arc',
        label: 'Marathon Training',
        doc: arcPath,
      },
    ])

    await writeDocumentAtomic({
      path: join(paths.rollupsDailyDir, '2026-08-10.md'),
      meta: { id: newId('doc'), date: '2026-08-10' },
      body: 'A steady day of small wins.\n',
    })

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const store = await SessionStore.start(paths, yesterday)
    await store.appendLine({
      ts: yesterday.toISOString(),
      role: 'user',
      content: 'A quiet evening.',
    })
    await writeDocumentAtomic({
      path: join(store.dir, 'summary.md'),
      meta: { id: newId('doc') },
      body: 'Talked through a quiet, low-key evening.\n',
    })

    const proposal: Proposal = {
      id: newId('prop'),
      ts: new Date().toISOString(),
      kind: 'link',
      summary: 'Link the run item to marathon training.',
      payload: { edge: 'part_of', from: newId('item'), to: arcId, confidence: 0.5 },
      source: 'session_seed',
    }
    await appendProposals(paths, [proposal])

    const config = testConfig()
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

    const prompt = await assembleSystemPrompt(engine, config)

    const persona = buildPersona(config.safety.mode, config.safety.resources)
    expect(prompt.startsWith(persona)).toBe(true)

    expect(prompt).toContain('## Constitution')
    expect(prompt).toContain('The user prefers direct, unflinching honesty over comfort.')

    expect(prompt).toContain('## Realms')
    expect(prompt).toContain('Fitness')

    expect(prompt).toContain('## Active arcs')
    expect(prompt).toContain('Marathon Training')
    expect(prompt).toContain('status: active')
    expect(prompt).toContain('2026-08-10')

    expect(prompt).toContain('## Latest daily rollup')
    expect(prompt).toContain('A steady day of small wins.')

    expect(prompt).toContain('## Yesterday')
    expect(prompt).toContain('Talked through a quiet, low-key evening.')

    expect(prompt).toContain('## Pending proposals')
    expect(prompt).toContain('Link the run item to marathon training.')
    expect(prompt.toLowerCase()).toContain('resolve_proposal')

    // Every populated section appears in the order specified by the brief:
    // constitution, realms, active arcs, latest daily rollup, yesterday,
    // pending proposals.
    const headers = [
      '## Constitution',
      '## Realms',
      '## Active arcs',
      '## Latest daily rollup',
      '## Yesterday',
      '## Pending proposals',
    ]
    const positions = headers.map((header) => prompt.indexOf(header))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))

    await engine.close()
  })

  it('omits sections with no content instead of leaving empty headers', async () => {
    const config = testConfig()
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

    const prompt = await assembleSystemPrompt(engine, config)

    expect(prompt).toContain('## Constitution')
    expect(prompt).not.toContain('## Realms')
    expect(prompt).not.toContain('## Active arcs')
    expect(prompt).not.toContain('## Latest daily rollup')
    expect(prompt).not.toContain('## Yesterday')
    expect(prompt).not.toContain('## Pending proposals')

    await engine.close()
  })

  it('includes realm names with their first line when realms exist', async () => {
    const realmPath = join(paths.realmsDir, 'fitness.md')
    await writeDocumentAtomic({
      path: realmPath,
      meta: { id: newId('doc'), name: 'Fitness' },
      body: 'Running, lifting, and sleep consistency.\nMore notes below.\n',
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'realm_fitness',
        type: 'realm',
        label: 'Fitness',
        doc: realmPath,
      },
    ])

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('## Realms')
    expect(prompt).toContain('Fitness')
    expect(prompt).toContain('Running, lifting, and sleep consistency.')
    // Only the first line, not the second, so it does not spill the whole body.
    expect(prompt).not.toContain('More notes below.')

    await engine.close()
  })

  it('includes the latest daily rollup and yesterday summaries when present', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)

    // Seed a reflected session dated yesterday by writing summary.md
    // directly (a session counts as reflected once summary.md exists;
    // see transcripts.ts SessionStore.listSessions).
    const store = await SessionStore.start(paths, yesterday)
    await store.appendLine({
      ts: yesterday.toISOString(),
      role: 'user',
      content: 'A quiet evening.',
    })
    await writeDocumentAtomic({
      path: join(store.dir, 'summary.md'),
      meta: { id: newId('doc') },
      body: 'Talked through a quiet, low-key evening.\n',
    })

    await writeDocumentAtomic({
      path: join(paths.rollupsDailyDir, '2026-08-10.md'),
      meta: { id: newId('doc'), date: '2026-08-10' },
      body: 'A steady day of small wins.\n',
    })

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('## Latest daily rollup')
    expect(prompt).toContain('A steady day of small wins.')

    expect(prompt).toContain('## Yesterday')
    expect(prompt).toContain('Talked through a quiet, low-key evening.')

    await engine.close()
  })

  it('renders the firewall persona at the top when the configured mode is firewall', async () => {
    const config = testConfig({ safety: { mode: 'firewall', resources: defaultCrisisResources } })
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

    const prompt = await assembleSystemPrompt(engine, config)

    const persona = buildPersona('firewall', defaultCrisisResources)
    expect(prompt.startsWith(persona)).toBe(true)

    await engine.close()
  })

  it('never contains an em dash character', async () => {
    const arcPath = join(paths.arcsDir, 'marathon.md')
    await writeDocumentAtomic({
      path: arcPath,
      meta: { id: newId('doc'), name: 'Marathon Training', status: 'active' },
      body: 'Training for the fall marathon.\n',
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_marathon',
        type: 'arc',
        label: 'Marathon Training',
        doc: arcPath,
      },
    ])

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).not.toContain('—')

    await engine.close()
  })
})
