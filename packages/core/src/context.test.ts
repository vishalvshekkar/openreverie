import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendGraph,
  type EngineDeps,
  ensureMemoryTree,
  MemoryEngine,
  type MemoryPaths,
  memoryPaths,
  newId,
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
    style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
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

    const pagedPersonPath = join(paths.peopleDir, 'priya.md')
    await writeDocumentAtomic({
      path: pagedPersonPath,
      meta: { id: newId('doc'), name: 'Priya', node: 'person_paged', opened: '2026-08-01' },
      body: 'This page is new. It grows as we talk.\n',
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'person_paged',
        type: 'person',
        label: 'Priya',
        doc: pagedPersonPath,
      },
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'person_nodeonly',
        type: 'person',
        label: 'Sam',
      },
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'entity_dune',
        type: 'entity',
        label: 'Dune',
      },
    ])

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const store = await SessionStore.start(paths, yesterday)
    await store.appendLine({
      ts: yesterday.toISOString(),
      role: 'user',
      content: 'A quiet evening.',
    })
    await writeDocumentAtomic({
      path: join(store.dir, 'summary.md'),
      meta: {
        id: newId('doc'),
        items: [
          { id: newId('item'), text: 'Call the dentist next week.', kind: 'intention', ts: '' },
        ],
      },
      body: 'Talked through a quiet, low-key evening.\n',
    })

    const config = testConfig()
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

    const prompt = await assembleSystemPrompt(engine, config)

    const persona = buildPersona(config.safety.mode, config.safety.resources, config.style)
    expect(prompt.startsWith(persona)).toBe(true)

    expect(prompt).toContain('## Constitution')
    expect(prompt).toContain('The user prefers direct, unflinching honesty over comfort.')

    expect(prompt).toContain('## Realms')
    expect(prompt).toContain('Fitness')

    expect(prompt).toContain('## Active arcs')
    expect(prompt).toContain('Marathon Training')
    expect(prompt).toContain('status: active')
    expect(prompt).toContain('last touched: 2026-08-10')

    expect(prompt).toContain('## People')
    expect(prompt).toContain('Priya (has a page)')
    expect(prompt).toContain('Sam (no page yet)')

    expect(prompt).toContain('## Entities')
    expect(prompt).toContain('Dune')

    expect(prompt).toContain('## Recent intentions')
    expect(prompt).toContain('Call the dentist next week.')

    expect(prompt).toContain('## Latest daily rollup')
    expect(prompt).toContain('A steady day of small wins.')

    expect(prompt).toContain('## Recent sessions')
    expect(prompt).toContain('Talked through a quiet, low-key evening.')

    expect(prompt).not.toContain('## Pending proposals')

    // Every populated section appears in the order specified by the brief:
    // constitution, realms, active arcs, people, entities, recent
    // intentions, latest daily rollup, recent sessions.
    const headers = [
      '## Constitution',
      '## Realms',
      '## Active arcs',
      '## People',
      '## Entities',
      '## Recent intentions',
      '## Latest daily rollup',
      '## Recent sessions',
    ]
    const positions = headers.map((header) => prompt.indexOf(header))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))

    await engine.close()
  })

  it('omits sections with no content instead of leaving empty headers', async () => {
    // A dormant arc (not active, so it never populates "## Active arcs")
    // is enough to make this memory not a first session, so the normal
    // optional-section rendering (rather than the first-conversation
    // flow) is what is under test here.
    const dormantArcPath = join(paths.arcsDir, 'dormant-arc.md')
    await writeDocumentAtomic({
      path: dormantArcPath,
      meta: { id: newId('doc'), name: 'Dormant Arc', status: 'dormant' },
      body: 'On pause.\n',
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_dormant',
        type: 'arc',
        label: 'Dormant Arc',
        doc: dormantArcPath,
      },
    ])

    const config = testConfig()
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

    const prompt = await assembleSystemPrompt(engine, config)

    expect(prompt).not.toContain('## First conversation')
    expect(prompt).toContain('## Constitution')
    expect(prompt).not.toContain('## Realms')
    expect(prompt).not.toContain('## Active arcs')
    expect(prompt).not.toContain('## People')
    expect(prompt).not.toContain('## Entities')
    expect(prompt).not.toContain('## Recent intentions')
    expect(prompt).not.toContain('## Latest daily rollup')
    expect(prompt).not.toContain('## Recent sessions')

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
    // An arc (any status) is enough to make this not a first session, so
    // the normal optional-section rendering applies here rather than the
    // first-conversation flow.
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

    expect(prompt).toContain('## Realms')
    expect(prompt).toContain('Fitness')
    expect(prompt).toContain('Running, lifting, and sleep consistency.')
    // Only the first line, not the second, so it does not spill the whole body.
    expect(prompt).not.toContain('More notes below.')

    await engine.close()
  })

  it('includes the latest daily rollup and recent session summaries when present', async () => {
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

    expect(prompt).toContain('## Recent sessions')
    expect(prompt).toContain('Talked through a quiet, low-key evening.')

    await engine.close()
  })

  it('shows the date of each recent session next to its summary', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    const store = await SessionStore.start(paths, twoDaysAgo)
    await store.appendLine({
      ts: twoDaysAgo.toISOString(),
      role: 'user',
      content: 'A short, uneventful check-in.',
    })
    const dateString = twoDaysAgo.toISOString().slice(0, 10)
    await writeDocumentAtomic({
      path: join(store.dir, 'summary.md'),
      meta: { id: newId('doc') },
      body: 'Checked in briefly, nothing pressing.\n',
    })

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('## Recent sessions')
    expect(prompt).toContain(dateString)
    expect(prompt).toContain('Checked in briefly, nothing pressing.')

    await engine.close()
  })

  it("states today's date near the top, in the same form as recent session dates", async () => {
    await writeDocumentAtomic({
      path: paths.constitution,
      meta: { id: newId('doc') },
      body: 'The user prefers direct, unflinching honesty over comfort.\n',
    })
    // An arc (any status) is enough to make this not a first session, so
    // the normal optional-section rendering applies here rather than the
    // first-conversation flow, and "## Constitution" actually renders.
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

    const today = new Date().toISOString().slice(0, 10)
    expect(prompt).toContain('## Today')
    expect(prompt).toContain(today)
    expect(prompt.indexOf('## Today')).toBeLessThan(prompt.indexOf('## Constitution'))

    await engine.close()
  })

  it('renders the firewall persona at the top when the configured mode is firewall', async () => {
    const config = testConfig({ safety: { mode: 'firewall', resources: defaultCrisisResources } })
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

    const prompt = await assembleSystemPrompt(engine, config)

    const persona = buildPersona('firewall', defaultCrisisResources, config.style)
    expect(prompt.startsWith(persona)).toBe(true)

    await engine.close()
  })

  describe('first conversation', () => {
    it('renders a First conversation section instead of the usual optional sections on a completely fresh engine', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).toContain('## First conversation')
      expect(prompt).not.toContain('## Constitution')
      expect(prompt).not.toContain('## Realms')
      expect(prompt).not.toContain('## Active arcs')
      expect(prompt).not.toContain('## Latest daily rollup')
      expect(prompt).not.toContain('## Recent sessions')
      expect(prompt).not.toContain('## Pending proposals')

      const lower = prompt.toLowerCase()
      // Guardrail: memory is empty, so nothing to search, and never offer
      // to pick up from before (a brand-new user has no "before").
      expect(lower).toContain('nothing to search')
      expect(lower).not.toContain('pick up')

      // A short warm welcome: private, runs on their machine, remembers so
      // future sessions start with context, and one clause that it is not
      // a therapist.
      expect(lower).toContain('private')
      expect(lower).toContain('own machine')
      expect(lower).toContain('not a therapist')

      // Gentle, one-question-at-a-time onboarding.
      expect(lower).toContain('name')
      expect(lower).toContain('pronoun')
      expect(lower).toContain('timezone')
      expect(lower).toContain('one question at a time')

      await engine.close()
    })

    it('omits the First conversation section once a session has been reflected', async () => {
      const startedAt = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const store = await SessionStore.start(paths, startedAt)
      await store.appendLine({ ts: startedAt.toISOString(), role: 'user', content: 'Hello.' })
      await writeDocumentAtomic({
        path: join(store.dir, 'summary.md'),
        meta: { id: newId('doc') },
        body: 'A first, brief hello.\n',
      })

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).not.toContain('## First conversation')

      await engine.close()
    })

    it('omits the First conversation section when an arc already exists, even with no reflected sessions', async () => {
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

      expect(prompt).not.toContain('## First conversation')

      await engine.close()
    })

    it("still states today's date during a first conversation", async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig())

      const today = new Date().toISOString().slice(0, 10)
      expect(prompt).toContain('## Today')
      expect(prompt).toContain(today)

      await engine.close()
    })

    it('states that first-conversation guidance outranks the engagement setting during a first conversation', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig())

      const lower = prompt.toLowerCase()
      expect(lower).toContain('outranks the engagement setting')

      await engine.close()
    })
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
