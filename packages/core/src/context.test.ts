import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendDreamLog,
  appendGraph,
  type DreamInsight,
  type EngineDeps,
  ensureMemoryTree,
  loadProfile,
  MemoryEngine,
  type MemoryPaths,
  memoryPaths,
  newId,
  SessionStore,
  writeDocumentAtomic,
  writeProfile,
} from '@openreverie/memory'
import { FakeChatProvider, FakeEmbeddingProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROFILE_BODY_CAP } from './budget.js'
import { defaultCrisisResources, type ReverieConfig } from './config.js'
import { assembleSystemPrompt, PROFILE_TRUNCATION_MARKER } from './context.js'
import { buildPersona } from './personas.js'

function testConfig(overrides: Partial<ReverieConfig> = {}): ReverieConfig {
  return {
    memoryDir: '/somewhere/memory',
    provider: { name: 'openai', apiKeyEnv: 'OPENREVERIE_TEST_KEY' },
    models: { chat: 'gpt-5', reflection: 'gpt-5-mini', embeddings: 'text-embedding-3-small' },
    safety: { mode: 'companion', resources: defaultCrisisResources },
    dreaming: {
      enabled: false,
      cadence: 'daily',
      triggers: { afterSession: true, onStart: true, serverTimer: true },
      maxToolCalls: 10,
    },
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

async function pinTimezoneUtc(paths: MemoryPaths): Promise<void> {
  const profile = await loadProfile(paths)
  await writeProfile(paths, {
    meta: { ...profile.meta, timezone: 'UTC', timezoneSource: 'user-confirmed' },
    body: profile.body,
  })
}

function makeInsight(overrides: Partial<DreamInsight> = {}): DreamInsight {
  return {
    id: newId('ins'),
    kind: 'pattern',
    headline: 'A quiet pattern',
    claim: 'They tend to go quiet for a day after a hard conversation.',
    confidence: 0.7,
    evidence: [],
    ...overrides,
  }
}

// Writes a dream directory the same shape runDream leaves on disk (Task 7),
// but hand-built rather than run through the model: dreamsSection only
// ever reads insight.md's meta.insights, so that is all this needs to seed.
async function writeDream(
  paths: MemoryPaths,
  args: { date: string; dreamId: string; insights: DreamInsight[] },
): Promise<void> {
  const dir = join(paths.dreamsDir, `${args.date}-${args.dreamId}`)
  await mkdir(dir, { recursive: true })
  await writeDocumentAtomic({
    path: join(dir, 'insight.md'),
    meta: {
      id: newId('doc'),
      kind: 'dream_insight',
      dream: args.dreamId,
      date: args.date,
      period: args.date,
      insights: args.insights,
    },
    body: 'A dream insight document, for the dreamsSection test fixtures.\n',
  })
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
    await writeDream(paths, {
      date: '2026-08-20',
      dreamId: 'dream_order1',
      insights: [makeInsight({ id: 'ins_order1' })],
    })

    const config = testConfig()
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

    const prompt = await assembleSystemPrompt(engine, config)

    const persona = buildPersona(config.safety.mode, config.safety.resources, engine.currentStyle())
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
    expect(prompt).toContain('Priya (person_paged, has a page)')
    expect(prompt).toContain('Sam (person_nodeonly, no page yet)')

    expect(prompt).toContain('## Entities')
    expect(prompt).toContain('Dune')

    expect(prompt).toContain('## Recent intentions')
    expect(prompt).toContain('Call the dentist next week.')

    expect(prompt).toContain('## Between-session reflections (dreams)')
    expect(prompt).toContain('ins_order1')

    expect(prompt).toContain('## Latest daily rollup')
    expect(prompt).toContain('A steady day of small wins.')

    expect(prompt).toContain('## Recent sessions')
    expect(prompt).toContain('Talked through a quiet, low-key evening.')

    expect(prompt).not.toContain('## Pending proposals')

    // Every populated section appears in the order specified by the brief:
    // constitution, realms, active arcs, people, entities, recent
    // intentions, dreams, latest daily rollup, recent sessions.
    const headers = [
      '## Constitution',
      '## Realms',
      '## Active arcs',
      '## People',
      '## Entities',
      '## Recent intentions',
      '## Between-session reflections (dreams)',
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
    await pinTimezoneUtc(paths)
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

  it('shows the date of each recent intention next to its text', async () => {
    await pinTimezoneUtc(paths)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const store = await SessionStore.start(paths, yesterday)
    await store.appendLine({ ts: yesterday.toISOString(), role: 'user', content: 'Hi.' })
    const dateString = yesterday.toISOString().slice(0, 10)
    await writeDocumentAtomic({
      path: join(store.dir, 'summary.md'),
      meta: {
        id: newId('doc'),
        items: [
          { id: newId('item'), text: 'Call the dentist next week.', kind: 'intention', ts: '' },
        ],
      },
      body: 'A quiet day.\n',
    })

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('## Recent intentions')
    expect(prompt).toContain(`${dateString}: Call the dentist next week.`)

    await engine.close()
  })

  it('marks the people section as truncated once there are more people than the cap, and still shows each remaining line with its id', async () => {
    // A reflected session, so this is not treated as the very first
    // conversation (which would replace every normal section, including
    // People, with the guided onboarding flow instead).
    const store = await SessionStore.start(paths, new Date())
    await writeDocumentAtomic({
      path: join(store.dir, 'summary.md'),
      meta: { id: newId('doc') },
      body: 'A prior session.\n',
    })

    const records: Parameters<typeof appendGraph>[1] = []
    for (let i = 0; i < 45; i++) {
      records.push({
        ts: `2026-02-01T00:${String(i).padStart(2, '0')}:00.000Z`,
        op: 'assert',
        node: `person_${i}`,
        type: 'person',
        label: `Person ${i}`,
      })
    }
    await appendGraph(paths, records)

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('## People')
    expect(prompt).toContain('Call list_people to page through the rest')
    expect(prompt).toContain('Person 44 (person_44, no page yet)')
    expect(prompt).not.toContain('Person 0 (person_0, no page yet)')

    await engine.close()
  })

  it('states the timezone in a Time section near the top, with no clock in it', async () => {
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
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('## Time')
    expect(prompt).toContain("This person's timezone is Asia/Kolkata.")
    expect(prompt).toContain('stamped with the local date and time it was sent')
    expect(prompt).not.toContain('## Today')
    expect(prompt.indexOf('## Time')).toBeLessThan(prompt.indexOf('## Constitution'))
    // Nothing in this section moves on its own: a clock read here would
    // cost the whole conversation history's cache on every turn.
    expect(prompt).not.toContain(new Date().toISOString().slice(0, 10))

    await engine.close()
  })

  it('says plainly when the timezone is only a system default, and drops that line once confirmed', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

    const seeded = await assembleSystemPrompt(engine, testConfig())
    expect(seeded).toContain('This timezone is a system default, not yet confirmed by the person.')

    await engine.updateProfile({ timezone: 'Asia/Kolkata' })
    const confirmed = await assembleSystemPrompt(engine, testConfig())
    expect(confirmed).not.toContain('This timezone is a system default')

    await engine.close()
  })

  it('renders the firewall persona at the top when the configured mode is firewall', async () => {
    const config = testConfig({ safety: { mode: 'firewall', resources: defaultCrisisResources } })
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

    const prompt = await assembleSystemPrompt(engine, config)

    const persona = buildPersona('firewall', defaultCrisisResources, engine.currentStyle())
    expect(prompt.startsWith(persona)).toBe(true)

    await engine.close()
  })

  describe('dreamsSection', () => {
    it("renders a selected insight's id, kind, headline, and claim", async () => {
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'arc_any',
          type: 'arc',
          label: 'Any Arc',
        },
      ])
      await writeDream(paths, {
        date: '2026-08-20',
        dreamId: 'dream_a',
        insights: [
          makeInsight({
            id: 'ins_visible1',
            kind: 'connection',
            headline: 'A quiet thread',
            claim: 'Work stress and skipped runs seem to move together.',
          }),
        ],
      })

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).toContain('## Between-session reflections (dreams)')
      expect(prompt).toContain(
        '- [ins_visible1] (connection) A quiet thread: Work stress and skipped runs seem to move together.',
      )

      await engine.close()
    })

    it('omits the section entirely when no dream has ever run', async () => {
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'arc_any',
          type: 'arc',
          label: 'Any Arc',
        },
      ])

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).not.toContain('## Between-session reflections')

      await engine.close()
    })

    it('permanently excludes an insight the person said was wrong, keeping one with no feedback', async () => {
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'arc_any',
          type: 'arc',
          label: 'Any Arc',
        },
      ])
      const wrongInsight = makeInsight({
        id: 'ins_wrong1',
        headline: 'A pattern that was not real',
        claim: 'This claim is not actually true.',
      })
      const keptInsight = makeInsight({
        id: 'ins_kept1',
        headline: 'A pattern that held up',
        claim: 'This claim was never disputed.',
      })
      await writeDream(paths, {
        date: '2026-08-20',
        dreamId: 'dream_a',
        insights: [wrongInsight, keptInsight],
      })
      await appendDreamLog(paths, [
        {
          ts: '2026-08-21T00:00:00.000Z',
          type: 'feedback',
          insight: 'ins_wrong1',
          dream: 'dream_a',
          verdict: 'wrong',
          source: 'ui',
        },
      ])

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).not.toContain('ins_wrong1')
      expect(prompt).not.toContain('A pattern that was not real')
      expect(prompt).toContain('ins_kept1')
      expect(prompt).toContain('A pattern that held up')

      await engine.close()
    })

    it('permanently excludes an insight marked do_not_bring_up', async () => {
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'arc_any',
          type: 'arc',
          label: 'Any Arc',
        },
      ])
      await writeDream(paths, {
        date: '2026-08-20',
        dreamId: 'dream_a',
        insights: [
          makeInsight({
            id: 'ins_hush1',
            headline: 'A sensitive topic',
            claim: 'They asked not to hear this again.',
          }),
          makeInsight({
            id: 'ins_kept2',
            headline: 'Fine to mention',
            claim: 'Nothing sensitive here.',
          }),
        ],
      })
      await appendDreamLog(paths, [
        {
          ts: '2026-08-21T00:00:00.000Z',
          type: 'feedback',
          insight: 'ins_hush1',
          dream: 'dream_a',
          verdict: 'do_not_bring_up',
          source: 'ui',
        },
      ])

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).not.toContain('ins_hush1')
      expect(prompt).toContain('ins_kept2')

      await engine.close()
    })

    it('is omitted when profile.dreams.promptSection is false, even with insights on disk', async () => {
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'arc_any',
          type: 'arc',
          label: 'Any Arc',
        },
      ])
      await writeDream(paths, {
        date: '2026-08-20',
        dreamId: 'dream_a',
        insights: [makeInsight({ id: 'ins_hidden1' })],
      })
      const profile = await loadProfile(paths)
      await writeProfile(paths, {
        meta: { ...profile.meta, dreams: { promptSection: false } },
        body: profile.body,
      })

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).not.toContain('## Between-session reflections')
      expect(prompt).not.toContain('ins_hidden1')

      await engine.close()
    })

    it('caps the rendered rows by the section character budget, dropping the rest', async () => {
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'arc_any',
          type: 'arc',
          label: 'Any Arc',
        },
      ])
      await writeDream(paths, {
        date: '2026-08-20',
        dreamId: 'dream_a',
        insights: [
          makeInsight({ id: 'ins_first1', headline: 'AAAA marker', claim: 'a'.repeat(900) }),
          makeInsight({ id: 'ins_second1', headline: 'BBBB marker', claim: 'b'.repeat(900) }),
          makeInsight({ id: 'ins_third1', headline: 'CCCC marker', claim: 'c'.repeat(900) }),
        ],
      })

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).toContain('AAAA marker')
      expect(prompt).not.toContain('BBBB marker')
      expect(prompt).not.toContain('CCCC marker')
      expect(prompt).toContain(
        '(showing 1 of 3 dream insights. Find older ones with search_memory using kind dream_insight.)',
      )

      await engine.close()
    })

    it('shows no truncation marker on the dreams section when nothing was dropped', async () => {
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'arc_any',
          type: 'arc',
          label: 'Any Arc',
        },
      ])
      await writeDream(paths, {
        date: '2026-08-20',
        dreamId: 'dream_a',
        insights: [
          makeInsight({ id: 'ins_short1', headline: 'A short one', claim: 'Nothing long here.' }),
        ],
      })

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).toContain('ins_short1')
      expect(prompt).not.toContain('showing')
      expect(prompt).not.toContain('search_memory using kind dream_insight')

      await engine.close()
    })

    it('carries at most 8 insights even when the character budget would fit more', async () => {
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'arc_any',
          type: 'arc',
          label: 'Any Arc',
        },
      ])
      // Ten short insights: each row is well under a tenth of
      // DREAM_INSIGHTS_SECTION_CAP, so if all ten showed up the character
      // budget alone would not have stopped them. Only a row-count cap
      // (DREAM_INSIGHTS_CAP in engine.ts) explains fewer than ten.
      const insights = Array.from({ length: 10 }, (_, i) => {
        const n = String(i + 1).padStart(2, '0')
        return makeInsight({ id: `ins_n${n}`, headline: `Marker ${n}`, claim: `Short claim ${n}.` })
      })
      await writeDream(paths, { date: '2026-08-20', dreamId: 'dream_a', insights })

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).toContain('ins_n08')
      expect(prompt).not.toContain('ins_n09')
      expect(prompt).not.toContain('ins_n10')

      await engine.close()
    })
  })

  describe('journalingProtocolSection', () => {
    it('is absent when the session is not in journal mode', async () => {
      // An arc so this is not treated as a first session, which would
      // replace every optional section with the onboarding block.
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'arc_any',
          type: 'arc',
          label: 'Any Arc',
        },
      ])

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).not.toContain('## Journaling protocol')

      await engine.close()
    })

    it('renders the journaling protocol body when present, immediately after the constitution section', async () => {
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'arc_any',
          type: 'arc',
          label: 'Any Arc',
        },
      ])
      await writeDocumentAtomic({
        path: paths.journaling,
        meta: { id: newId('doc'), kind: 'journaling', updated: '2026-08-01T00:00:00.000Z' },
        body: 'Gratitude, three times a week.\n',
      })

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig(), 'journal')

      expect(prompt).toContain('## Journaling protocol')
      expect(prompt).toContain('Gratitude, three times a week.')
      const constitutionIndex = prompt.indexOf('## Constitution')
      const journalingIndex = prompt.indexOf('## Journaling protocol')
      expect(journalingIndex).toBeGreaterThan(constitutionIndex)
      // "Immediately after" means no other section's header sits between
      // them, not merely that journaling comes somewhere later. This memory
      // also has an active arc, so "## Active arcs" is in the prompt too;
      // this assertion is the one that would catch it sneaking in between.
      const between = prompt.slice(constitutionIndex + '## Constitution'.length, journalingIndex)
      expect(between).not.toMatch(/\n## /)
      // "Their configured setup: ..." exists only inside buildPersona's mode
      // paragraph (personas.ts), never inside journalingProtocolSection
      // above. Nothing else in this file checks that assembleSystemPrompt
      // actually threads context.journalingProtocol into the buildPersona
      // call site: dropping that argument would silently fall back to the
      // JOURNALING_PROTOCOL_ABSENT sentinel there while this section still
      // rendered the real protocol, a self-contradicting prompt a green
      // suite would otherwise miss.
      expect(prompt).toContain('Their configured setup: Gratitude, three times a week.')

      await engine.close()
    })

    it('renders the absent sentinel plainly when journal mode is active but journaling.md does not exist', async () => {
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'arc_any',
          type: 'arc',
          label: 'Any Arc',
        },
      ])

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig(), 'journal')

      expect(prompt).toContain('has never set up journal mode before')

      await engine.close()
    })

    it('is absent during the first conversation even if a mode was somehow passed', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig(), 'journal')

      expect(prompt).not.toContain('## Journaling protocol')

      await engine.close()
    })
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

    it('still states the Time section during a first conversation', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      await engine.updateProfile({ timezone: 'Asia/Kolkata' })
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).toContain('## Time')
      expect(prompt).toContain("This person's timezone is Asia/Kolkata.")
      expect(prompt).not.toContain('## Today')

      await engine.close()
    })

    it('states that first-conversation guidance outranks the engagement setting during a first conversation', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig())

      const lower = prompt.toLowerCase()
      expect(lower).toContain('outranks the engagement setting')

      await engine.close()
    })

    it('leaves the onboarding questions conversational and mentions no profile field', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).toContain('their name and how they would like to be addressed')
      expect(prompt).toContain('where they live and their timezone')
      expect(prompt).not.toContain('profile.md')
      expect(prompt).not.toContain('update_profile')

      const firstConversation = prompt.slice(prompt.indexOf('## First conversation'))
      expect(firstConversation).not.toContain('birthday')

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

  it('renders each recent session id so the model can pass one to read_transcript', async () => {
    const startedAt = new Date('2026-08-15T09:00:00.000Z')
    const store = await SessionStore.start(paths, startedAt, 'UTC')
    await store.appendLine({ ts: startedAt.toISOString(), role: 'user', content: 'Hello.' })
    await writeDocumentAtomic({
      path: join(store.dir, 'summary.md'),
      meta: {
        id: newId('doc'),
        kind: 'summary',
        session: store.sessionId,
        date: '2026-08-15',
        items: [],
      },
      body: 'We talked about the move and how unsettled it left him.\n',
    })

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })
    await engine.updateProfile({ timezone: 'UTC' })
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('## Recent sessions')
    expect(prompt).toContain(
      `2026-08-15 (${store.sessionId}): We talked about the move and how unsettled it left him.`,
    )

    await engine.close()
  })

  it('names the tool that reaches the people and entities the prompt could not show', async () => {
    const records = []
    for (let i = 0; i < 45; i++) {
      records.push({
        ts: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00.000Z`,
        op: 'assert' as const,
        node: `person_${i}`,
        type: 'person' as const,
        label: `Person ${i}`,
      })
    }
    for (let i = 0; i < 35; i++) {
      records.push({
        ts: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00.000Z`,
        op: 'assert' as const,
        node: `entity_${i}`,
        type: 'entity' as const,
        label: `Entity ${i}`,
      })
    }
    // An arc so this is not treated as a first session, which would replace
    // every optional section with the onboarding block.
    records.push({
      ts: '2026-08-01T00:00:00.000Z',
      op: 'assert' as const,
      node: 'arc_any',
      type: 'arc' as const,
      label: 'Any Arc',
    })
    await appendGraph(paths, records)

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain(
      '(showing 40 of 45 people, paged people first then most recently added. Call list_people to page through the rest, or search_memory by name.)',
    )
    expect(prompt).toContain(
      '(showing 30 of 35 entities, most recently added first. Call list_entities to page through the rest, or search_memory by name.)',
    )

    await engine.close()
  })

  it('shows no truncation marker when nothing was truncated', async () => {
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_any',
        type: 'arc',
        label: 'Any Arc',
      },
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'person_only',
        type: 'person',
        label: 'Only Person',
      },
    ])

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('## People')
    expect(prompt).not.toContain('Call list_people')

    await engine.close()
  })

  describe('profile section', () => {
    it('renders a set preferred name into the prompt', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      await engine.updateProfile({ preferredName: 'Vish' })
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).toContain('## Profile')
      expect(prompt).toContain('Preferred name: Vish')

      await engine.close()
    })

    // Asserted together with the set case on purpose: the unset case passes
    // by coincidence if the render call is deleted, so only the pair proves
    // the section behaves.
    it('says nothing at all about an unset field, not even unknown', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      await engine.updateProfile({ preferredName: 'Vish' })
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).not.toContain('Pronouns')
      expect(prompt).not.toContain('unknown')

      await engine.close()
    })

    it('renders the fields in the fixed spec order', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      await engine.updateProfile({
        preferredName: 'Vish',
        pronouns: 'they/them',
        location: 'Bengaluru',
        birthday: '04-02',
        occupation: 'nurse',
        birthdayGreetings: true,
      })
      const prompt = await assembleSystemPrompt(engine, testConfig())

      const order = [
        'Preferred name:',
        'Pronouns:',
        'Location:',
        'Birthday:',
        'Occupation:',
        'Birthday greetings:',
      ].map((label) => prompt.indexOf(label))
      expect(order.every((index) => index >= 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)

      await engine.close()
    })

    it('leaves timezone out, because the Time section already carries it', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      await engine.updateProfile({ timezone: 'Asia/Kolkata', preferredName: 'Vish' })
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).not.toContain('Timezone: Asia/Kolkata')

      await engine.close()
    })

    it('hides birthday greetings until a birthday is recorded', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      await engine.updateProfile({ birthdayGreetings: true })
      const withoutBirthday = await assembleSystemPrompt(engine, testConfig())
      expect(withoutBirthday).not.toContain('Birthday greetings:')

      await engine.updateProfile({ birthday: '04-02' })
      const withBirthday = await assembleSystemPrompt(engine, testConfig())
      expect(withBirthday).toContain('Birthday greetings: yes')

      await engine.close()
    })

    it('omits the whole heading when nothing is set and the prose is only the starter boilerplate', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).not.toContain('## Profile')

      await engine.close()
    })

    it('renders the prose body after the fields', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      await engine.updateProfile({ preferredName: 'Vish' })
      await engine.updateProfileSettings({
        prose: 'Prefers to be called Vish by everyone except his mother.',
      })
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt.indexOf('except his mother')).toBeGreaterThan(
        prompt.indexOf('Preferred name: Vish'),
      )

      await engine.close()
    })

    it('truncates a prose body over the cap and marks it, without touching the file', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const long = 'x'.repeat(PROFILE_BODY_CAP + 500)
      await engine.updateProfileSettings({ prose: long })
      const onDisk = await readFile(paths.profile, 'utf8')
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).toContain(PROFILE_TRUNCATION_MARKER)
      expect(prompt).not.toContain('x'.repeat(PROFILE_BODY_CAP + 1))
      expect(prompt).toContain('x'.repeat(PROFILE_BODY_CAP))
      expect(onDisk).toContain('x'.repeat(PROFILE_BODY_CAP + 500))

      await engine.close()
    })

    it('leaves a prose body at exactly the cap unmarked', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      await engine.updateProfileSettings({ prose: 'y'.repeat(PROFILE_BODY_CAP) })
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).not.toContain(PROFILE_TRUNCATION_MARKER)

      await engine.close()
    })

    it('renders the profile during the first conversation too', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      await engine.updateProfile({ pronouns: 'they/them' })
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).toContain('## First conversation')
      expect(prompt).toContain('Pronouns: they/them')

      await engine.close()
    })

    // isFirstSession is true for a totally fresh engine, so a test built
    // that way exercises only the first-session sections array. Without a
    // case in the ordinary, non-first-session branch too, deleting
    // profileSection from that array would pass the whole suite by
    // omission rather than by the section actually working there.
    it('renders during a non-first session too', async () => {
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
      await engine.updateProfile({ preferredName: 'Vish' })
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).not.toContain('## First conversation')
      expect(prompt).toContain('## Profile')
      expect(prompt).toContain('Preferred name: Vish')

      await engine.close()
    })
  })

  describe('mode in the assembled prompt', () => {
    it('carries the mode paragraph when a mode is passed', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig(), 'listen')

      expect(prompt).toContain('## Mode: listen')

      await engine.close()
    })

    it('carries no mode section by default', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const prompt = await assembleSystemPrompt(engine, testConfig())

      expect(prompt).not.toContain('## Mode:')

      await engine.close()
    })
  })
})

describe('assembleSystemPrompt budget', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-context-budget-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function openEngine(): Promise<MemoryEngine> {
    return MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), { maintenance: false })
  }

  it('caps the constitution and hands back its docId for the full text', async () => {
    const docId = newId('doc')
    const sentinel = 'THE SENTINEL SENTENCE THAT IS NEVER SHOWN'
    const body = `${'a'.repeat(6000)}\n\n${'b'.repeat(1000)}\n\n${sentinel}`
    await writeDocumentAtomic({ path: paths.constitution, meta: { id: docId }, body })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_any',
        type: 'arc',
        label: 'Any Arc',
      },
    ])

    const engine = await openEngine()
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('(truncated: showing the first 6,000 of')
    expect(prompt).toContain(`Call read_document with docId ${docId} for the full text.`)
    expect(prompt).not.toContain(sentinel)

    const full = await engine.readDocumentById(docId)
    expect(full?.body).toContain(sentinel)

    await engine.close()
  })

  it('leaves a short constitution uncapped and with no truncation marker', async () => {
    await writeDocumentAtomic({
      path: paths.constitution,
      meta: { id: newId('doc') },
      body: 'The user prefers direct, unflinching honesty.\n',
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_any',
        type: 'arc',
        label: 'Any Arc',
      },
    ])

    const engine = await openEngine()
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('The user prefers direct, unflinching honesty.')
    expect(prompt).not.toContain('(truncated:')

    await engine.close()
  })

  it('clips each realm first line to 160 characters', async () => {
    await writeDocumentAtomic({
      path: join(paths.realmsDir, 'fitness.md'),
      meta: { id: newId('doc'), name: 'Fitness' },
      body: `${'x'.repeat(200)}\n`,
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'realm_fitness',
        type: 'realm',
        label: 'Fitness',
        doc: join(paths.realmsDir, 'fitness.md'),
      },
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_any',
        type: 'arc',
        label: 'Any Arc',
      },
    ])

    const engine = await openEngine()
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('x'.repeat(160))
    expect(prompt).not.toContain('x'.repeat(161))

    await engine.close()
  })

  it('caps active arcs at 30 and names list_arcs for the rest', async () => {
    const records: Parameters<typeof appendGraph>[1] = []
    // Distinct, short (date-only) "last touched" values, one calendar day
    // apart and strictly increasing with i. A full ISO-with-time stamp
    // (as used elsewhere in this file) makes each of these 33 rows long
    // enough that 30 of them exceed ARCS_SECTION_CAP (2000 characters),
    // which would make the character-level list cap truncate below the
    // row-level ARCS_CAP this test means to exercise. Date-only values
    // keep the 30 rows this test expects to see comfortably under budget.
    const baseDate = new Date('2026-09-02T00:00:00.000Z')
    for (let i = 0; i < 33; i++) {
      const arcPath = join(paths.arcsDir, `arc-${i}.md`)
      const touched = new Date(baseDate.getTime() - (32 - i) * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10)
      await writeDocumentAtomic({
        path: arcPath,
        meta: {
          id: newId('doc'),
          name: `Active Arc ${String(i).padStart(2, '0')}`,
          status: 'active',
          updated: touched,
        },
        body: `Arc ${i}.\n`,
      })
      records.push({
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: `arc_${i}`,
        type: 'arc',
        label: `Active Arc ${String(i).padStart(2, '0')}`,
        doc: arcPath,
      })
    }
    await appendGraph(paths, records)

    const engine = await openEngine()
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain(
      '(showing 30 of 33 active arcs, most recently touched first. Call list_arcs for the rest, including dormant and closed ones.)',
    )
    expect(prompt).toContain('Active Arc 32')
    expect(prompt).not.toContain('Active Arc 00')

    await engine.close()
  })

  it('marks the arcs list when the character cap cuts it short, even under the row cap', async () => {
    // Fewer arcs than ARCS_CAP, so arcsTruncated stays false, but each row is
    // long enough that ARCS_SECTION_CAP cuts the list short anyway. Without
    // the character-cap check the section would drop arcs and say nothing
    // about it, which is the silent shelf this release exists to remove.
    const records: Parameters<typeof appendGraph>[1] = []
    const longName = 'Arc With A Deliberately Long Name That Eats The Character Budget'
    for (let i = 0; i < 20; i++) {
      const name = `${longName} ${String(i).padStart(2, '0')}`
      const arcPath = join(paths.arcsDir, `long-arc-${i}.md`)
      await writeDocumentAtomic({
        path: arcPath,
        meta: {
          id: newId('doc'),
          name,
          status: 'active',
          updated: `2026-08-${String(i + 1).padStart(2, '0')}`,
        },
        body: `Arc ${i}.\n`,
      })
      records.push({
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: `arc_long_${i}`,
        type: 'arc',
        label: name,
        doc: arcPath,
      })
    }
    await appendGraph(paths, records)

    const engine = await openEngine()
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain(
      'of 20 active arcs, most recently touched first. Call list_arcs for the rest',
    )

    await engine.close()
  })
  it('shows no arcs marker when under the cap, and orders undated arcs last', async () => {
    const datedPath = join(paths.arcsDir, 'touched.md')
    await writeDocumentAtomic({
      path: datedPath,
      meta: { id: newId('doc'), name: 'Touched Arc', status: 'active', updated: '2026-08-10' },
      body: 'Touched.\n',
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-02T00:00:00.000Z',
        op: 'assert',
        node: 'arc_loose_two',
        type: 'arc',
        label: 'Loose Two',
      },
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_touched',
        type: 'arc',
        label: 'Touched Arc',
        doc: datedPath,
      },
      {
        ts: '2026-08-03T00:00:00.000Z',
        op: 'assert',
        node: 'arc_loose_one',
        type: 'arc',
        label: 'Loose One',
      },
    ])

    const engine = await openEngine()
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('## Active arcs')
    expect(prompt).not.toContain('Call list_arcs for the rest')

    const touched = prompt.indexOf('Touched Arc')
    const looseOne = prompt.indexOf('Loose One')
    const looseTwo = prompt.indexOf('Loose Two')
    expect(touched).toBeGreaterThan(-1)
    expect(touched).toBeLessThan(looseOne)
    expect(looseOne).toBeLessThan(looseTwo)

    await engine.close()
  })

  it('caps an over-long daily rollup and hands back its docId', async () => {
    const docId = newId('doc')
    const sentinel = 'THE ROLLUP SENTINEL'
    await writeDocumentAtomic({
      path: join(paths.rollupsDailyDir, '2026-08-10.md'),
      meta: { id: docId, date: '2026-08-10' },
      body: `${'c'.repeat(2500)}\n\n${sentinel}`,
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_any',
        type: 'arc',
        label: 'Any Arc',
      },
    ])

    const engine = await openEngine()
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('(truncated: showing the first 2,500 of')
    expect(prompt).toContain(`Call read_document with docId ${docId} for the full text.`)
    expect(prompt).not.toContain(sentinel)

    await engine.close()
  })

  it('caps each recent session summary independently', async () => {
    const store = await SessionStore.start(paths, new Date(Date.now() - 24 * 60 * 60 * 1000))
    const docId = newId('doc')
    const sentinel = 'THE SUMMARY SENTINEL'
    await writeDocumentAtomic({
      path: join(store.dir, 'summary.md'),
      meta: { id: docId },
      body: `${'d'.repeat(2000)}\n\n${sentinel}`,
    })

    const engine = await openEngine()
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('(truncated: showing the first 2,000 of')
    expect(prompt).toContain(`Call read_document with docId ${docId} for the full text.`)
    expect(prompt).not.toContain(sentinel)

    await engine.close()
  })
})

describe('assembleSystemPrompt rollup shelf', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-context-shelf-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('preloads a compact index of weekly rollups, each with a docId, never the content', async () => {
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_any',
        type: 'arc',
        label: 'Any Arc',
      },
    ])

    const ids: string[] = []
    for (let w = 19; w <= 33; w++) {
      const week = `2026-W${String(w).padStart(2, '0')}`
      const docId = newId('doc')
      ids.push(docId)
      await writeDocumentAtomic({
        path: join(paths.rollupsWeeklyDir, `${week}.md`),
        meta: { id: docId, kind: 'rollup_weekly', week },
        body: `Week ${w} content that must never be preloaded.\n`,
      })
    }
    await writeDocumentAtomic({
      path: join(paths.rollupsDailyDir, '2026-08-10.md'),
      meta: { id: newId('doc'), date: '2026-08-10' },
      body: 'A steady day.\n',
    })

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('## Rollups available')
    expect(prompt).toContain('2026-W33 (')
    expect(prompt).toContain('12 shown, 15 exist')
    expect(prompt).toContain('running back to 2026-W19.')
    expect(prompt).toContain('Daily rollups: 1 day covered')
    // The three oldest weeks are beyond the twelve-week index and appear
    // only in the count-and-range line, never as listable keys.
    expect(prompt).not.toContain('2026-W19 (')
    // Content is never preloaded.
    expect(prompt).not.toContain('Week 33 content')

    // Every listed docId appears in the prompt and resolves through
    // read_document.
    for (const id of ids.slice(ids.length - 12)) {
      expect(prompt).toContain(id)
      const doc = await engine.readDocumentById(id)
      expect(doc?.body).toContain('Week')
    }

    await engine.close()
  })

  it('keeps the read_document escape hatch even when the rollup index fills the cap', async () => {
    // The escape-hatch row is what turns a list of docIds into something the
    // model can act on. With a full twelve-week index and more than one daily
    // rollup it is the row the character cap would drop, which would hand the
    // model a shelf and no way to take anything off it.
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_any',
        type: 'arc',
        label: 'Any Arc',
      },
    ])

    for (let w = 19; w <= 33; w++) {
      const week = `2026-W${String(w).padStart(2, '0')}`
      await writeDocumentAtomic({
        path: join(paths.rollupsWeeklyDir, `${week}.md`),
        meta: { id: newId('doc'), kind: 'rollup_weekly', week },
        body: `Week ${w} content.\n`,
      })
    }
    for (const date of ['2026-08-09', '2026-08-10']) {
      await writeDocumentAtomic({
        path: join(paths.rollupsDailyDir, `${date}.md`),
        meta: { id: newId('doc'), date },
        body: 'A steady day.\n',
      })
    }

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('Daily rollups: 2 days covered')
    expect(prompt).toContain('Read any of these with read_document')

    await engine.close()
  })
})
