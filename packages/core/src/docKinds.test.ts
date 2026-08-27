import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DOC_KINDS,
  type DocKind,
  documentDateSpan,
  type EngineDeps,
  ensureMemoryTree,
  MemoryEngine,
  type MemoryPaths,
  memoryPaths,
  newId,
  nodeStores,
  SessionStore,
  writeDocumentAtomic,
} from '@openreverie/memory'
import { FakeChatProvider, FakeEmbeddingProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ARCS_SECTION_CAP,
  CONSTITUTION_CAP,
  LATEST_DAILY_ROLLUP_CAP,
  PEOPLE_SECTION_CAP,
  REALMS_SECTION_CAP,
  RECENT_SUMMARIES_SECTION_CAP,
  ROLLUPS_AVAILABLE_CAP,
  SECTION_CAPS,
} from './budget.js'
import { toolDefinitions } from './tools.js'

// Every kind maps to the character cap of the prompt section where it
// appears. Declared as Record<DocKind, number>, so the moment a kind is
// added to DocKind without a cap this stops compiling, and the values are
// asserted below to actually be part of SECTION_CAPS, so a cap that exists
// in name but not in the budget fails too.
const PROMPT_SECTION_CAP: Record<DocKind, number> = {
  constitution: CONSTITUTION_CAP,
  realm: REALMS_SECTION_CAP,
  arc: ARCS_SECTION_CAP,
  summary: RECENT_SUMMARIES_SECTION_CAP,
  rollup_daily: LATEST_DAILY_ROLLUP_CAP,
  rollup_weekly: ROLLUPS_AVAILABLE_CAP,
  person: PEOPLE_SECTION_CAP,
  // journal entries are never injected into the system prompt: they are reached only through
  // search_memory and read_document, by design (journal mode design spec, section 4.4). There
  // is no prompt section for this kind, so no character cap applies.
  journal: 0,
  // journaling.md IS injected (context.ts's journalingProtocolSection), but the design spec
  // (section 4.4) renders it uncapped: no capBody call, no truncation marker, unlike every
  // other injected kind. Deliberate: a short, user-authored preference note, not an
  // accumulating document like the constitution. No character cap applies.
  journaling: 0,
  // dream narratives are never injected into the system prompt: they are written for the
  // person, reached only through search_memory and read_document (dreaming design spec,
  // Surfacing). No prompt section, no character cap.
  dream: 0,
  // dream_insight documents are not injected wholesale either: the dreams prompt section
  // renders selected insights and is capped by DREAM_INSIGHTS_SECTION_CAP in budget.ts.
  dream_insight: 0,
}

function fakeDeps(): EngineDeps {
  return {
    chat: new FakeChatProvider([]),
    embeddings: new FakeEmbeddingProvider(),
    reflectionModel: 'fake-reflect',
    embeddingModel: 'fake-embed',
    timezone: 'UTC',
  }
}

describe('DocKind wiring (P8)', () => {
  it('lists every DocKind in the search_memory kinds description', () => {
    const defs = toolDefinitions()
    const search = defs.find((d) => d.name === 'search_memory')
    if (!search) throw new Error('expected a search_memory tool definition')
    const description = (search.parameters as { properties: { kinds: { description: string } } })
      .properties.kinds.description
    for (const kind of DOC_KINDS) {
      expect(description).toContain(kind)
    }
  })

  it('documentDateSpan returns a span or null, never undefined, for every kind', () => {
    for (const kind of DOC_KINDS) {
      expect(documentDateSpan(kind, { id: 'doc_x' })).not.toBeUndefined()
    }
  })

  it('every kind has a positive prompt cap that is part of the budget, except kinds declared prompt-exempt', () => {
    const PROMPT_EXEMPT_KINDS: DocKind[] = ['journal', 'journaling', 'dream', 'dream_insight']
    for (const kind of DOC_KINDS) {
      const cap = PROMPT_SECTION_CAP[kind]
      if (PROMPT_EXEMPT_KINDS.includes(kind)) {
        expect(cap).toBe(0)
        continue
      }
      expect(cap).toBeGreaterThan(0)
      expect(SECTION_CAPS).toContain(cap)
    }
  })
})

describe('DocKind indexing and web API wiring', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-doc-kinds-'))
    paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('walks and serves every kind through the public document API', async () => {
    const seeded: { kind: DocKind; docId: string }[] = []

    const constitutionId = newId('doc')
    await writeDocumentAtomic(paths.files, {
      path: paths.constitution,
      meta: { id: constitutionId },
      body: 'The constitution body.\n',
    })
    seeded.push({ kind: 'constitution', docId: constitutionId })

    const realmId = newId('doc')
    await writeDocumentAtomic(paths.files, {
      path: join(paths.realmsDir, 'fitness.md'),
      meta: { id: realmId, name: 'Fitness' },
      body: 'Running and lifting.\n',
    })
    seeded.push({ kind: 'realm', docId: realmId })

    const arcId = newId('doc')
    await writeDocumentAtomic(paths.files, {
      path: join(paths.arcsDir, 'marathon.md'),
      meta: { id: arcId, name: 'Marathon', status: 'active' },
      body: 'Training for the fall marathon.\n',
    })
    seeded.push({ kind: 'arc', docId: arcId })

    const personId = newId('doc')
    await writeDocumentAtomic(paths.files, {
      path: join(paths.peopleDir, 'priya.md'),
      meta: { id: personId, name: 'Priya' },
      body: 'Priya runs the reading group.\n',
    })
    seeded.push({ kind: 'person', docId: personId })

    const dailyId = newId('doc')
    await writeDocumentAtomic(paths.files, {
      path: join(paths.rollupsDailyDir, '2026-08-10.md'),
      meta: { id: dailyId, date: '2026-08-10' },
      body: 'A steady day.\n',
    })
    seeded.push({ kind: 'rollup_daily', docId: dailyId })

    const weeklyId = newId('doc')
    await writeDocumentAtomic(paths.files, {
      path: join(paths.rollupsWeeklyDir, '2026-W33.md'),
      meta: { id: weeklyId, week: '2026-W33' },
      body: 'The week in brief.\n',
    })
    seeded.push({ kind: 'rollup_weekly', docId: weeklyId })

    const store = await SessionStore.start(paths, new Date('2026-08-10T00:00:00.000Z'))
    const summaryId = newId('doc')
    await writeDocumentAtomic(paths.files, {
      path: join(store.dir, 'summary.md'),
      meta: { id: summaryId },
      body: 'A session summary.\n',
    })
    seeded.push({ kind: 'summary', docId: summaryId })

    const journalEntryId = newId('doc')
    await writeDocumentAtomic(paths.files, {
      path: join(paths.journalDir, `2026-08-10-${journalEntryId}.md`),
      meta: {
        id: journalEntryId,
        method: 'examen',
        entryDate: '2026-08-10',
        recordedAt: '2026-08-10T21:00:00.000Z',
      },
      body: 'A journal entry body.\n',
    })
    seeded.push({ kind: 'journal', docId: journalEntryId })

    const journalingId = newId('doc')
    await writeDocumentAtomic(paths.files, {
      path: paths.journaling,
      meta: { id: journalingId },
      body: 'Once a week, gratitude journaling, hang back.\n',
    })
    seeded.push({ kind: 'journaling', docId: journalingId })

    const dreamDir = join(paths.dreamsDir, '2026-08-24-dream_seed')
    await mkdir(dreamDir, { recursive: true })

    const dreamId = newId('doc')
    await writeDocumentAtomic(paths.files, {
      path: join(dreamDir, 'dream.md'),
      meta: { id: dreamId, date: '2026-08-24' },
      body: 'A dream narrative.\n',
    })
    seeded.push({ kind: 'dream', docId: dreamId })

    const dreamInsightId = newId('doc')
    await writeDocumentAtomic(paths.files, {
      path: join(dreamDir, 'insight.md'),
      meta: { id: dreamInsightId, date: '2026-08-24' },
      body: 'A dream insight.\n',
    })
    seeded.push({ kind: 'dream_insight', docId: dreamInsightId })

    expect(seeded.map((s) => s.kind).sort()).toEqual([...DOC_KINDS].sort())

    const engine = await MemoryEngine.open(dir, fakeDeps(), { maintenance: false })

    const rows = await engine.listPublicDocuments()
    const byDocId = new Map(rows.map((row) => [row.docId, row]))
    for (const { kind, docId } of seeded) {
      expect(byDocId.get(docId)?.kind).toBe(kind)
      const full = await engine.getPublicDocument(docId)
      expect(full?.kind).toBe(kind)
      expect(full?.body.length).toBeGreaterThan(0)
    }

    await engine.close()
  })
})
