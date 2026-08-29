import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  type EmbeddingProvider,
  type EmbedResult,
  FakeChatProvider,
  FakeEmbeddingProvider,
} from '@openreverie/providers'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordCommitment, resolveCommitment } from './commitments.js'
import { listDocuments, newId, readDocument, writeDocumentAtomic } from './documents.js'
import { type EngineDeps, MemoryEngine } from './engine.js'
import { appendGraph, readGraph } from './graph.js'
import { memoryStores } from './memoryStore.js'
import { nodeStores } from './nodeStore.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'
import { loadProfile, writeProfile } from './profile.js'
import { appendProposals, type Proposal, pendingProposals } from './proposals.js'
import { applyReflection, type ReflectionItem, type ReflectionOutput } from './reflection.js'
import { appendReflectionLog, readReflectionLog } from './reflectionLog.js'
import { buildDailyRollup } from './rollups.js'
import { MemoryIndex } from './sqlite.js'
import type { AppendOnlyStore } from './store.js'
import { formatLocalDate } from './time.js'
import { SessionStore } from './transcripts.js'

async function rmWithRetry(path: string, attempts = 3, delayMs = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (err) {
      if (i === attempts - 1) throw err
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

describe('rmWithRetry', () => {
  it('retries after ENOTEMPTY and eventually succeeds', async () => {
    let calls = 0
    const original = rm
    const fakeRm = vi.fn(async (path: string, options: unknown) => {
      calls += 1
      if (calls < 3) {
        const err = new Error('ENOTEMPTY: directory not empty') as NodeJS.ErrnoException
        err.code = 'ENOTEMPTY'
        throw err
      }
      return original(path, options as never)
    })
    // This test exercises the retry loop's own logic directly against a
    // fake, not against the real rm re-imported under a different name,
    // since engine.test.ts already imports rm from node:fs/promises at
    // module scope; redefine a local retry loop bound to the fake here so
    // the assertion is about the algorithm, not about patching a live
    // binding mid-file.
    async function retryWithFake(path: string, attempts = 3, delayMs = 1): Promise<void> {
      for (let i = 0; i < attempts; i++) {
        try {
          await fakeRm(path, { recursive: true, force: true })
          return
        } catch (err) {
          if (i === attempts - 1) throw err
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
      }
    }

    await retryWithFake('/fake/path', 3, 1)

    expect(calls).toBe(3)
  })

  it('re-throws after exhausting every attempt instead of swallowing a persistent failure', async () => {
    let calls = 0
    const fakeRm = vi.fn(async (_path: string, _options: unknown) => {
      calls += 1
      const err = new Error('ENOTEMPTY: directory not empty') as NodeJS.ErrnoException
      err.code = 'ENOTEMPTY'
      throw err
    })
    async function retryWithFake(path: string, attempts = 3, delayMs = 1): Promise<void> {
      for (let i = 0; i < attempts; i++) {
        try {
          await fakeRm(path, { recursive: true, force: true })
          return
        } catch (err) {
          if (i === attempts - 1) throw err
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
      }
    }

    await expect(retryWithFake('/fake/path', 3, 1)).rejects.toThrow('ENOTEMPTY')
    expect(calls).toBe(3)
  })
})

const execFileAsync = promisify(execFile)

async function pinTimezoneUtc(paths: MemoryPaths): Promise<void> {
  const profile = await loadProfile(paths, 'UTC')
  await writeProfile(paths, {
    meta: { ...profile.meta, timezone: 'UTC', timezoneSource: 'user-confirmed' },
    body: profile.body,
  })
}

function emptyReflectionOutput(summary: string): ReflectionOutput {
  return {
    summary,
    items: [],
    attributions: [],
    newArcs: [],
    newPersons: [],
    newEntities: [],
    pagePromotions: [],
    arcUpdates: [],
    personUpdates: [],
    constitutionUpdate: null,
    journalingUpdate: null,
  }
}

function fakeDeps(chat: FakeChatProvider): EngineDeps {
  return {
    chat,
    embeddings: new FakeEmbeddingProvider(),
    reflectionModel: 'fake-reflect',
    embeddingModel: 'fake-embed',
    timezone: 'UTC',
  }
}

// An EmbeddingProvider that always fails, used to prove that a document's
// caller (e.g. createPersonPage) survives an indexing failure instead of
// throwing out of it, the same guarantee reindexOrWarn gives every other
// caller.
class ThrowingEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'throwing'

  async embed(_model: string, _texts: string[]): Promise<EmbedResult> {
    throw new Error('embeddings unavailable')
  }
}

describe('MemoryEngine.open timezone validation', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-timezone-'))
  })

  afterEach(async () => {
    await rmWithRetry(dir)
  })

  // The self-hosted path always passes systemTimeZone(), which is never
  // empty, but the check has to exist for the hosted caller P0-3 was built
  // for regardless, and this proves open() itself rejects a malformed
  // deps.timezone rather than letting it reach Intl deep inside
  // ensureMemoryTree or startSession.
  it('rejects a deps.timezone that is not a recognized IANA zone', async () => {
    await expect(
      MemoryEngine.open(
        dir,
        { ...fakeDeps(new FakeChatProvider([])), timezone: 'Not/AZone' },
        { maintenance: false },
      ),
    ).rejects.toThrow('deps.timezone is not a valid IANA timezone')
  })

  // Named separately from the malformed-string case above on purpose: this
  // project has a recorded incident (AGENTS.md, 2026-08-24) of a guard
  // whose tests covered a field being ABSENT but never PRESENT AND EMPTY.
  // isValidIanaTimeZone already treats '' as invalid, but that behavior is
  // only real if something here exercises it against this exact call path.
  it('rejects an empty-string deps.timezone', async () => {
    await expect(
      MemoryEngine.open(
        dir,
        { ...fakeDeps(new FakeChatProvider([])), timezone: '' },
        { maintenance: false },
      ),
    ).rejects.toThrow('deps.timezone is not a valid IANA timezone')
  })
})

describe('MemoryEngine', () => {
  describe('public read projections', () => {
    let dir: string
    let paths: MemoryPaths
    let personPageId: string

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-public-projections-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
      personPageId = newId('doc')
      const personPagePath = join(paths.peopleDir, 'mina.md')
      await writeDocumentAtomic(paths.files, {
        path: personPagePath,
        meta: { id: personPageId, name: 'Mina', updated: '2026-08-14T12:00:00.000Z' },
        body: 'Mina is a person in this fixture.\n',
      })
      await appendGraph(paths, [
        {
          ts: '2026-08-14T10:00:00.000Z',
          op: 'assert',
          node: 'person_no_page',
          type: 'person',
          label: 'Noor',
        },
        {
          ts: '2026-08-14T11:00:00.000Z',
          op: 'assert',
          node: 'person_with_page',
          type: 'person',
          label: 'Mina',
          doc: personPagePath,
        },
      ])
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    it('projects node-only people and document-backed people without exposing paths', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
        maintenance: false,
      })
      const rows = await engine.listPublicDocuments()

      expect(rows.every((row) => !('path' in row))).toBe(true)
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            docId: personPageId,
            kind: 'person',
            title: 'Mina',
            readOnly: true,
          }),
        ]),
      )
      expect(engine.graphSnapshot().nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'person_no_page', type: 'person', label: 'Noor' }),
          expect.objectContaining({ id: 'person_with_page', docId: personPageId }),
        ]),
      )

      await engine.close()
    })

    it('retains every raw graph operation with its one-based append sequence', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
        maintenance: false,
      })
      const records = await engine.readGraphHistory()

      expect(records).toEqual([
        expect.objectContaining({ sequence: 1 }),
        expect.objectContaining({ sequence: 2 }),
      ])

      await engine.close()
    })

    it('omits active edges whose endpoints are no longer active from the graph snapshot', async () => {
      await appendGraph(paths, [
        {
          ts: '2026-08-14T12:00:00.000Z',
          op: 'assert',
          edge: 'in',
          from: 'person_no_page',
          to: 'missing_realm',
          confidence: 0.7,
          confirmed: false,
        },
      ])
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
        maintenance: false,
      })

      expect(engine.graphSnapshot().edges).toEqual([])

      await engine.close()
    })

    it('does not alter the v0.3.1 SessionContext contract while adding read projections', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
        maintenance: false,
      })

      expect(await engine.sessionContext(new Date('2026-08-15T12:00:00.000Z'))).toMatchObject({
        people: [
          { id: 'person_with_page', name: 'Mina', hasPage: true },
          { id: 'person_no_page', name: 'Noor', hasPage: false },
        ],
        peopleTruncated: false,
        entities: [],
        entitiesTruncated: false,
      })

      await engine.close()
    })

    it('opens provider-free projections without maintenance work when maintenance is false', async () => {
      const session = await SessionStore.start(paths, new Date('2026-08-14T12:00:00.000Z'))
      await session.appendLine(paths, {
        ts: '2026-08-14T12:00:00.000Z',
        role: 'user',
        content: 'This stale session must not be reflected while browsing records.',
      })
      const chat = { name: 'test', complete: vi.fn(), stream: vi.fn() }
      const embeddings = { name: 'test', embed: vi.fn() }

      const engine = await MemoryEngine.open(
        paths.root,
        {
          chat,
          embeddings,
          reflectionModel: 'reflection',
          embeddingModel: 'embeddings',
          timezone: 'UTC',
        },
        { maintenance: false },
      )

      expect(chat.complete).not.toHaveBeenCalled()
      expect(chat.stream).not.toHaveBeenCalled()
      expect(embeddings.embed).not.toHaveBeenCalled()
      expect(await engine.readGraphHistory()).toEqual(expect.any(Array))
      expect(await engine.listPublicDocuments()).toEqual(expect.any(Array))
      expect(await engine.listStoredSessions()).toEqual(expect.any(Array))

      await engine.close()
    })

    it('listStoredSessions reports open for an unreflected session and ended for a reflected one, read-only either way', async () => {
      const unreflected = await SessionStore.start(paths, new Date('2026-08-14T12:00:00.000Z'))
      await unreflected.appendLine(paths, {
        ts: '2026-08-14T12:00:00.000Z',
        role: 'user',
        content: 'Interrupted before reflection ran.',
      })

      const reflected = await SessionStore.start(paths, new Date('2026-08-14T13:00:00.000Z'))
      await reflected.appendLine(paths, {
        ts: '2026-08-14T13:00:00.000Z',
        role: 'user',
        content: 'Reflected on directly.',
      })
      await applyReflection(
        paths,
        emptyReflectionOutput('Reflected already.'),
        reflected.sessionId,
        [],
        new Date('2026-08-14T13:00:00.000Z'),
        new Map(),
        async () => {},
        'UTC',
      )

      // maintenance: false, the same way the probe that found this bug did,
      // so nothing here auto-reflects the unreflected session.
      const engine = await MemoryEngine.open(paths.root, fakeDeps(new FakeChatProvider([])), {
        maintenance: false,
      })

      const sessions = await engine.listStoredSessions()
      expect(sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: unreflected.sessionId,
            status: 'open',
            readOnly: true,
          }),
          expect.objectContaining({
            sessionId: reflected.sessionId,
            status: 'ended',
            readOnly: true,
          }),
        ]),
      )

      await engine.close()
    })
  })

  describe('full session lifecycle', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-'))
      paths = memoryPaths(dir, nodeStores())
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    it('captures a session, reflects it, and produces a rebuildable, searchable index with git history', async () => {
      // Pre-seed an arc and its realm so the scripted reflection can
      // attribute an item to it with high confidence.
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
      const arcDocId = newId('doc')
      const arcDocPath = join(paths.arcsDir, 'health.md')
      await writeDocumentAtomic(paths.files, {
        path: arcDocPath,
        meta: { id: arcDocId, name: 'Health', status: 'active' },
        body: 'Original arc narrative.\n',
      })
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'arc_health',
          type: 'arc',
          label: 'Health',
          doc: arcDocPath,
        },
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'realm_health',
          type: 'realm',
          label: 'Health',
        },
      ])

      const scriptedReflection: ReflectionOutput = {
        summary: 'Talked about a morning run and anxiety about a big presentation.',
        items: [
          { text: 'Went for a long run', kind: 'event' },
          { text: 'Feeling anxious about a big presentation', kind: 'feeling' },
        ],
        attributions: [{ itemIndex: 0, arcId: 'arc_health', confidence: 0.92 }],
        newArcs: [
          {
            name: 'presentation prep',
            realm: 'realm_health',
            reason: 'mentioned a big presentation looming',
            itemIndexes: [1],
            narrative: 'Presentation prep starts here.',
          },
        ],
        newPersons: [],
        newEntities: [],
        pagePromotions: [],
        arcUpdates: [],
        personUpdates: [],
        constitutionUpdate: null,
        journalingUpdate: null,
      }
      const chat = new FakeChatProvider([
        { text: JSON.stringify(scriptedReflection), toolCalls: [] },
      ])
      const deps = fakeDeps(chat)

      let engine = await MemoryEngine.open(dir, deps)

      const startedAt = new Date()
      const sessionId = await engine.startSession(startedAt)
      await engine.appendTranscript(sessionId, {
        ts: startedAt.toISOString(),
        role: 'user',
        content:
          'I went for a long run this morning and feel anxious about tomorrow’s big presentation.',
      })
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'assistant',
        content: 'That sounds like a lot to carry into one morning.',
      })
      await engine.remember(sessionId, 'Wants to start journaling more consistently')

      const transcriptBefore = await engine.readTranscript(sessionId)
      expect(transcriptBefore).toHaveLength(2)

      await engine.endSession(sessionId)

      // Summary landed on disk as the commit marker for reflection.
      const sessionDir = join(
        paths.sessionsDir,
        `${formatLocalDate(startedAt, engine.timezone())}-${sessionId}`,
      )
      const summaryDoc = await readDocument(paths.files, join(sessionDir, 'summary.md'))
      expect(summaryDoc.body).toBe(`${scriptedReflection.summary}\n`)
      const items = summaryDoc.meta.items as ReflectionItem[]
      // The two reflected items plus the live-captured journaling item.
      expect(items).toHaveLength(3)
      const runItem = items.find((i) => i.text === 'Went for a long run')
      const anxiousItem = items.find((i) => i.text === 'Feeling anxious about a big presentation')
      if (!runItem || !anxiousItem) throw new Error('expected minted items')

      // Graph: high-confidence attribution asserted immediately, unconfirmed.
      const graph = await readGraph(paths)
      expect(graph.edges.get(`part_of:${runItem.id}:arc_health`)).toMatchObject({
        confidence: 0.92,
        confirmed: false,
      })

      // The new arc is materialized directly by reflection, with no proposal.
      const pending = await pendingProposals(paths)
      expect(pending.find((p) => p.kind === 'new_arc')).toBeUndefined()
      const newArc = (await engine.listArcs()).rows.find((n) => n.label === 'presentation prep')
      if (!newArc?.docId) throw new Error('expected the new arc to have a docId')
      expect(await engine.readDocumentById(newArc.docId)).toMatchObject({
        body: 'Presentation prep starts here.\n',
      })
      // Direct materialization from reflection: nobody affirmed this arc,
      // so confirmed is false, unlike an accepted proposal's confirmed: true.
      expect(graph.edges.get(`part_of:${anxiousItem.id}:${newArc.id}`)).toMatchObject({
        confidence: 1,
        confirmed: false,
      })
      expect((await engine.listArcs()).total).toBe(2)
      expect(engine.listRealms().total).toBe(1)

      // graphQuery surfaces the item filed under the pre-existing arc.
      const arcItems = engine.graphQuery({ kind: 'items_in_arc', arcId: 'arc_health' })
      expect(arcItems).toHaveLength(1)

      // The session node is asserted alongside its items, so the item's
      // from-edge to the session actually materializes in the index
      // instead of dangling on a missing endpoint.
      const runItemNeighbors = engine.graphQuery({ kind: 'neighbors', nodeId: runItem.id }) as {
        edge: { edge: string }
        node: { id: string; type: string }
      }[]
      expect(runItemNeighbors.some((n) => n.edge.edge === 'from' && n.node.id === sessionId)).toBe(
        true,
      )

      // readDocumentById resolves through the engine's document cache.
      const byId = await engine.readDocumentById(summaryDoc.meta.id as string)
      expect(byId?.path).toBe(join(sessionDir, 'summary.md'))

      // Search finds the reflected item text.
      const hits = (await engine.search('anxious')).documents
      expect(hits.length).toBeGreaterThan(0)

      // Prove index.db is fully rebuildable from the folder: delete it,
      // reopen (which does not itself reindex documents), confirm the
      // index really is empty, then reindexAll and confirm search works
      // again.
      await engine.close()
      await rm(paths.indexDb)

      engine = await MemoryEngine.open(dir, deps)
      const hitsBeforeRebuild = await engine.search('anxious')
      expect(hitsBeforeRebuild.documents).toEqual([])

      await engine.reindexAll()
      const hitsAfterRebuild = (await engine.search('anxious')).documents
      expect(hitsAfterRebuild.length).toBeGreaterThan(0)

      await engine.close()

      const log = await execFileAsync('git', ['-C', dir, 'log', '--oneline'])
      const commitLines = log.stdout.trim().split('\n').filter(Boolean)
      expect(commitLines.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('session resume support', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-resume-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    describe('listStoredSessions resumable', () => {
      it('reports resumable true for an open session and false for a reflected one', async () => {
        const chat = new FakeChatProvider([])
        const engine = await MemoryEngine.open(dir, fakeDeps(chat), { maintenance: false })

        const openSessionId = await engine.startSession()
        await engine.appendTranscript(openSessionId, {
          ts: new Date().toISOString(),
          role: 'user',
          content: 'Never reflected.',
        })

        const reflectedSessionId = await engine.startSession()
        await engine.appendTranscript(reflectedSessionId, {
          ts: new Date().toISOString(),
          role: 'user',
          content: 'Reflected already.',
        })
        await applyReflection(
          paths,
          emptyReflectionOutput('Reflected already.'),
          reflectedSessionId,
          [],
          new Date(),
          new Map(),
          async () => {},
          'UTC',
        )

        const sessions = await engine.listStoredSessions()
        const open = sessions.find((s) => s.sessionId === openSessionId)
        const reflected = sessions.find((s) => s.sessionId === reflectedSessionId)
        expect(open?.status).toBe('open')
        expect(open?.resumable).toBe(true)
        expect(reflected?.status).toBe('ended')
        expect(reflected?.resumable).toBe(false)

        await engine.close()
      })
    })

    describe('storedSessionExists', () => {
      it('reports true for a session started in this process', async () => {
        const chat = new FakeChatProvider([])
        const engine = await MemoryEngine.open(dir, fakeDeps(chat), { maintenance: false })
        const sessionId = await engine.startSession()
        expect(await engine.storedSessionExists(sessionId)).toBe(true)
        await engine.close()
      })

      it('reports false for an id nothing on disk matches', async () => {
        const chat = new FakeChatProvider([])
        const engine = await MemoryEngine.open(dir, fakeDeps(chat), { maintenance: false })
        expect(await engine.storedSessionExists('session_does_not_exist')).toBe(false)
        await engine.close()
      })
    })

    describe('persisted system prompt', () => {
      it('round-trips through the engine', async () => {
        const chat = new FakeChatProvider([])
        const engine = await MemoryEngine.open(dir, fakeDeps(chat), { maintenance: false })
        const sessionId = await engine.startSession()
        await engine.writeSessionSystemPrompt(sessionId, 'You are reverie.')
        expect(await engine.readSessionSystemPrompt(sessionId)).toBe('You are reverie.')
        await engine.close()
      })

      it('reports undefined when nothing was ever persisted', async () => {
        const chat = new FakeChatProvider([])
        const engine = await MemoryEngine.open(dir, fakeDeps(chat), { maintenance: false })
        const sessionId = await engine.startSession()
        expect(await engine.readSessionSystemPrompt(sessionId)).toBeUndefined()
        await engine.close()
      })
    })

    describe('restoreLiveItems', () => {
      it('replays items into a reflected summary with each item keeping its own ts', async () => {
        const chat = new FakeChatProvider([
          { text: JSON.stringify(emptyReflectionOutput('A quiet check-in.')), toolCalls: [] },
        ])
        const engine = await MemoryEngine.open(dir, fakeDeps(chat), { maintenance: false })
        const startedAt = new Date('2026-08-20T09:00:00.000Z')
        const sessionId = await engine.startSession(startedAt)
        await engine.appendTranscript(sessionId, {
          ts: startedAt.toISOString(),
          role: 'user',
          content: 'Watching Halcyon tonight.',
        })

        const restoredTs = '2026-08-20T09:00:05.000Z'
        engine.restoreLiveItems(sessionId, [
          { text: 'Watching Halcyon tonight', kind: 'intention', ts: restoredTs },
        ])

        await engine.endSession(sessionId)

        const summaryPath = join(
          paths.sessionsDir,
          `${formatLocalDate(startedAt, engine.timezone())}-${sessionId}`,
          'summary.md',
        )
        const summaryDoc = await readDocument(paths.files, summaryPath)
        const items = summaryDoc.meta.items as { text: string; ts: string }[]
        const item = items.find((i) => i.text === 'Watching Halcyon tonight')
        expect(item).toBeDefined()
        // The restore clock (startedAt above) is deliberately not the ts
        // handed to restoreLiveItems: proves the item's own ts survives
        // rather than being overwritten by the moment restore ran.
        expect(item?.ts).toBe(restoredTs)

        await engine.close()
      })

      it('is safe to call with an empty array on an unreflected session', async () => {
        const chat = new FakeChatProvider([])
        const engine = await MemoryEngine.open(dir, fakeDeps(chat), { maintenance: false })
        const sessionId = await engine.startSession()
        expect(() => engine.restoreLiveItems(sessionId, [])).not.toThrow()
        await engine.close()
      })
    })
  })

  describe('runMaintenance', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-maint-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    it('retries a stale unreflected session and writes a daily rollup for a completed, unreflected-free day', async () => {
      const now = new Date()
      const twoDaysAgo = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2),
      )
      const yesterday = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
      )

      // A session from two days ago that crashed before reflection ran:
      // transcript on disk, no summary.md.
      const staleStore = await SessionStore.start(paths, twoDaysAgo)
      await staleStore.appendLine(paths, {
        ts: twoDaysAgo.toISOString(),
        role: 'user',
        content: 'A stale session about work stress that never got reflected.',
      })

      // Yesterday: already reflected (has a summary), but no daily rollup
      // has been built for that date yet.
      const yesterdayStore = await SessionStore.start(paths, yesterday)
      await yesterdayStore.appendLine(paths, {
        ts: yesterday.toISOString(),
        role: 'user',
        content: 'A quiet evening, already reflected on directly.',
      })
      await applyReflection(
        paths,
        emptyReflectionOutput('A quiet evening.'),
        yesterdayStore.sessionId,
        [],
        yesterday,
        new Map(),
        async () => {},
        'UTC',
      )

      // Enough scripted replies for: the stale session's reflection call,
      // a daily rollup for each of the two dates, and a couple of spare
      // entries in case today's weekday pushes one of those dates into a
      // still-pending previous ISO week (an extra weekly rollup call).
      // Extra scripted entries are harmless: they are simply never drawn.
      const chat = new FakeChatProvider([
        {
          text: JSON.stringify(emptyReflectionOutput('Stale session, reflected late.')),
          toolCalls: [],
        },
        { text: 'Daily rollup prose for the stale date.', toolCalls: [] },
        { text: 'Daily rollup prose for yesterday.', toolCalls: [] },
        { text: 'Weekly rollup prose, spare.', toolCalls: [] },
        { text: 'Weekly rollup prose, spare two.', toolCalls: [] },
      ])
      const deps = fakeDeps(chat)

      const engine = await MemoryEngine.open(dir, deps)

      const staleDate = formatLocalDate(twoDaysAgo, 'UTC')
      const staleSummary = await readDocument(
        paths.files,
        join(paths.sessionsDir, `${staleDate}-${staleStore.sessionId}`, 'summary.md'),
      )
      expect(staleSummary.body.length).toBeGreaterThan(0)

      const staleDaily = await readDocument(
        paths.files,
        join(paths.rollupsDailyDir, `${staleDate}.md`),
      )
      expect(staleDaily.body.length).toBeGreaterThan(0)

      const yesterdayDate = formatLocalDate(yesterday, 'UTC')
      const yesterdayDaily = await readDocument(
        paths.files,
        join(paths.rollupsDailyDir, `${yesterdayDate}.md`),
      )
      expect(yesterdayDaily.body.length).toBeGreaterThan(0)

      await engine.close()
    })

    it('does not build a daily rollup for a day whose only session was skipped, and never calls the model', async () => {
      const now = new Date()
      const yesterday = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
      )

      // A greeting-only session from yesterday, never reflected yet: on
      // MemoryEngine.open's own runMaintenance pass, this must be skipped
      // (no reflection call), and yesterday must never be treated as a
      // date with real content to roll up (no daily rollup call either).
      // An empty scripted chat provider means either LLM call would throw
      // "scripted results exhausted", which is exactly what this guards.
      const store = await SessionStore.start(paths, yesterday)
      await store.appendLine(paths, {
        ts: yesterday.toISOString(),
        role: 'assistant',
        content: 'Good to see you.',
      })

      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      expect(chat.requests).toHaveLength(0)

      const yesterdayDate = formatLocalDate(yesterday, 'UTC')
      await expect(
        readDocument(paths.files, join(paths.rollupsDailyDir, `${yesterdayDate}.md`)),
      ).rejects.toThrow()

      const sessions = await SessionStore.listSessions(paths)
      const session = sessions.find((s) => s.sessionId === store.sessionId)
      expect(session?.reflected).toBe(true)
      expect(session?.skipped).toBe(true)

      await engine.close()
    })

    it('with no options still ends an unreflected session, exactly as today', async () => {
      const sessionAt = new Date('2026-08-18T10:00:00.000Z')
      const store = await SessionStore.start(paths, sessionAt)
      await store.appendLine(paths, {
        ts: sessionAt.toISOString(),
        role: 'user',
        content: 'A session about a rough day at work.',
      })

      const chat = new FakeChatProvider([
        {
          text: JSON.stringify(emptyReflectionOutput('A rough day, reflected on.')),
          toolCalls: [],
        },
      ])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat), { maintenance: false })

      // Same day as the session itself, so the session's date is never
      // strictly before "today" and no daily rollup call is also due on
      // this pass: this test is about the session-ending loop alone.
      await engine.runMaintenance(new Date('2026-08-18T20:00:00.000Z'))

      const summary = await readDocument(paths.files, join(store.dir, 'summary.md'))
      expect(summary.body.trim()).toBe('A rough day, reflected on.')

      const records = await readReflectionLog(paths)
      const forThisSession = records.filter((r) => r.session === store.sessionId)
      expect(forThisSession.map((r) => r.type)).toEqual(['attempt', 'outcome'])

      await engine.close()
    })

    it('commits "maintenance: reflect stale sessions and build pending rollups" by default, when the pass writes a rollup after ending a session', async () => {
      // _doEndSession's own commit (inside the loop) already captures the
      // reflected session's summary.md, so a default-path pass with
      // nothing left to commit afterward would leave the last commit
      // message as _doEndSession's own "reflect: session <id>", not
      // runMaintenance's. Giving this pass a rollup to build too, from an
      // already-reflected earlier-day session, means real work happens
      // after the session-ending loop's own commit: that is what makes
      // runMaintenance's own final commit, and its message, the one git
      // log actually shows.
      const priorDayAt = new Date('2026-08-17T10:00:00.000Z')
      const priorDayStore = await SessionStore.start(paths, priorDayAt)
      await priorDayStore.appendLine(paths, {
        ts: priorDayAt.toISOString(),
        role: 'user',
        content: 'A session from the day before, reflected directly.',
      })
      await applyReflection(
        paths,
        emptyReflectionOutput('Reflected directly, the day before.'),
        priorDayStore.sessionId,
        [],
        priorDayAt,
        new Map(),
        async () => {},
        'UTC',
      )

      const sessionAt = new Date('2026-08-18T10:00:00.000Z')
      const store = await SessionStore.start(paths, sessionAt)
      await store.appendLine(paths, {
        ts: sessionAt.toISOString(),
        role: 'user',
        content: 'A session about a rough day at work.',
      })

      const chat = new FakeChatProvider([
        {
          text: JSON.stringify(emptyReflectionOutput('A rough day, reflected on.')),
          toolCalls: [],
        },
        { text: 'Daily rollup prose for the prior day.', toolCalls: [] },
      ])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat), { maintenance: false })

      await engine.runMaintenance(new Date('2026-08-18T20:00:00.000Z'))

      const daily = await readDocument(paths.files, join(paths.rollupsDailyDir, '2026-08-17.md'))
      expect(daily.body.trim()).toBe('Daily rollup prose for the prior day.')

      const { stdout: commitMessage } = await execFileAsync('git', ['log', '-1', '--format=%s'], {
        cwd: dir,
      })
      expect(commitMessage.trim()).toBe(
        'maintenance: reflect stale sessions and build pending rollups',
      )

      await engine.close()
    })

    it('with endSessions: false leaves an unreflected session unreflected: no summary.md, no reflection log record', async () => {
      const sessionAt = new Date('2026-08-18T10:00:00.000Z')
      const store = await SessionStore.start(paths, sessionAt)
      await store.appendLine(paths, {
        ts: sessionAt.toISOString(),
        role: 'user',
        content: 'A session that a host-owned session policy is still in charge of.',
      })

      // Empty scripted chat: any reflection call would throw "scripted
      // results exhausted", which is exactly what proves the loop never ran.
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat), { maintenance: false })

      await engine.runMaintenance(new Date('2026-08-19T00:00:00.000Z'), { endSessions: false })

      expect(chat.requests).toHaveLength(0)

      let readError: NodeJS.ErrnoException | undefined
      try {
        await readDocument(paths.files, join(store.dir, 'summary.md'))
      } catch (err) {
        readError = err as NodeJS.ErrnoException
      }
      expect(readError?.code).toBe('ENOENT')

      const records = await readReflectionLog(paths)
      expect(records.filter((r) => r.session === store.sessionId)).toEqual([])

      await engine.close()
    })

    it('with endSessions: false still builds a pending daily rollup for an already-reflected session', async () => {
      const sessionAt = new Date('2026-08-18T10:00:00.000Z')
      const store = await SessionStore.start(paths, sessionAt)
      await store.appendLine(paths, {
        ts: sessionAt.toISOString(),
        role: 'user',
        content: 'A session reflected directly, outside of runMaintenance.',
      })
      await applyReflection(
        paths,
        emptyReflectionOutput('Reflected directly, before any runMaintenance pass.'),
        store.sessionId,
        [],
        sessionAt,
        new Map(),
        async () => {},
        'UTC',
      )

      const chat = new FakeChatProvider([
        { text: 'Daily rollup prose built with sessions still ending elsewhere.', toolCalls: [] },
      ])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat), { maintenance: false })

      await engine.runMaintenance(new Date('2026-08-19T00:00:00.000Z'), { endSessions: false })

      const daily = await readDocument(paths.files, join(paths.rollupsDailyDir, '2026-08-18.md'))
      expect(daily.body.trim()).toBe(
        'Daily rollup prose built with sessions still ending elsewhere.',
      )

      const { stdout: commitMessage } = await execFileAsync('git', ['log', '-1', '--format=%s'], {
        cwd: dir,
      })
      expect(commitMessage.trim()).toBe('maintenance: build pending rollups')

      await engine.close()
    })

    it('a session reflected on an earlier pass still contributes its date to a rollup built on a later endSessions: false pass', async () => {
      const sessionAt = new Date('2026-08-18T10:00:00.000Z')
      const store = await SessionStore.start(paths, sessionAt)
      await store.appendLine(paths, {
        ts: sessionAt.toISOString(),
        role: 'user',
        content: 'A session reflected on day one, rolled up a day later.',
      })

      const chat = new FakeChatProvider([
        { text: JSON.stringify(emptyReflectionOutput('Reflected on day one.')), toolCalls: [] },
        { text: 'Daily rollup prose, built a day later.', toolCalls: [] },
      ])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat), { maintenance: false })

      // Pass 1, same day as the session: reflects it (default endSessions),
      // but the session's own date is today, so pendingDailyRollups never
      // considers it and no rollup is built yet.
      await engine.runMaintenance(new Date('2026-08-18T20:00:00.000Z'))
      expect(chat.requests).toHaveLength(1)
      let noRollupYetError: NodeJS.ErrnoException | undefined
      try {
        await readDocument(paths.files, join(paths.rollupsDailyDir, '2026-08-18.md'))
      } catch (err) {
        noRollupYetError = err as NodeJS.ErrnoException
      }
      expect(noRollupYetError?.code).toBe('ENOENT')

      // Pass 2, the next day, with endSessions: false: the session-ending
      // loop is skipped entirely, but its date (already reflected on pass 1)
      // is still picked up by the fresh SessionStore.listSessions read below
      // the (skipped) loop, so the rollup gets built.
      await engine.runMaintenance(new Date('2026-08-19T09:00:00.000Z'), { endSessions: false })
      expect(chat.requests).toHaveLength(2)

      const daily = await readDocument(paths.files, join(paths.rollupsDailyDir, '2026-08-18.md'))
      expect(daily.body.trim()).toBe('Daily rollup prose, built a day later.')

      await engine.close()
    })
  })

  describe('empty session skip', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-empty-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    it('skips a session with only an assistant greeting, and never retries it across two runMaintenance calls', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const now = new Date()
      const store = await SessionStore.start(paths, now)
      await store.appendLine(paths, {
        ts: now.toISOString(),
        role: 'assistant',
        content: 'Good to see you.',
      })

      await engine.runMaintenance(now)
      const sessionsAfterFirst = await SessionStore.listSessions(paths)
      expect(sessionsAfterFirst.find((s) => s.sessionId === store.sessionId)?.reflected).toBe(true)
      expect(chat.requests).toHaveLength(0)

      await engine.runMaintenance(now)
      expect(chat.requests).toHaveLength(0)

      const summary = await readDocument(paths.files, join(store.dir, 'summary.md'))
      expect(summary.meta.skipped).toBe(true)
      expect(typeof summary.meta.reason).toBe('string')

      await engine.close()
    })

    it('reflects normally through runMaintenance when the transcript has at least one user line', async () => {
      const chat = new FakeChatProvider([
        { text: JSON.stringify(emptyReflectionOutput('Said hello back.')), toolCalls: [] },
      ])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const now = new Date()
      const store = await SessionStore.start(paths, now)
      await store.appendLine(paths, {
        ts: now.toISOString(),
        role: 'assistant',
        content: 'Good to see you.',
      })
      await store.appendLine(paths, { ts: now.toISOString(), role: 'user', content: 'Hi.' })

      await engine.runMaintenance(now)

      expect(chat.requests).toHaveLength(1)
      const summary = await readDocument(paths.files, join(store.dir, 'summary.md'))
      expect(summary.meta.skipped).toBeUndefined()
      expect(summary.body.trim()).toBe('Said hello back.')

      await engine.close()
    })

    it('never indexes a skipped summary for search, and reindexAll does not reintroduce it', async () => {
      const chat = new FakeChatProvider([])
      let engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const now = new Date()
      const store = await SessionStore.start(paths, now)
      await store.appendLine(paths, {
        ts: now.toISOString(),
        role: 'assistant',
        content: 'Good to see you.',
      })

      await engine.runMaintenance(now)

      const skippedSummary = await readDocument(paths.files, join(store.dir, 'summary.md'))
      const skippedDocId = skippedSummary.meta.id as string

      // The fake embedding provider returns a nonzero, if weak, cosine
      // similarity against anything once there is any content indexed at
      // all (the constitution, at minimum), so a plain "hits is empty"
      // assertion would be testing the fake, not this guarantee. What
      // must hold is that the skipped summary's own document id never
      // shows up among the results, on a query built from its own exact
      // placeholder body text.
      const noSkippedDocId = (hits: { docId: string }[]) =>
        expect(hits.some((h) => h.docId === skippedDocId)).toBe(false)

      const hits = (await engine.search('nothing to reflect on')).documents
      noSkippedDocId(hits)

      // Nor should a full index rebuild reintroduce it: walkAllDocuments
      // (which both reindexAll and the docId cache read from) must skip
      // it exactly the same way the initial write path does.
      await engine.reindexAll()
      noSkippedDocId((await engine.search('nothing to reflect on')).documents)

      // Same guarantee from a truly empty index.db, not just a wipe-and-
      // reinsert on top of an existing one.
      await engine.close()
      await rm(paths.indexDb)
      engine = await MemoryEngine.open(dir, fakeDeps(chat))
      await engine.reindexAll()
      noSkippedDocId((await engine.search('nothing to reflect on')).documents)

      // And the docId cache used by readDocumentById never resolves to
      // it either: it was never added to docPaths/docIdByPath in the
      // first place.
      expect(engine.docIdForPath(skippedSummary.path)).toBeUndefined()

      await engine.close()
    })
  })

  describe('resolveProposal materialization', () => {
    let dir: string
    let paths: MemoryPaths
    let engine: MemoryEngine

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-proposals-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
      engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    })

    afterEach(async () => {
      await engine.close()
      await rmWithRetry(dir)
    })

    it('materializes a new arc together with a brand-new realm, and confirms part_of edges for its items', async () => {
      const itemId = newId('item')
      const proposal: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'new_arc',
        summary: 'Track marathon training as an arc.',
        payload: { name: 'Marathon Training', realm: 'Fitness', itemIds: [itemId] },
        source: 'session_seed',
      }
      await appendProposals(paths, [proposal], 'UTC')

      await engine.resolveProposal(proposal.id, 'accepted')

      const pending = await pendingProposals(paths)
      expect(pending.find((p) => p.id === proposal.id)).toBeUndefined()

      const graph = await readGraph(paths)
      const arcNode = [...graph.nodes.values()].find(
        (n) => n.type === 'arc' && n.label === 'Marathon Training',
      )
      const realmNode = [...graph.nodes.values()].find(
        (n) => n.type === 'realm' && n.label === 'Fitness',
      )
      if (!arcNode || !realmNode) throw new Error('expected arc and realm nodes to be created')

      expect(graph.edges.get(`in:${arcNode.id}:${realmNode.id}`)).toMatchObject({
        confirmed: true,
        confidence: 1,
      })
      expect(graph.edges.get(`part_of:${itemId}:${arcNode.id}`)).toMatchObject({
        confirmed: true,
        confidence: 1,
      })

      if (!arcNode.doc || !realmNode.doc) throw new Error('expected doc paths on both nodes')
      const arcDoc = await readDocument(paths.files, arcNode.doc)
      expect(arcDoc.meta.status).toBe('active')
      expect(arcDoc.meta.realm).toBe(realmNode.id)
      expect(arcDoc.body).toBe('This arc is new. It grows as we talk.\n')

      const realmDoc = await readDocument(paths.files, realmNode.doc)
      expect(realmDoc.body).toBe('This realm is new. It grows as we talk.\n')

      expect((await engine.listArcs()).rows.some((n) => n.id === arcNode.id)).toBe(true)
      expect(engine.listRealms().rows.some((n) => n.id === realmNode.id)).toBe(true)
    })

    it('reuses an existing realm by id and dedupes arc filenames on a name collision', async () => {
      const first: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'new_arc',
        summary: 'first',
        payload: { name: 'Marathon Training', realm: 'Fitness', itemIds: [newId('item')] },
        source: 'session_one',
      }
      await appendProposals(paths, [first], 'UTC')
      await engine.resolveProposal(first.id, 'accepted')

      const graphAfterFirst = await readGraph(paths)
      const realmNode = [...graphAfterFirst.nodes.values()].find(
        (n) => n.type === 'realm' && n.label === 'Fitness',
      )
      if (!realmNode) throw new Error('expected a realm node after the first proposal')

      const second: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'new_arc',
        summary: 'second',
        payload: { name: 'Marathon Training', realm: realmNode.id, itemIds: [newId('item')] },
        source: 'session_two',
      }
      await appendProposals(paths, [second], 'UTC')
      await engine.resolveProposal(second.id, 'accepted')

      const graph = await readGraph(paths)
      const realmNodes = [...graph.nodes.values()].filter(
        (n) => n.type === 'realm' && n.label === 'Fitness',
      )
      expect(realmNodes).toHaveLength(1)

      const arcNodes = [...graph.nodes.values()].filter(
        (n) => n.type === 'arc' && n.label === 'Marathon Training',
      )
      expect(arcNodes).toHaveLength(2)

      const arcDocs = await listDocuments(paths.files, paths.arcsDir)
      const filenames = arcDocs.map((d) => d.path.split('/').pop())
      expect(filenames).toContain('marathon-training.md')
      expect(filenames).toContain('marathon-training-2.md')
    })

    it('resolves a new_arc proposal and keeps its edges even when reindexing the new arc page fails', async () => {
      // Symmetric with 'resolves a new_person proposal and keeps its edges
      // even when reindexing the new page fails' below: swap in an engine
      // backed by an embeddings provider that always throws, so createArc's
      // reindexOrWarn call fails. resolveProposal must still complete: the
      // proposal must clear, the arc and realm nodes and their pages must
      // exist, and the part_of/in edges must be appended, none of which
      // should depend on the arc page ever making it into search.
      await engine.close()
      engine = await MemoryEngine.open(dir, {
        chat: new FakeChatProvider([]),
        embeddings: new ThrowingEmbeddingProvider(),
        reflectionModel: 'fake-reflect',
        embeddingModel: 'fake-embed',
        timezone: 'UTC',
      })

      const itemId = newId('item')
      const proposal: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'new_arc',
        summary: 'Track marathon training as an arc.',
        payload: { name: 'Marathon Training', realm: 'Fitness', itemIds: [itemId] },
        source: 'session_seed',
      }
      await appendProposals(paths, [proposal], 'UTC')

      await expect(engine.resolveProposal(proposal.id, 'accepted')).resolves.toBeUndefined()

      const pending = await pendingProposals(paths)
      expect(pending.find((p) => p.id === proposal.id)).toBeUndefined()

      const graph = await readGraph(paths)
      const arcNode = [...graph.nodes.values()].find(
        (n) => n.type === 'arc' && n.label === 'Marathon Training',
      )
      const realmNode = [...graph.nodes.values()].find(
        (n) => n.type === 'realm' && n.label === 'Fitness',
      )
      if (!arcNode || !realmNode) throw new Error('expected arc and realm nodes to be created')
      if (!arcNode.doc) throw new Error('expected the arc node to carry a doc pointer')

      expect(graph.edges.get(`in:${arcNode.id}:${realmNode.id}`)).toMatchObject({
        confirmed: true,
        confidence: 1,
      })
      expect(graph.edges.get(`part_of:${itemId}:${arcNode.id}`)).toMatchObject({
        confirmed: true,
        confidence: 1,
      })

      const arcDoc = await readDocument(paths.files, arcNode.doc)
      expect(arcDoc.body).toBe('This arc is new. It grows as we talk.\n')
    })

    it('materializes a new person as a page with a doc pointer set on the node', async () => {
      const itemId = newId('item')
      const proposal: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'new_person',
        summary: 'Add Sam as someone in your life.',
        payload: { name: 'Sam', itemIds: [itemId] },
        source: 'session_seed',
      }
      await appendProposals(paths, [proposal], 'UTC')

      await engine.resolveProposal(proposal.id, 'accepted')

      const pending = await pendingProposals(paths)
      expect(pending.find((p) => p.id === proposal.id)).toBeUndefined()

      const graph = await readGraph(paths)
      const personNode = [...graph.nodes.values()].find(
        (n) => n.type === 'person' && n.label === 'Sam',
      )
      if (!personNode) throw new Error('expected a person node to be created')
      if (!personNode.doc) throw new Error('expected the person node to carry a doc pointer')

      expect(graph.edges.get(`involves:${itemId}:${personNode.id}`)).toMatchObject({
        confirmed: true,
        confidence: 1,
      })

      const personDoc = await readDocument(paths.files, personNode.doc)
      expect(personDoc.path).toBe(join(paths.peopleDir, 'sam.md'))
      expect(personDoc.meta.name).toBe('Sam')
      expect(personDoc.meta.node).toBe(personNode.id)
      expect(typeof personDoc.meta.opened).toBe('string')
      expect(personDoc.body).toBe('This page is new. It grows as we talk.\n')

      const hits = (await engine.search('grows as we talk')).documents
      expect(hits.some((h) => h.docId === personDoc.meta.id)).toBe(true)
    })

    it('resolves a new_person proposal and keeps its edges even when reindexing the new page fails', async () => {
      // Swap in an engine backed by an embeddings provider that always
      // throws, so createPersonPage's reindex call fails. resolveProposal
      // must still complete: the proposal must clear, the person node and
      // page must exist, and the involves edges must be appended, none of
      // which should depend on the page ever making it into search.
      await engine.close()
      engine = await MemoryEngine.open(dir, {
        chat: new FakeChatProvider([]),
        embeddings: new ThrowingEmbeddingProvider(),
        reflectionModel: 'fake-reflect',
        embeddingModel: 'fake-embed',
        timezone: 'UTC',
      })

      const itemId = newId('item')
      const proposal: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'new_person',
        summary: 'Add Sam as someone in your life.',
        payload: { name: 'Sam', itemIds: [itemId] },
        source: 'session_seed',
      }
      await appendProposals(paths, [proposal], 'UTC')

      await expect(engine.resolveProposal(proposal.id, 'accepted')).resolves.toBeUndefined()

      const pending = await pendingProposals(paths)
      expect(pending.find((p) => p.id === proposal.id)).toBeUndefined()

      const graph = await readGraph(paths)
      const personNodes = [...graph.nodes.values()].filter(
        (n) => n.type === 'person' && n.label === 'Sam',
      )
      expect(personNodes).toHaveLength(1)
      const personNode = personNodes[0]
      if (!personNode) throw new Error('expected a person node to be created')
      if (!personNode.doc) throw new Error('expected the person node to carry a doc pointer')

      expect(graph.edges.get(`involves:${itemId}:${personNode.id}`)).toMatchObject({
        confirmed: true,
        confidence: 1,
      })

      const personDoc = await readDocument(paths.files, personNode.doc)
      expect(personDoc.body).toBe('This page is new. It grows as we talk.\n')
    })

    it('gives two same-named people distinct pages instead of overwriting the first', async () => {
      const firstItemId = newId('item')
      const first: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'new_person',
        summary: 'Add Sam as someone in your life.',
        payload: { name: 'Sam', itemIds: [firstItemId] },
        source: 'session_one',
      }
      await appendProposals(paths, [first], 'UTC')
      await engine.resolveProposal(first.id, 'accepted')

      const secondItemId = newId('item')
      const second: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'new_person',
        summary: 'Add another Sam as someone in your life.',
        payload: { name: 'Sam', itemIds: [secondItemId] },
        source: 'session_two',
      }
      await appendProposals(paths, [second], 'UTC')
      await engine.resolveProposal(second.id, 'accepted')

      const graph = await readGraph(paths)
      const personNodes = [...graph.nodes.values()].filter(
        (n) => n.type === 'person' && n.label === 'Sam',
      )
      expect(personNodes).toHaveLength(2)

      const [firstNode, secondNode] = personNodes
      if (!firstNode?.doc || !secondNode?.doc) {
        throw new Error('expected both person nodes to carry distinct doc pointers')
      }
      expect(firstNode.doc).not.toBe(secondNode.doc)

      const firstDoc = await readDocument(paths.files, firstNode.doc)
      const secondDoc = await readDocument(paths.files, secondNode.doc)
      expect(firstDoc.path).toBe(join(paths.peopleDir, 'sam.md'))
      expect(secondDoc.path).toBe(join(paths.peopleDir, 'sam-2.md'))
      expect(firstDoc.body).toBe('This page is new. It grows as we talk.\n')
      expect(secondDoc.body).toBe('This page is new. It grows as we talk.\n')
    })

    it('materializes a link proposal as a confirmed edge carrying its own confidence', async () => {
      const fromId = newId('item')
      const toId = newId('arc')
      await appendGraph(paths, [
        {
          ts: new Date().toISOString(),
          op: 'assert',
          node: toId,
          type: 'arc',
          label: 'Existing Arc',
        },
      ])

      const proposal: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'link',
        summary: 'Link this item to the existing arc.',
        payload: { edge: 'part_of', from: fromId, to: toId, confidence: 0.42 },
        source: 'session_seed',
      }
      await appendProposals(paths, [proposal], 'UTC')

      await engine.resolveProposal(proposal.id, 'accepted')

      const graph = await readGraph(paths)
      expect(graph.edges.get(`part_of:${fromId}:${toId}`)).toMatchObject({
        confirmed: true,
        confidence: 0.42,
      })

      const pending = await pendingProposals(paths)
      expect(pending.find((p) => p.id === proposal.id)).toBeUndefined()
    })

    it('rejecting a proposal only records the resolution and creates nothing', async () => {
      const proposal: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'new_arc',
        summary: 'A proposal nobody wants.',
        payload: { name: 'Ghost Arc', realm: 'Ghost Realm', itemIds: [newId('item')] },
        source: 'session_seed',
      }
      await appendProposals(paths, [proposal], 'UTC')

      await engine.resolveProposal(proposal.id, 'rejected')

      const pending = await pendingProposals(paths)
      expect(pending.find((p) => p.id === proposal.id)).toBeUndefined()

      const graph = await readGraph(paths)
      expect([...graph.nodes.values()].some((n) => n.label === 'Ghost Arc')).toBe(false)
      expect([...graph.nodes.values()].some((n) => n.label === 'Ghost Realm')).toBe(false)

      const arcDocs = await listDocuments(paths.files, paths.arcsDir)
      expect(arcDocs.some((d) => d.meta.name === 'Ghost Arc')).toBe(false)
    })
  })

  describe('reflection materializes directly, proposals stay dormant', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-save-by-default-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    it('materializes a new arc directly during reflection with no proposal and no acceptance step', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('Started training for a marathon.'),
        items: [{ text: 'Went for a long run', kind: 'event' }],
        newArcs: [
          {
            name: 'Marathon Training',
            realm: 'Fitness',
            reason: 'mentioned training for a marathon',
            itemIndexes: [0],
            narrative: 'Training for a marathon this fall, starting with long weekend runs.',
          },
        ],
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Went for a long run, training for a marathon this fall.',
      })
      await engine.endSession(sessionId)

      const graph = await readGraph(paths)
      const arcNode = [...graph.nodes.values()].find(
        (n) => n.type === 'arc' && n.label === 'Marathon Training',
      )
      if (!arcNode?.doc) throw new Error('expected an arc node with a doc pointer')

      const arcDoc = await readDocument(paths.files, arcNode.doc)
      expect(arcDoc.body).toBe(
        'Training for a marathon this fall, starting with long weekend runs.\n',
      )
      expect(arcDoc.meta.status).toBe('active')

      // Direct materialization from reflection: nobody affirmed this arc,
      // so confirmed is false on both its edges, unlike an accepted
      // proposal's confirmed: true (see 'materializes a new arc together
      // with a brand-new realm...' in the resolveProposal block above,
      // which is otherwise identical: same node shape, same starter-body
      // fallback rule, same one-appendGraph-call structure).
      const itemNode = [...graph.nodes.values()].find(
        (n) => n.type === 'item' && n.label === 'Went for a long run',
      )
      if (!itemNode) throw new Error('expected the minted item node')
      expect(graph.edges.get(`part_of:${itemNode.id}:${arcNode.id}`)).toMatchObject({
        confidence: 1,
        confirmed: false,
      })
      const realmNode = [...graph.nodes.values()].find(
        (n) => n.type === 'realm' && n.label === 'Fitness',
      )
      if (!realmNode) throw new Error('expected a realm node to be created')
      expect(graph.edges.get(`in:${arcNode.id}:${realmNode.id}`)).toMatchObject({
        confidence: 1,
        confirmed: false,
      })

      const pending = await pendingProposals(paths)
      expect(pending).toHaveLength(0)

      await engine.close()
    })

    it('materializes a person page directly during reflection with no proposal and no acceptance step', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('Talked a lot about Sam today.'),
        items: [{ text: 'Ran with Sam again', kind: 'event' }],
        newPersons: [
          {
            name: 'Sam',
            reason: 'recurring running partner, mentioned again this session',
            itemIndexes: [0],
            deservesPage: true,
            narrative: 'Sam is a running partner who joins for weekend long runs.',
          },
        ],
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Ran with Sam again this morning.',
      })
      await engine.endSession(sessionId)

      const graph = await readGraph(paths)
      const personNode = [...graph.nodes.values()].find(
        (n) => n.type === 'person' && n.label === 'Sam',
      )
      if (!personNode?.doc) throw new Error('expected a person node with a doc pointer')

      const personDoc = await readDocument(paths.files, personNode.doc)
      expect(personDoc.body).toBe('Sam is a running partner who joins for weekend long runs.\n')
      expect(personDoc.meta.name).toBe('Sam')
      expect(personDoc.meta.node).toBe(personNode.id)

      // The involves edge for the item that mentioned Sam must exist too,
      // asserted in the same appendGraph call as the person node itself.
      // Direct materialization from reflection: nobody affirmed this
      // person, so confirmed is false, unlike an accepted proposal's
      // confirmed: true (see 'materializes a new person as a page...' above).
      const itemNode = [...graph.nodes.values()].find(
        (n) => n.type === 'item' && n.label === 'Ran with Sam again',
      )
      if (!itemNode) throw new Error('expected the minted item node')
      expect(graph.edges.get(`involves:${itemNode.id}:${personNode.id}`)).toMatchObject({
        confidence: 1,
        confirmed: false,
      })

      const pending = await pendingProposals(paths)
      expect(pending).toHaveLength(0)

      await engine.close()
    })

    it('materializes a new arc with an empty narrative using the arc starter body, not a blank page', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session with a thin new arc.'),
        items: [{ text: 'Went for a long run', kind: 'event' }],
        newArcs: [
          {
            name: 'Marathon Training',
            realm: 'Fitness',
            reason: 'mentioned training for a marathon',
            itemIndexes: [0],
            narrative: '   ',
          },
        ],
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Went for a long run, training for a marathon this fall.',
      })
      await engine.endSession(sessionId)

      const graph = await readGraph(paths)
      const arcNode = [...graph.nodes.values()].find(
        (n) => n.type === 'arc' && n.label === 'Marathon Training',
      )
      if (!arcNode?.doc) throw new Error('expected an arc node with a doc pointer')

      const arcDoc = await readDocument(paths.files, arcNode.doc)
      expect(arcDoc.body).toBe('This arc is new. It grows as we talk.\n')

      await engine.close()
    })

    it('materializes a new person with an empty narrative using the person starter body, not a blank page', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session with a thin new person.'),
        items: [{ text: 'Ran with Sam again', kind: 'event' }],
        newPersons: [
          {
            name: 'Sam',
            reason: 'recurring running partner',
            itemIndexes: [0],
            deservesPage: true,
            narrative: '',
          },
        ],
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Ran with Sam again this morning.',
      })
      await engine.endSession(sessionId)

      const graph = await readGraph(paths)
      const personNode = [...graph.nodes.values()].find(
        (n) => n.type === 'person' && n.label === 'Sam',
      )
      if (!personNode?.doc) throw new Error('expected a person node with a doc pointer')

      const personDoc = await readDocument(paths.files, personNode.doc)
      expect(personDoc.body).toBe('This page is new. It grows as we talk.\n')

      await engine.close()
    })

    it('drops a newArcs entry whose itemIndexes resolve to no items, materializing nothing for it', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session with a ghost arc.'),
        newArcs: [
          {
            name: 'Ghost Arc',
            realm: 'Fitness',
            reason: 'only out-of-range indexes',
            itemIndexes: [5, -1],
            narrative: 'Should never land anywhere.',
          },
        ],
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'A session with nothing much in it.',
      })
      await engine.endSession(sessionId)

      const graph = await readGraph(paths)
      expect([...graph.nodes.values()].some((n) => n.label === 'Ghost Arc')).toBe(false)

      await engine.close()
    })

    it('materializes a pre-existing pending proposal silently on open, with no conversation and nothing left pending', async () => {
      const proposal: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'new_arc',
        summary: 'A proposal that predates this release.',
        payload: { name: 'Legacy Arc', realm: 'Legacy Realm', itemIds: [newId('item')] },
        source: 'session_legacy',
      }
      await appendProposals(paths, [proposal], 'UTC')

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

      // Already materialized and resolved by the time open() returns: no
      // acceptance step, no call to resolveProposal from the test at all.
      const graph = await readGraph(paths)
      const arcNode = [...graph.nodes.values()].find(
        (n) => n.type === 'arc' && n.label === 'Legacy Arc',
      )
      expect(arcNode).toBeDefined()

      const pending = await pendingProposals(paths)
      expect(pending.find((p) => p.id === proposal.id)).toBeUndefined()

      // Silent: the resolution is recorded (proposals.jsonl keeps its
      // compatibility promise), but nothing about draining it is surfaced
      // as a warning.
      const rawProposals = await readFile(paths.proposals, 'utf8')
      expect(rawProposals).toContain(`"op":"resolve","id":"${proposal.id}","resolution":"accepted"`)
      expect(engine.warnings).toEqual([])

      await engine.close()
    })

    it('drains multiple pre-existing proposals of different kinds silently on open', async () => {
      const arcItemId = newId('item')
      const personItemId = newId('item')
      const arcProposal: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'new_arc',
        summary: 'A legacy arc proposal.',
        payload: { name: 'Legacy Arc', realm: 'Legacy Realm', itemIds: [arcItemId] },
        source: 'session_legacy',
      }
      const personProposal: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'new_person',
        summary: 'A legacy person proposal.',
        payload: { name: 'Legacy Person', itemIds: [personItemId] },
        source: 'session_legacy',
      }
      await appendProposals(paths, [arcProposal, personProposal], 'UTC')

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

      const graph = await readGraph(paths)
      expect(
        [...graph.nodes.values()].some((n) => n.type === 'arc' && n.label === 'Legacy Arc'),
      ).toBe(true)
      expect(
        [...graph.nodes.values()].some((n) => n.type === 'person' && n.label === 'Legacy Person'),
      ).toBe(true)

      const pending = await pendingProposals(paths)
      expect(pending).toHaveLength(0)

      await engine.close()
    })

    it('a legacy proposal with a malformed payload does not prevent open() from succeeding or the rest of the queue from draining', async () => {
      const malformed: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'new_arc',
        summary: 'A proposal written under a shape this release no longer produces.',
        // itemIds is missing entirely: materializeProposal's unchecked cast
        // to { name; realm; itemIds } lets this through, and createArc's
        // `for (const itemId of input.itemIds)` throws a TypeError on it.
        payload: { name: 'Malformed Arc', realm: 'Some Realm' },
        source: 'session_legacy',
      }
      const good: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'new_arc',
        summary: 'A proposal in the shape this release actually writes.',
        payload: { name: 'Good Arc', realm: 'Some Realm', itemIds: [newId('item')] },
        source: 'session_legacy',
      }
      await appendProposals(paths, [malformed, good], 'UTC')

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

      const graph = await readGraph(paths)
      expect([...graph.nodes.values()].some((n) => n.label === 'Malformed Arc')).toBe(false)
      expect(
        [...graph.nodes.values()].some((n) => n.type === 'arc' && n.label === 'Good Arc'),
      ).toBe(true)

      const pending = await pendingProposals(paths)
      expect(pending).toHaveLength(0)

      expect(
        engine.warnings.some(
          (w) => w.includes(malformed.id) && w.toLowerCase().includes('materialize'),
        ),
      ).toBe(true)

      await engine.close()
    })

    it('a legacy proposal with a malformed payload does not make a second open() throw either', async () => {
      const malformed: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'new_arc',
        summary: 'A proposal written under a shape this release no longer produces.',
        payload: { name: 'Malformed Arc', realm: 'Some Realm' },
        source: 'session_legacy',
      }
      await appendProposals(paths, [malformed], 'UTC')

      const first = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      await first.close()

      const second = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const pending = await pendingProposals(paths)
      expect(pending).toHaveLength(0)
      await second.close()
    })

    it('a genuinely corrupt line in the proposal queue does not make open() throw', async () => {
      // Not a malformed payload (valid JSON, wrong shape): a truncated line
      // that is not valid JSON at all, the kind appendFile's lack of crash
      // atomicity or a synced, hand-edited folder can produce.
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
      await writeFile(paths.proposals, '{"id":"prop_broken","kind":"new_arc"\n', 'utf8')

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

      expect(
        engine.warnings.some(
          (w) => w.includes(paths.proposals) || w.toLowerCase().includes('proposal queue'),
        ),
      ).toBe(true)

      await engine.close()
    })

    it('a genuinely corrupt proposal queue does not block a second open() either, so reindex keeps working', async () => {
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
      await writeFile(paths.proposals, '{"id":"prop_broken","kind":"new_arc"\n', 'utf8')

      const first = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      await first.close()

      const second = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      expect(
        second.warnings.some(
          (w) => w.includes(paths.proposals) || w.toLowerCase().includes('proposal queue'),
        ),
      ).toBe(true)
      await second.close()
    })

    it('a reflection run appends nothing to proposals.jsonl even with new arcs, new persons, and low-confidence attributions', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A busy session.'),
        items: [{ text: 'Went for a long run', kind: 'event' }],
        attributions: [{ itemIndex: 0, arcId: 'arc_does_not_exist', confidence: 0.1 }],
        newArcs: [
          {
            name: 'Marathon Training',
            realm: 'Fitness',
            reason: 'mentioned training',
            itemIndexes: [0],
            narrative: 'First body.',
          },
        ],
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'A busy session about running.',
      })
      await engine.endSession(sessionId)

      await expect(readFile(paths.proposals, 'utf8')).rejects.toThrow()

      await engine.close()
    })

    it('carries forward an arc document body through a pass-two rewrite triggered end to end by endSession', async () => {
      // Seed the arc, its realm, and the arc document BEFORE opening the
      // engine: MemoryEngine.open reads graph.jsonl into the cached
      // graphState once, and _doEndSession's resolveNarratives call reads
      // that cached graphState, not a fresh readGraph. Seeding after open()
      // would leave the arcUpdate below unable to resolve arc_health at all.
      const arcDocPath = join(paths.arcsDir, 'health.md')
      await writeDocumentAtomic(paths.files, {
        path: arcDocPath,
        meta: { id: newId('doc'), name: 'Health', status: 'active' },
        body: 'Training log:\n- Ran a 5k last week.\n',
      })
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'arc_health',
          type: 'arc',
          label: 'Health',
          doc: arcDocPath,
        },
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'realm_health',
          type: 'realm',
          label: 'Health',
        },
      ])

      const out: ReflectionOutput = {
        ...emptyReflectionOutput('Ran another 10k today, building on last week.'),
        items: [{ text: 'Went for a 10k run', kind: 'event' }],
        attributions: [{ itemIndex: 0, arcId: 'arc_health', confidence: 0.9 }],
        arcUpdates: [
          { arcId: 'arc_health', note: 'Ran a 10k, building on the 5k from last week.' },
        ],
      }
      const rewrittenBody = 'Training log:\n- Ran a 5k last week.\n- Ran a 10k this week.\n'
      const chat = new FakeChatProvider([
        { text: JSON.stringify(out), toolCalls: [] },
        { text: JSON.stringify({ body: rewrittenBody }), toolCalls: [] },
      ])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Ran another 10k today, building on last week.',
      })
      await engine.endSession(sessionId)

      const arcDoc = await readDocument(paths.files, arcDocPath)
      expect(arcDoc.body).toBe(rewrittenBody)
      // What was already on the page before this session carries forward.
      expect(arcDoc.body).toContain('Ran a 5k last week')

      // The rewrite prompt itself must carry the body already on disk, or
      // "carries forward" above is only true because the fake chat provider
      // was scripted to say so, not because the engine actually read the
      // existing body before asking the model to rewrite it.
      const rewritePrompt = chat.requests[1]?.messages[0]?.content ?? ''
      expect(rewritePrompt).toContain('Ran a 5k last week')

      await engine.close()
    })

    it('leaves the session unreflected and retryable if direct arc materialization fails, with summary.md never written', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('Started training for a marathon.'),
        items: [{ text: 'Went for a long run', kind: 'event' }],
        newArcs: [
          {
            name: 'Marathon Training',
            realm: 'Fitness',
            reason: 'mentioned training for a marathon',
            itemIndexes: [0],
            narrative: 'Training for a marathon this fall.',
          },
        ],
      }
      const chat = new FakeChatProvider([
        { text: JSON.stringify(out), toolCalls: [] },
        { text: JSON.stringify(out), toolCalls: [] },
      ])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Went for a long run, training for a marathon this fall.',
      })

      // Remove write permission on arcsDir so createArc's writeDocumentAtomic
      // call, invoked as the materializeNew callback inside applyReflection's
      // phase two, fails partway through endSession. Without Finding 2's
      // fix this would still leave summary.md written and the session
      // permanently marked reflected, with the arc it should have created
      // gone for good.
      await chmod(paths.arcsDir, 0o500)
      try {
        await expect(engine.endSession(sessionId)).rejects.toThrow()
      } finally {
        await chmod(paths.arcsDir, 0o700)
      }

      const sessionDir = join(
        paths.sessionsDir,
        `${formatLocalDate(new Date(), engine.timezone())}-${sessionId}`,
      )
      await expect(readDocument(paths.files, join(sessionDir, 'summary.md'))).rejects.toThrow()

      const graph = await readGraph(paths)
      expect([...graph.nodes.values()].some((n) => n.label === 'Marathon Training')).toBe(false)

      // Retryable: with the permission restored, endSession on the same
      // sessionId (still unreflected, since summary.md never landed) now
      // succeeds and actually creates the arc.
      await engine.endSession(sessionId)
      const summaryDoc = await readDocument(paths.files, join(sessionDir, 'summary.md'))
      expect(summaryDoc.body.length).toBeGreaterThan(0)
      const graphAfterRetry = await readGraph(paths)
      expect([...graphAfterRetry.nodes.values()].some((n) => n.label === 'Marathon Training')).toBe(
        true,
      )

      await engine.close()
    })

    it('runMaintenance over a stale session whose direct materialization fails leaves it unreflected with no warning, and reflects it once retryable', async () => {
      const now = new Date()
      const twoDaysAgo = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2),
      )

      const staleStore = await SessionStore.start(paths, twoDaysAgo)
      await staleStore.appendLine(paths, {
        ts: twoDaysAgo.toISOString(),
        role: 'user',
        content: 'Went for a long run, training for a marathon this fall.',
      })

      const out: ReflectionOutput = {
        ...emptyReflectionOutput('Started training for a marathon.'),
        items: [{ text: 'Went for a long run', kind: 'event' }],
        newArcs: [
          {
            name: 'Marathon Training',
            realm: 'Fitness',
            reason: 'mentioned training for a marathon',
            itemIndexes: [0],
            narrative: 'Training for a marathon this fall.',
          },
        ],
      }
      // A mutable script array, like the e2e harness uses: FakeChatProvider
      // holds this same array by reference, so pushing another scripted
      // reply after construction lets a later runMaintenance retry draw it.
      const script = [{ text: JSON.stringify(out), toolCalls: [] }]
      const chat = new FakeChatProvider(script)

      // runMaintenance's own _doEndSession call runs inside MemoryEngine.open
      // (via open's own call to runMaintenance), so arcsDir must already be
      // read-only before open() rather than after.
      await chmod(paths.arcsDir, 0o500)
      let engine: MemoryEngine
      try {
        engine = await MemoryEngine.open(dir, fakeDeps(chat))
      } finally {
        await chmod(paths.arcsDir, 0o700)
      }

      // Caught silently, exactly like every other pre-summary failure
      // runMaintenance's loop has always swallowed: no warning is recorded
      // in engine.warnings, and the retry on the next pass is the
      // recovery. Since R4 this is no longer a failure with nothing
      // recorded anywhere: the reflection log's own 'failed' outcome
      // record (see reflectionLog.test.ts and the "reflection log (R4)"
      // describe block below) is what makes it visible, independent of
      // this in-memory, per-process warnings list.
      expect(engine.warnings).toEqual([])

      const staleSessionDir = join(
        paths.sessionsDir,
        `${formatLocalDate(twoDaysAgo, 'UTC')}-${staleStore.sessionId}`,
      )
      await expect(readDocument(paths.files, join(staleSessionDir, 'summary.md'))).rejects.toThrow()

      const graph = await readGraph(paths)
      expect([...graph.nodes.values()].some((n) => n.label === 'Marathon Training')).toBe(false)

      // arcsDir is writable again now; a second scripted reflection lets
      // the retry actually succeed.
      script.push({ text: JSON.stringify(out), toolCalls: [] })
      await engine.runMaintenance()

      expect(engine.warnings).toEqual([])
      const summaryDoc = await readDocument(paths.files, join(staleSessionDir, 'summary.md'))
      expect(summaryDoc.body.length).toBeGreaterThan(0)
      const graphAfterRetry = await readGraph(paths)
      expect([...graphAfterRetry.nodes.values()].some((n) => n.label === 'Marathon Training')).toBe(
        true,
      )

      await engine.close()
    })
  })

  describe('node-only capture, entities, promotion, and dedup', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-nodes-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    it('creates a person node with no page and no doc when deservesPage is false', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('Mentioned a coworker in passing.'),
        items: [{ text: 'Mentioned working with Priya on the launch', kind: 'event' }],
        newPersons: [
          {
            name: 'Priya',
            reason: 'coworker mentioned this session, not yet recurring',
            itemIndexes: [0],
            deservesPage: false,
            narrative: '',
          },
        ],
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Worked with Priya on the launch today.',
      })
      await engine.endSession(sessionId)

      const graph = await readGraph(paths)
      const personNode = [...graph.nodes.values()].find(
        (n) => n.type === 'person' && n.label === 'Priya',
      )
      if (!personNode) throw new Error('expected a person node')
      expect(personNode.doc).toBeUndefined()

      const itemNode = [...graph.nodes.values()].find((n) => n.type === 'item')
      if (!itemNode) throw new Error('expected the minted item node')
      expect(graph.edges.get(`involves:${itemNode.id}:${personNode.id}`)).toMatchObject({
        confidence: 1,
        confirmed: false,
      })

      await engine.close()
    })

    it('creates an entity node with no page and no doc, connected by a relates_to edge', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('Rewatched a favorite film.'),
        items: [{ text: 'Rewatched a favorite film for the third time', kind: 'event' }],
        newEntities: [
          {
            name: 'A Favorite Film',
            reason: 'rewatched again, clearly matters to them',
            itemIndexes: [0],
          },
        ],
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Rewatched my favorite film again tonight.',
      })
      await engine.endSession(sessionId)

      const graph = await readGraph(paths)
      const entityNode = [...graph.nodes.values()].find(
        (n) => n.type === 'entity' && n.label === 'A Favorite Film',
      )
      if (!entityNode) throw new Error('expected an entity node')
      expect(entityNode.doc).toBeUndefined()

      const itemNode = [...graph.nodes.values()].find((n) => n.type === 'item')
      if (!itemNode) throw new Error('expected the minted item node')
      expect(graph.edges.get(`relates_to:${itemNode.id}:${entityNode.id}`)).toMatchObject({
        confidence: 1,
        confirmed: false,
      })

      await engine.close()
    })

    it('drops a newEntities entry whose itemIndexes resolve to no items, materializing nothing for it', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session with a ghost entity.'),
        newEntities: [
          { name: 'Ghost Entity', reason: 'only out-of-range indexes', itemIndexes: [9] },
        ],
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'A quiet session.',
      })
      await engine.endSession(sessionId)

      const graph = await readGraph(paths)
      expect([...graph.nodes.values()].some((n) => n.label === 'Ghost Entity')).toBe(false)

      await engine.close()
    })

    it('promotes a person captured node-only in one session to a page in a later session', async () => {
      const firstOut: ReflectionOutput = {
        ...emptyReflectionOutput('Mentioned a coworker in passing.'),
        items: [{ text: 'Mentioned working with Priya on the launch', kind: 'event' }],
        newPersons: [
          {
            name: 'Priya',
            reason: 'coworker mentioned once, not yet recurring',
            itemIndexes: [0],
            deservesPage: false,
            narrative: '',
          },
        ],
      }
      const firstChat = new FakeChatProvider([{ text: JSON.stringify(firstOut), toolCalls: [] }])
      let engine = await MemoryEngine.open(dir, fakeDeps(firstChat))

      const firstSessionId = await engine.startSession()
      await engine.appendTranscript(firstSessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Worked with Priya on the launch today.',
      })
      await engine.endSession(firstSessionId)

      const graphAfterFirst = await readGraph(paths)
      const priyaNode = [...graphAfterFirst.nodes.values()].find(
        (n) => n.type === 'person' && n.label === 'Priya',
      )
      if (!priyaNode) throw new Error('expected a node-only person after the first session')
      expect(priyaNode.doc).toBeUndefined()

      await engine.close()

      // Second session: Priya recurs, so reflection promotes her existing
      // node-only id to a page instead of minting a second node for her.
      const promotedNarrative = 'Priya is a coworker who keeps coming up on the launch project.'
      const secondOut: ReflectionOutput = {
        ...emptyReflectionOutput('Priya came up again, this time it is clear she matters.'),
        items: [{ text: 'Worked late with Priya again on the launch', kind: 'event' }],
        pagePromotions: [
          {
            nodeId: priyaNode.id,
            reason: 'Priya keeps recurring across sessions now',
            itemIndexes: [0],
            narrative: promotedNarrative,
          },
        ],
      }
      const secondChat = new FakeChatProvider([{ text: JSON.stringify(secondOut), toolCalls: [] }])
      engine = await MemoryEngine.open(dir, fakeDeps(secondChat))

      // The prompt this session must show Priya as already known, with no
      // page yet: that is the visibility promotion depends on.
      const secondSessionId = await engine.startSession()
      await engine.appendTranscript(secondSessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Worked late with Priya again on the launch.',
      })
      await engine.endSession(secondSessionId)

      const promptSeenBySecondSession = secondChat.requests[0]?.messages[0]?.content ?? ''
      expect(promptSeenBySecondSession).toContain(`${priyaNode.id}: Priya (no page yet)`)

      const graphAfterSecond = await readGraph(paths)
      const promotedNode = graphAfterSecond.nodes.get(priyaNode.id)
      if (!promotedNode?.doc)
        throw new Error('expected Priya to have a doc pointer after promotion')
      // Same node id preserved across the promotion: nothing pointing at
      // Priya from the first session goes stale.
      expect(promotedNode.id).toBe(priyaNode.id)

      const personDoc = await readDocument(paths.files, promotedNode.doc)
      expect(personDoc.body).toBe(`${promotedNarrative}\n`)
      expect(personDoc.meta.node).toBe(priyaNode.id)

      const itemNode = [...graphAfterSecond.nodes.values()].find(
        (n) => n.type === 'item' && n.label === 'Worked late with Priya again on the launch',
      )
      if (!itemNode) throw new Error('expected the second session item node')
      expect(graphAfterSecond.edges.get(`involves:${itemNode.id}:${priyaNode.id}`)).toMatchObject({
        confidence: 1,
        confirmed: false,
      })

      await engine.close()
    })

    it('does not gate a page promotion on this session resolving any items', async () => {
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'person_priya',
          type: 'person',
          label: 'Priya',
        },
      ])

      const out: ReflectionOutput = {
        ...emptyReflectionOutput(
          'Priya was clearly central to this session, but no single new item names her.',
        ),
        pagePromotions: [
          {
            nodeId: 'person_priya',
            reason: 'recurs now, even with no item indexes this session',
            itemIndexes: [],
            narrative: 'Priya matters.',
          },
        ],
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'A session about Priya with no distinct new item.',
      })
      await engine.endSession(sessionId)

      const graph = await readGraph(paths)
      const priyaNode = graph.nodes.get('person_priya')
      if (!priyaNode?.doc)
        throw new Error('expected Priya to be promoted despite zero item indexes')
      const personDoc = await readDocument(paths.files, priyaNode.doc)
      expect(personDoc.body).toBe('Priya matters.\n')

      await engine.close()
    })

    it('drops a pagePromotions entry targeting a person who already has a page, instead of writing a second page', async () => {
      const personDocPath = join(paths.peopleDir, 'priya.md')
      await writeDocumentAtomic(paths.files, {
        path: personDocPath,
        meta: { id: newId('doc'), name: 'Priya', node: 'person_priya' },
        body: 'Original Priya page.\n',
      })
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'person_priya',
          type: 'person',
          label: 'Priya',
          doc: personDocPath,
        },
      ])

      const out: ReflectionOutput = {
        ...emptyReflectionOutput('Priya came up again.'),
        pagePromotions: [
          {
            nodeId: 'person_priya',
            reason: 'mistakenly promoted again',
            itemIndexes: [],
            narrative: 'Should never land, she already has a page.',
          },
        ],
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Priya came up again today.',
      })
      await engine.endSession(sessionId)

      const personDoc = await readDocument(paths.files, personDocPath)
      expect(personDoc.body).toBe('Original Priya page.\n')

      await engine.close()
    })

    // Guards against a double page write when a single reflection output
    // names the same already-known, node-only person in BOTH newPersons
    // (as if she were new, deservesPage true) AND pagePromotions (targeting
    // her real existing node id): a plausible way for a model to slip,
    // since it decides newPersons and pagePromotions independently.
    //
    // What actually carries this safety: whichever of the two loops runs
    // second reads existing.doc off the live graphState and skips writing
    // a page once it is set, and writePersonPage's syncGraph() call is what
    // makes the first loop's write visible to the second loop's read. Loop
    // order (newPersons before pagePromotions in materializeNew today) does
    // NOT matter for this specific double-write guarantee: the two guards
    // are symmetric, so either loop running first and the other second is
    // still safe, and this test passes either way (verified by temporarily
    // swapping the two loop blocks in engine.ts while writing this test).
    // What is genuinely load-bearing is the `existing.doc` check itself:
    // remove it from the pagePromotions guard and this test fails with two
    // person pages for the same node id, one from each branch.
    //
    // Loop order does still matter for something else, outside what this
    // test checks: when pagePromotions runs after a page already exists,
    // it drops that entry's items with no fallback attach (unlike
    // newPersons, which falls back to attachItemsToNode), so an item
    // attributed only through pagePromotions in this exact scenario is
    // silently never linked to the person. See the report for this task.
    it('writes exactly one page when one reflection output names the same known, node-only person in both newPersons and pagePromotions', async () => {
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'person_priya',
          type: 'person',
          label: 'Priya',
        },
      ])

      const out: ReflectionOutput = {
        ...emptyReflectionOutput('Priya came up twice, and reflection listed her both ways.'),
        items: [
          { text: 'Priya helped debug the release', kind: 'event' },
          { text: 'Priya stayed late again to help', kind: 'event' },
        ],
        newPersons: [
          {
            name: 'Priya',
            reason: 'model treated her as newly worth a page',
            itemIndexes: [0],
            deservesPage: true,
            narrative: 'From newPersons: Priya has become a real presence at work.',
          },
        ],
        pagePromotions: [
          {
            nodeId: 'person_priya',
            reason: 'model also promoted her existing node-only id',
            itemIndexes: [1],
            narrative: 'From pagePromotions: Priya has become a real presence at work.',
          },
        ],
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Priya helped a lot today, staying late again.',
      })
      await engine.endSession(sessionId)

      const graph = await readGraph(paths)
      const personNodes = [...graph.nodes.values()].filter(
        (n) => n.type === 'person' && n.label === 'Priya',
      )
      expect(personNodes).toHaveLength(1)

      const personPages = await listDocuments(paths.files, paths.peopleDir)
      expect(personPages).toHaveLength(1)

      await engine.close()
    })

    it('drops a pagePromotions entry targeting an unknown node id', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session naming someone not actually known.'),
        pagePromotions: [
          { nodeId: 'person_does_not_exist', reason: 'unknown', itemIndexes: [], narrative: 'x' },
        ],
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'A quiet session.',
      })
      await expect(engine.endSession(sessionId)).resolves.toBeUndefined()

      await engine.close()
    })

    // The genuine relist case: the identical name, meaning the model
    // believes (correctly, in this test) that it is the same person.
    // Contrast with the escape-hatch test right below, where a
    // distinguishing name is used because it is a different person who
    // happens to share a first name: that one must NOT attach to this
    // node, and does not.
    it('attaches items to the existing node when newPersons relists the same person under the identical name', async () => {
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'person_priya',
          type: 'person',
          label: 'Priya',
        },
      ])

      const out: ReflectionOutput = {
        ...emptyReflectionOutput(
          'Priya mentioned again, model relists her despite the instruction not to.',
        ),
        items: [{ text: 'Worked with Priya again', kind: 'event' }],
        newPersons: [
          {
            name: 'Priya',
            reason: 'relisted by mistake',
            itemIndexes: [0],
            deservesPage: false,
            narrative: '',
          },
        ],
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Worked with Priya again today.',
      })
      await engine.endSession(sessionId)

      const graph = await readGraph(paths)
      const personNodes = [...graph.nodes.values()].filter(
        (n) => n.type === 'person' && n.label === 'Priya',
      )
      expect(personNodes).toHaveLength(1)

      const itemNode = [...graph.nodes.values()].find((n) => n.type === 'item')
      if (!itemNode) throw new Error('expected the minted item node')
      expect(graph.edges.get(`involves:${itemNode.id}:person_priya`)).toMatchObject({
        confidence: 1,
        confirmed: false,
      })

      await engine.close()
    })

    it('a newPersons entry with a distinguishing name does not merge into an existing person who happens to share a first name', async () => {
      // The escape hatch: label dedup is exact (case-insensitive), so a
      // second, different Priya captured under a distinguishing name (the
      // prompt now tells the model to do this rather than merge two
      // different people into one node) resolves as a brand-new node, not
      // an attachment to the first Priya's.
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'person_priya',
          type: 'person',
          label: 'Priya',
        },
      ])

      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A different Priya, from the new team, came up this session.'),
        items: [{ text: 'Met Priya from the new team', kind: 'event' }],
        newPersons: [
          {
            name: 'Priya from the new team',
            reason: 'a different person who shares a first name with a known person',
            itemIndexes: [0],
            deservesPage: false,
            narrative: '',
          },
        ],
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Met Priya from the new team today.',
      })
      await engine.endSession(sessionId)

      const graph = await readGraph(paths)
      const priyaNodes = [...graph.nodes.values()].filter(
        (n) => n.type === 'person' && n.label === 'Priya',
      )
      expect(priyaNodes).toHaveLength(1)
      const newPriyaNodes = [...graph.nodes.values()].filter(
        (n) => n.type === 'person' && n.label === 'Priya from the new team',
      )
      expect(newPriyaNodes).toHaveLength(1)
      expect(newPriyaNodes[0]?.id).not.toBe('person_priya')

      // The original Priya's node carries no edge to this session's item:
      // nothing from this session attached to her.
      const itemNode2 = [...graph.nodes.values()].find((n) => n.type === 'item')
      if (!itemNode2) throw new Error('expected the minted item node')
      expect(graph.edges.get(`involves:${itemNode2.id}:person_priya`)).toBeUndefined()
      expect(graph.edges.get(`involves:${itemNode2.id}:${newPriyaNodes[0]?.id}`)).toMatchObject({
        confidence: 1,
        confirmed: false,
      })

      await engine.close()
    })

    it('resolves a newPersons entry that relists an already-paged known person by attaching items, not writing a second page', async () => {
      const personDocPath = join(paths.peopleDir, 'priya.md')
      await writeDocumentAtomic(paths.files, {
        path: personDocPath,
        meta: { id: newId('doc'), name: 'Priya', node: 'person_priya' },
        body: 'Original Priya page.\n',
      })
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'person_priya',
          type: 'person',
          label: 'Priya',
          doc: personDocPath,
        },
      ])

      const out: ReflectionOutput = {
        ...emptyReflectionOutput('Priya mentioned again.'),
        items: [{ text: 'Worked with Priya again', kind: 'event' }],
        newPersons: [
          {
            name: 'Priya',
            reason: 'relisted by mistake, she already has a page',
            itemIndexes: [0],
            deservesPage: true,
            narrative: 'Should never land, she already has a page.',
          },
        ],
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Worked with Priya again today.',
      })
      await engine.endSession(sessionId)

      const personDoc = await readDocument(paths.files, personDocPath)
      expect(personDoc.body).toBe('Original Priya page.\n')

      const graph = await readGraph(paths)
      const itemNode = [...graph.nodes.values()].find((n) => n.type === 'item')
      if (!itemNode) throw new Error('expected the minted item node')
      expect(graph.edges.get(`involves:${itemNode.id}:person_priya`)).toMatchObject({
        confidence: 1,
        confirmed: false,
      })

      await engine.close()
    })

    it('resolves a newEntities entry that relists an already-known entity by attaching items instead of minting a duplicate', async () => {
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'entity_film',
          type: 'entity',
          label: 'A Favorite Film',
        },
      ])

      const out: ReflectionOutput = {
        ...emptyReflectionOutput('The film comes up again.'),
        items: [{ text: 'Talked about the film again', kind: 'event' }],
        newEntities: [{ name: 'A Favorite Film', reason: 'relisted by mistake', itemIndexes: [0] }],
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Talked about the film again.',
      })
      await engine.endSession(sessionId)

      const graph = await readGraph(paths)
      const entityNodes = [...graph.nodes.values()].filter(
        (n) => n.type === 'entity' && n.label === 'A Favorite Film',
      )
      expect(entityNodes).toHaveLength(1)

      const itemNode = [...graph.nodes.values()].find((n) => n.type === 'item')
      if (!itemNode) throw new Error('expected the minted item node')
      expect(graph.edges.get(`relates_to:${itemNode.id}:entity_film`)).toMatchObject({
        confidence: 1,
        confirmed: false,
      })

      await engine.close()
    })

    it('drops a personUpdates note for a node promoted this same session, since the cached graph state still has no doc for it when pass two runs', async () => {
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'person_priya',
          type: 'person',
          label: 'Priya',
        },
      ])

      const out: ReflectionOutput = {
        ...emptyReflectionOutput('Priya recurs and, contradictorily, is also given a note update.'),
        items: [{ text: 'Worked with Priya again', kind: 'event' }],
        pagePromotions: [
          {
            nodeId: 'person_priya',
            reason: 'recurs now',
            itemIndexes: [0],
            narrative: 'Priya, promoted this session.',
          },
        ],
        // Nonsensical model output (a node cannot be promoted and already
        // have a page-worthy update note in the same session), but pass
        // two must handle it safely: it reads the graph state cached
        // before this session's materialization, where person_priya still
        // has no doc, so this entry is dropped, not used to overwrite the
        // narrative promotion is about to write.
        personUpdates: [{ personId: 'person_priya', note: 'Should be dropped, no doc yet.' }],
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Worked with Priya again today.',
      })
      await expect(engine.endSession(sessionId)).resolves.toBeUndefined()

      const summaryDoc = await readDocument(
        paths.files,
        join(
          paths.sessionsDir,
          `${formatLocalDate(new Date(), engine.timezone())}-${sessionId}`,
          'summary.md',
        ),
      )
      expect(summaryDoc.body).toBe(`${out.summary}\n`)

      const graph = await readGraph(paths)
      const promotedNode = graph.nodes.get('person_priya')
      if (!promotedNode?.doc) throw new Error('expected the promotion to have landed')
      const personDoc = await readDocument(paths.files, promotedNode.doc)
      expect(personDoc.body).toBe('Priya, promoted this session.\n')

      await engine.close()
    })
  })

  describe('commitments: reflection-side wiring', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-commitments-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    // Guards the engine.ts wiring itself, not just applyReflection in
    // isolation: this.timezone() actually has to reach applyReflection's
    // buildCommitmentTiming through the real endSession path. Runs the
    // same session twice, once per profile timezone, and requires the two
    // resolved dates to differ. Deliberately not a fixed expected date
    // against a single timezone: applyReflection falls back to the
    // machine's own system timezone when none is passed (see reflection.ts,
    // the default on the `timezone` parameter), and this suite's own
    // machine timezone is not something a test should have to know or
    // pin. Deleting `this.timezone()` from the applyReflection call site
    // in engine.ts makes both runs silently fall back to that same system
    // default regardless of profile, so the two dates collapse to one and
    // this test fails, while reflection.test.ts's own suite (which calls
    // applyReflection directly and always passes its own timezone) stays
    // green.
    async function resolvedDateFor(zone: string): Promise<string | undefined> {
      const runDir = await mkdtemp(join(tmpdir(), 'openreverie-engine-commitments-tz-'))
      const runPaths = memoryPaths(runDir, nodeStores())
      await ensureMemoryTree(runPaths, 'UTC')
      await pinTimezoneUtc(runPaths)
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A late-night reminder.'),
        commitments: [{ label: 'Call the dentist', flavor: 'errand', statedTime: 'tomorrow' }],
      }
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
      const engine = await MemoryEngine.open(runDir, fakeDeps(chat))
      await engine.updateProfile({ timezone: zone })

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: '2026-08-13T20:00:00.000Z',
        role: 'user',
        content: 'Remind me to call the dentist tomorrow.',
      })
      await engine.endSession(sessionId)

      const graph = await readGraph(runPaths)
      const commitmentNode = [...graph.nodes.values()].find((n) => n.type === 'commitment')
      const resolvedFrom = commitmentNode?.commitment?.timing?.resolved?.from
      await engine.close()
      await rmWithRetry(runDir)
      return resolvedFrom
    }

    it("resolves a commitment's stated time in the person's own timezone, differently for two far-apart zones", async () => {
      // Asia/Kolkata (UTC+5:30) and Etc/GMT+12 (UTC-12, POSIX sign
      // reversed) are as far apart as the IANA database gets: for the
      // same UTC anchor they can never land on the same local calendar
      // day, so "tomorrow" resolved against each must differ.
      const kolkata = await resolvedDateFor('Asia/Kolkata')
      const farBehind = await resolvedDateFor('Etc/GMT+12')
      expect(kolkata).toBeDefined()
      expect(farBehind).toBeDefined()
      expect(kolkata).not.toBe(farBehind)
    })

    // Guards buildReflectionContext's own commitments wiring: deleting
    // `commitments,` from its return object makes this test fail while
    // reflection.test.ts's prompt test, which builds a ReflectionContext
    // literal directly, stays green.
    it("carries a commitment recorded in one session into the next session's reflection prompt", async () => {
      const firstOut: ReflectionOutput = {
        ...emptyReflectionOutput('Made a plan with Arjun.'),
        commitments: [{ label: 'See Nightfall with Arjun', flavor: 'plan' }],
      }
      const secondOut = emptyReflectionOutput('A quieter second session.')
      const chat = new FakeChatProvider([
        { text: JSON.stringify(firstOut), toolCalls: [] },
        { text: JSON.stringify(secondOut), toolCalls: [] },
      ])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const firstSessionId = await engine.startSession()
      await engine.appendTranscript(firstSessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Made a plan to see Nightfall with Arjun.',
      })
      await engine.endSession(firstSessionId)

      const graph = await readGraph(paths)
      const commitmentNode = [...graph.nodes.values()].find((n) => n.type === 'commitment')
      if (!commitmentNode) throw new Error('expected a commitment node from the first session')

      const secondSessionId = await engine.startSession()
      await engine.appendTranscript(secondSessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Nothing much today.',
      })
      await engine.endSession(secondSessionId)

      const secondPrompt = chat.requests[1]?.messages[0]?.content
      if (typeof secondPrompt !== 'string') {
        throw new Error('expected the second session to send a reflection prompt')
      }
      expect(secondPrompt).toContain(commitmentNode.id)
      expect(secondPrompt).toContain('See Nightfall with Arjun')

      await engine.close()
    })
  })

  describe('peopleDir indexing', () => {
    let dir: string
    let paths: MemoryPaths
    let engine: MemoryEngine

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-people-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
      engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    })

    afterEach(async () => {
      await engine.close()
      await rmWithRetry(dir)
    })

    it('reindexAll walks peopleDir and indexes person pages under kind person', async () => {
      const personDocId = newId('doc')
      const personDocPath = join(paths.peopleDir, 'sam.md')
      await writeDocumentAtomic(paths.files, {
        path: personDocPath,
        meta: { id: personDocId, name: 'Sam' },
        body: 'Sam is a close friend who shows up in a lot of stories about kayaking.\n',
      })

      await engine.reindexAll()

      const hits = (await engine.search('kayaking')).documents
      expect(hits.some((h) => h.docId === personDocId && h.kind === 'person')).toBe(true)

      const filteredHits = (await engine.search('kayaking', { kinds: ['person'] })).documents
      expect(filteredHits.some((h) => h.docId === personDocId)).toBe(true)
    })
  })

  describe('docIdForPath and graph_query docId', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-docid-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    it('resolves a doc path to its document id, and carries docId on graph nodes that have a doc but not on ones that do not', async () => {
      const arcDocId = newId('doc')
      const arcDocPath = join(paths.arcsDir, 'health.md')
      await writeDocumentAtomic(paths.files, {
        path: arcDocPath,
        meta: { id: arcDocId, name: 'Health', status: 'active' },
        body: 'Original arc narrative.\n',
      })
      const itemId = newId('item')
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'arc_health',
          type: 'arc',
          label: 'Health',
          doc: arcDocPath,
        },
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: itemId,
          type: 'item',
          label: 'Went for a run',
        },
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          edge: 'part_of',
          from: itemId,
          to: 'arc_health',
          confidence: 1,
          confirmed: true,
        },
      ])

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

      expect(engine.docIdForPath(arcDocPath)).toBe(arcDocId)

      const neighbors = engine.graphQuery({ kind: 'neighbors', nodeId: itemId }) as {
        edge: { edge: string }
        node: { id: string; docId?: string }
      }[]
      const arcNeighbor = neighbors.find((n) => n.node.id === 'arc_health')
      expect(arcNeighbor?.node.docId).toBe(arcDocId)

      // The item node itself carries no doc in this fixture, so it must
      // carry no docId either: docId is derived only from a present doc.
      const itemsInArc = engine.graphQuery({ kind: 'items_in_arc', arcId: 'arc_health' }) as {
        id: string
        docId?: string
      }[]
      expect(itemsInArc[0]?.docId).toBeUndefined()

      await engine.close()
    })
  })

  describe('endSession idempotency', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-idempotent-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    it('calling endSession twice on the same session reflects only once: one summary row, one reflection call, no duplicate search hits', async () => {
      const chat = new FakeChatProvider([
        {
          text: JSON.stringify(emptyReflectionOutput('Only one reflection should ever happen.')),
          toolCalls: [],
        },
      ])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const startedAt = new Date()
      const sessionId = await engine.startSession(startedAt)
      await engine.appendTranscript(sessionId, {
        ts: startedAt.toISOString(),
        role: 'user',
        content: 'A short session about a first item.',
      })

      await engine.endSession(sessionId)
      await engine.endSession(sessionId)

      expect(chat.requests).toHaveLength(1)

      // Query by path (not just kind), so a ghost row for the same
      // physical summary.md under a stale, different doc id would be
      // caught even if it happened to be outranked in the fused results.
      const summaryPath = join(
        paths.sessionsDir,
        `${formatLocalDate(startedAt, engine.timezone())}-${sessionId}`,
        'summary.md',
      )
      const hits = (await engine.search('reflection')).documents
      const summaryHits = hits.filter((h) => h.path === summaryPath)
      expect(summaryHits).toHaveLength(1)

      await engine.close()
    })

    it('endSession on an unknown sessionId returns without any side effects', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      await expect(engine.endSession('session_does_not_exist')).resolves.toBeUndefined()
      expect(chat.requests).toHaveLength(0)

      await engine.close()
    })
  })

  describe('reflection log (R4): durable attempt record', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-reflectionlog-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    it('a normal endSession records an attempt then a reflected outcome', async () => {
      const chat = new FakeChatProvider([
        { text: JSON.stringify(emptyReflectionOutput('All good.')), toolCalls: [] },
      ])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'A short session.',
      })
      await engine.endSession(sessionId)

      const records = await readReflectionLog(paths)
      expect(records).toEqual([
        expect.objectContaining({ type: 'attempt', session: sessionId, trigger: 'endSession' }),
        expect.objectContaining({ type: 'outcome', session: sessionId, outcome: 'reflected' }),
      ])

      // endSession's own idempotency guard returns early, before
      // _doEndSession, for a session it already finds reflected: a second
      // call must record nothing more. If the guard ever logged before
      // returning, this array would grow to 3 or 4 records and this same
      // assertion would fail.
      await engine.endSession(sessionId)
      expect(await readReflectionLog(paths)).toEqual(records)

      await engine.close()
    })

    it('a session with no user lines records an attempt then a skipped outcome', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'assistant',
        content: 'Good to see you.',
      })
      await engine.endSession(sessionId)

      const records = await readReflectionLog(paths)
      expect(records).toEqual([
        expect.objectContaining({ type: 'attempt', session: sessionId, trigger: 'endSession' }),
        expect.objectContaining({ type: 'outcome', session: sessionId, outcome: 'skipped' }),
      ])

      await engine.close()
    })

    it('a reflection that throws records a failed outcome with the error message and still rethrows; a retry accumulates a second attempt and then reflects', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('Started training for a marathon.'),
        items: [{ text: 'Went for a long run', kind: 'event' }],
        newArcs: [
          {
            name: 'Marathon Training',
            realm: 'Fitness',
            reason: 'mentioned training for a marathon',
            itemIndexes: [0],
            narrative: 'Training for a marathon this fall.',
          },
        ],
      }
      const chat = new FakeChatProvider([
        { text: JSON.stringify(out), toolCalls: [] },
        { text: JSON.stringify(out), toolCalls: [] },
      ])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Went for a long run, training for a marathon this fall.',
      })

      // Same permission trick the pre-R4 retry test above uses: createArc's
      // write, invoked as applyReflection's own materializeNew callback,
      // fails partway through endSession.
      await chmod(paths.arcsDir, 0o500)
      let thrown: unknown
      try {
        await engine.endSession(sessionId)
        throw new Error('expected endSession to reject')
      } catch (err) {
        thrown = err
      } finally {
        await chmod(paths.arcsDir, 0o700)
      }
      expect(thrown).toBeInstanceOf(Error)

      const afterFailure = await readReflectionLog(paths)
      expect(afterFailure).toHaveLength(2)
      expect(afterFailure[0]).toMatchObject({
        type: 'attempt',
        session: sessionId,
        trigger: 'endSession',
      })
      expect(afterFailure[1]).toMatchObject({
        type: 'outcome',
        session: sessionId,
        outcome: 'failed',
      })
      const failedRecord = afterFailure[1] as { reason?: string }
      // The recorded reason is the real error's own message, not a
      // placeholder: this is what a person or `reverie doctor` reads to
      // find out why, so it has to be the actual failure, not just proof
      // that something happened.
      expect(failedRecord.reason).toBe((thrown as Error).message)
      expect(failedRecord.reason?.length).toBeGreaterThan(0)

      const failedSession = (await engine.listStoredSessions()).find(
        (s) => s.sessionId === sessionId,
      )
      // The part that matters most (AGENTS.md's framing for this task):
      // a session with a failed attempt is never 'open', because session
      // resume treats 'open' as resumable, and a partial reflection may
      // already have materialized graph state from this transcript.
      expect(failedSession?.status).toBe('ended')
      expect(failedSession?.reflection).toMatchObject({ state: 'failed', attempts: 1 })
      expect(failedSession?.reflection.lastFailureReason).toBe((thrown as Error).message)

      // sessionReflectionState's own disk check must not change this
      // post-R4 path: no summary.md was ever written (the reflection
      // failed before one could be), so disk stays unreflected and the
      // failed outcome from the log still wins here too.
      expect(await engine.sessionReflectionState(sessionId)).toMatchObject({
        state: 'failed',
        attempts: 1,
      })

      // Retryable: with the permission restored, endSession on the same
      // sessionId succeeds, and attempts accumulates to 2 across the retry.
      await engine.endSession(sessionId)
      const afterRetry = await readReflectionLog(paths)
      expect(afterRetry.filter((r) => r.type === 'attempt')).toHaveLength(2)
      expect(afterRetry.at(-1)).toMatchObject({ type: 'outcome', outcome: 'reflected' })

      const reflectedSession = (await engine.listStoredSessions()).find(
        (s) => s.sessionId === sessionId,
      )
      expect(reflectedSession?.status).toBe('ended')
      expect(reflectedSession?.reflection).toMatchObject({ state: 'reflected', attempts: 2 })

      await engine.close()
    })

    it('runMaintenance still retries a failed session: two attempts recorded, the second reflected', async () => {
      const now = new Date()
      const twoDaysAgo = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2),
      )

      const staleStore = await SessionStore.start(paths, twoDaysAgo)
      await staleStore.appendLine(paths, {
        ts: twoDaysAgo.toISOString(),
        role: 'user',
        content: 'Went for a long run, training for a marathon this fall.',
      })

      const out: ReflectionOutput = {
        ...emptyReflectionOutput('Started training for a marathon.'),
        items: [{ text: 'Went for a long run', kind: 'event' }],
        newArcs: [
          {
            name: 'Marathon Training',
            realm: 'Fitness',
            reason: 'mentioned training for a marathon',
            itemIndexes: [0],
            narrative: 'Training for a marathon this fall.',
          },
        ],
      }
      const script = [{ text: JSON.stringify(out), toolCalls: [] }]
      const chat = new FakeChatProvider(script)

      await chmod(paths.arcsDir, 0o500)
      let engine: MemoryEngine
      try {
        engine = await MemoryEngine.open(dir, fakeDeps(chat))
      } finally {
        await chmod(paths.arcsDir, 0o700)
      }

      const afterFirstPass = (await readReflectionLog(paths)).filter(
        (r) => r.session === staleStore.sessionId,
      )
      expect(afterFirstPass.filter((r) => r.type === 'attempt')).toHaveLength(1)
      expect(afterFirstPass.at(-1)).toMatchObject({ type: 'outcome', outcome: 'failed' })

      script.push({ text: JSON.stringify(out), toolCalls: [] })
      await engine.runMaintenance()

      const afterRetry = (await readReflectionLog(paths)).filter(
        (r) => r.session === staleStore.sessionId,
      )
      expect(afterRetry.filter((r) => r.type === 'attempt')).toHaveLength(2)
      expect(afterRetry.at(-1)).toMatchObject({ type: 'outcome', outcome: 'reflected' })

      await engine.close()
    })

    it('a session with an attempt and no outcome after it reads in_progress, and status ended', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Reflection started elsewhere and never resolved.',
      })
      // Simulates a process that appended the attempt record and then
      // crashed before recording any outcome: nothing else in this test
      // ever calls endSession or runMaintenance for this session.
      await appendReflectionLog(paths, [
        {
          ts: new Date().toISOString(),
          type: 'attempt',
          session: sessionId,
          trigger: 'endSession',
        },
      ])

      const session = (await engine.listStoredSessions()).find((s) => s.sessionId === sessionId)
      expect(session?.reflection).toMatchObject({ state: 'in_progress', attempts: 1 })
      // 'in_progress' is not 'not_started', so this must not read 'open':
      // the durable record already shows an attempt was made.
      expect(session?.status).toBe('ended')

      // No summary.md exists yet, so sessionReflectionState's disk check
      // stays unreflected and this post-R4 path is unchanged: the pending
      // attempt still reads 'in_progress'.
      expect(await engine.sessionReflectionState(sessionId)).toMatchObject({
        state: 'in_progress',
        attempts: 1,
      })

      await engine.close()
    })

    it('a pre-existing session with no log records reads not_started and keeps status open (no migration needed)', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Never touched by reflection.',
      })

      const session = (await engine.listStoredSessions()).find((s) => s.sessionId === sessionId)
      expect(session?.reflection).toEqual({ state: 'not_started', attempts: 0 })
      expect(session?.status).toBe('open')

      // No summary.md either (unlike the upgrade case below), so disk
      // stays unreflected here too: genuinely not_started, not just
      // log-only not_started.
      expect(await engine.sessionReflectionState(sessionId)).toEqual({
        state: 'not_started',
        attempts: 0,
      })

      await engine.close()
    })

    // The bug: sessionReflectionState used to fold the reflection log only
    // and pass no disk argument to publicReflectionFrom, so a session that
    // was reflected before the reflection log existed (every session every
    // existing self-hosted user already has, the moment they upgrade to
    // this version) read 'not_started' here while listStoredSessions
    // correctly read 'reflected' from summary.md. 'not_started' is the
    // exact value listStoredSessions maps to status: 'open', which session
    // resume treats as resumable, so this was a wrong answer about a
    // resumable session, not a documented gap.
    it('a session reflected before the reflection log existed reads reflected here too, not not_started (the upgrade case)', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Reflected long before the reflection log existed.',
      })
      const sessionDir = await SessionStore.sessionDir(paths, sessionId)
      await writeFile(
        join(sessionDir, 'summary.md'),
        '---\nid: doc_x\n---\nA session summarized before R4 shipped.\n',
        'utf8',
      )

      // No reflection log record at all for this session: this is exactly
      // the upgrade state, not a contrived one.
      expect(await readReflectionLog(paths)).toEqual([])

      expect(await engine.sessionReflectionState(sessionId)).toEqual({
        state: 'reflected',
        attempts: 0,
      })

      await engine.close()
    })

    it('sessionReflectionState and listStoredSessions agree on the same session, including the pre-log upgrade case', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Reflected long before the reflection log existed.',
      })
      const sessionDir = await SessionStore.sessionDir(paths, sessionId)
      await writeFile(
        join(sessionDir, 'summary.md'),
        '---\nid: doc_x\n---\nA session summarized before R4 shipped.\n',
        'utf8',
      )

      const viaList = (await engine.listStoredSessions()).find((s) => s.sessionId === sessionId)
      const viaSingle = await engine.sessionReflectionState(sessionId)

      // Asserting agreement directly, not just the same fixed literal
      // twice: a future change to one derivation that does not change the
      // other fails here even if neither side's own expected value moves.
      expect(viaSingle).toEqual(viaList?.reflection)

      await engine.close()
    })

    it('a skipped pre-log session reads skipped through both listStoredSessions and sessionReflectionState', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'assistant',
        content: 'No user lines, and no reflection log record either.',
      })
      const sessionDir = await SessionStore.sessionDir(paths, sessionId)
      await writeFile(
        join(sessionDir, 'summary.md'),
        '---\nid: doc_x\nskipped: true\nreason: no user messages in this session\n---\nNothing happened.\n',
        'utf8',
      )

      const viaList = (await engine.listStoredSessions()).find((s) => s.sessionId === sessionId)
      expect(viaList?.reflection).toEqual({ state: 'skipped', attempts: 0 })

      const viaSingle = await engine.sessionReflectionState(sessionId)
      expect(viaSingle).toEqual({ state: 'skipped', attempts: 0 })

      await engine.close()
    })

    it('sessionReflectionState does not throw for an unknown session id, and reads not_started', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      // No directory for this id exists at all. Fail closed (AGENTS.md):
      // an unknown session has no reflection state to report, so this
      // reads the same as a session nobody has touched, never a fabricated
      // 'reflected' or 'skipped'.
      await expect(engine.sessionReflectionState('session_doesnotexist')).resolves.toEqual({
        state: 'not_started',
        attempts: 0,
      })

      await engine.close()
    })

    // sessionReflectionState now checks disk for this one session too (see
    // its own comment in engine.ts), so the previous log-only description
    // here is no longer accurate: it answers from the reflection log plus
    // one summary.md check for this session, never a transcript, because a
    // consumer benchmarked the full listStoredSessions scan (which reads
    // every session's transcript.jsonl) at 67ms for 200 sessions. Asserted
    // through a store fake that counts every readAll call's path, not by
    // timing: timing a fast in-memory call proves nothing about which
    // files it touched.
    it('sessionReflectionState reads no transcript, even when a real transcript exists on disk', async () => {
      const readAllCalls: string[] = []
      const stores = memoryStores()
      const countingLogs: AppendOnlyStore = {
        create: (path) => stores.logs.create(path),
        appendLines: (path, lines) => stores.logs.appendLines(path, lines),
        readAll: async (path) => {
          readAllCalls.push(path)
          return stores.logs.readAll(path)
        },
        readRange: (path, from, count) => stores.logs.readRange(path, from, count),
      }
      const testPaths = memoryPaths('/reverie', { files: stores.files, logs: countingLogs })
      const index = MemoryIndex.open(':memory:')
      const engine = await MemoryEngine.fromPaths(
        testPaths,
        index,
        fakeDeps(new FakeChatProvider([])),
        { maintenance: false },
      )

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'A real transcript line, never to be read by sessionReflectionState.',
      })
      await appendReflectionLog(testPaths, [
        {
          ts: new Date().toISOString(),
          type: 'attempt',
          session: sessionId,
          trigger: 'endSession',
        },
      ])

      readAllCalls.length = 0
      const state = await engine.sessionReflectionState(sessionId)

      expect(state).toEqual({
        state: 'in_progress',
        attempts: 1,
        lastAttemptAt: expect.any(String),
      })
      expect(readAllCalls.some((path) => path.includes('transcript'))).toBe(false)
      expect(readAllCalls).toContain(testPaths.reflectionLog)

      await engine.close()
    })
  })

  describe('malformed documents do not brick the engine', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-corrupt-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    it('opens past a corrupt arc file, warns with its path, and still lets reindexAll succeed', async () => {
      const corruptPath = join(paths.arcsDir, 'broken.md')
      // Unterminated YAML flow collection: readDocument throws on this,
      // and before the fix, listDocuments aborted the whole walk on the
      // first such failure, which made MemoryEngine.open throw too.
      await writeFile(corruptPath, '---\nname: [unterminated\n---\nbody\n', 'utf8')

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

      // open() itself must have surfaced the skip as a warning naming the
      // file, not swallowed it: refreshDocPaths runs its doc walk as the
      // last step of open() specifically so this warning survives.
      expect(engine.warnings.some((w) => w.includes(corruptPath))).toBe(true)

      // reindex, the documented repair tool, must still work with the
      // engine open, not just after deleting the corrupt file by hand.
      await expect(engine.reindexAll()).resolves.toBeUndefined()
      expect(engine.warnings.some((w) => w.includes(corruptPath))).toBe(true)

      await engine.close()
    })

    it('readDocument called directly on the corrupt file still throws, naming the path', async () => {
      const corruptPath = join(paths.arcsDir, 'broken.md')
      await writeFile(corruptPath, '---\nname: [unterminated\n---\nbody\n', 'utf8')

      await expect(readDocument(paths.files, corruptPath)).rejects.toThrow(corruptPath)
    })
  })

  describe('reindexAll true full rebuild', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-reindex-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    it('drops rows for documents whose source file was deleted, not just upserts current ones', async () => {
      const tempRealmDocId = newId('doc')
      const tempRealmPath = join(paths.realmsDir, 'temp-realm.md')
      await writeDocumentAtomic(paths.files, {
        path: tempRealmPath,
        meta: { id: tempRealmDocId, name: 'Temp Realm' },
        body: 'A realm about kayaking expeditions.\n',
      })

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      await engine.reindexAll()

      const hitsBeforeDelete = (await engine.search('kayaking')).documents
      expect(hitsBeforeDelete.some((h) => h.docId === tempRealmDocId)).toBe(true)

      await rm(tempRealmPath)
      await engine.reindexAll()

      // The orphaned row for the deleted file must be gone, not just
      // out-ranked: a vector-search fallback can still surface unrelated
      // documents for any query, so absence of the specific docId is the
      // correct assertion, not an empty result set.
      const hitsAfterDelete = (await engine.search('kayaking')).documents
      expect(hitsAfterDelete.some((h) => h.docId === tempRealmDocId)).toBe(false)

      await engine.close()
    })
  })

  describe('sessionContext', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-context-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    it('includes only active arcs, alongside the constitution text', async () => {
      const activeArcId = 'arc_active'
      const dormantArcId = 'arc_dormant'
      const activeArcPath = join(paths.arcsDir, 'active-arc.md')
      const dormantArcPath = join(paths.arcsDir, 'dormant-arc.md')
      await writeDocumentAtomic(paths.files, {
        path: activeArcPath,
        meta: { id: newId('doc'), name: 'Active Arc', status: 'active' },
        body: 'Still going.\n',
      })
      await writeDocumentAtomic(paths.files, {
        path: dormantArcPath,
        meta: { id: newId('doc'), name: 'Dormant Arc', status: 'dormant' },
        body: 'On pause.\n',
      })
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: activeArcId,
          type: 'arc',
          label: 'Active Arc',
          doc: activeArcPath,
        },
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: dormantArcId,
          type: 'arc',
          label: 'Dormant Arc',
          doc: dormantArcPath,
        },
      ])

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

      // Appended after open(), not before: a proposal present at open time
      // is drained silently now (see 'materializes a pre-existing pending
      // proposal silently on open...' above). Appending it here instead
      // proves sessionContext no longer touches proposals.jsonl at all
      // (there is no field on SessionContext to render it into any more):
      // the file itself still carries it, untouched by sessionContext.
      const proposal: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'link',
        summary: 'Pending link proposal for the context test.',
        payload: { edge: 'part_of', from: newId('item'), to: activeArcId, confidence: 0.5 },
        source: 'session_seed',
      }
      await appendProposals(paths, [proposal], 'UTC')

      const context = await engine.sessionContext()

      expect(context.arcs.map((a) => a.id)).toEqual([activeArcId])
      expect(context.arcs[0]?.status).toBe('active')
      expect(context.constitution.length).toBeGreaterThan(0)

      const stillPending = await pendingProposals(paths)
      expect(stillPending.map((p) => p.id)).toContain(proposal.id)

      await engine.close()
    })

    // Task 10's insights and opener both fold dreams/log.jsonl. readDreamLog
    // zod-parses every line and throws on the first bad one, which is
    // correct for that function (see dreamLog.ts). Before this fix,
    // sessionContext called it with no try/catch, so a torn append or a
    // hand-edited log line took the whole method down with it, and with it
    // every session start (chat and CLI alike): a person must always be
    // able to start a conversation, dreaming feature or not.
    it('degrades to no dream insights and no fresh dream when dreams/log.jsonl has a garbage line, instead of throwing', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      await mkdir(paths.dreamsDir, { recursive: true })
      await writeFile(paths.dreamLog, 'not valid json\n', 'utf8')

      const context = await engine.sessionContext()

      expect(context.dreamInsights).toEqual([])
      expect(context.freshDream).toBeUndefined()

      await engine.close()
    })
  })

  describe('sessionContext people, entities, and recent intentions', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-people-context-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    it('includes every person node, marking whether each one has a page', async () => {
      const pagedPath = join(paths.peopleDir, 'priya.md')
      await writeDocumentAtomic(paths.files, {
        path: pagedPath,
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
          doc: pagedPath,
        },
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'person_nodeonly',
          type: 'person',
          label: 'Sam',
        },
      ])

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const context = await engine.sessionContext()

      expect(context.people).toEqual(
        expect.arrayContaining([
          { id: 'person_paged', name: 'Priya', hasPage: true },
          { id: 'person_nodeonly', name: 'Sam', hasPage: false },
        ]),
      )
      expect(context.peopleTruncated).toBe(false)
      expect(context.peopleTotal).toBe(2)

      await engine.close()
    })

    it('includes every entity node by name, with no page field at all', async () => {
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'entity_1',
          type: 'entity',
          label: 'Dune',
        },
      ])

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const context = await engine.sessionContext()

      expect(context.entities).toEqual([{ id: 'entity_1', name: 'Dune' }])
      expect(context.entitiesTruncated).toBe(false)
      expect(context.entitiesTotal).toBe(1)

      await engine.close()
    })

    it('caps people at 40, keeping paged people over unpaged ones and, within each, the most recently created', async () => {
      // 5 paged people, oldest first, plus 40 unpaged people, oldest
      // first: 45 total, 5 over PEOPLE_CAP. All 5 paged must survive the
      // cut (paged is kept over unpaged), and the 35 most recent of the 40
      // unpaged ones fill the remaining slots, dropping the 5 oldest
      // unpaged people.
      const records: Parameters<typeof appendGraph>[1] = []
      for (let i = 0; i < 5; i++) {
        records.push({
          ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
          op: 'assert',
          node: `person_paged_${i}`,
          type: 'person',
          label: `Paged ${i}`,
          doc: join(paths.peopleDir, `paged-${i}.md`),
        })
      }
      for (let i = 0; i < 40; i++) {
        records.push({
          ts: `2026-02-01T00:${String(i).padStart(2, '0')}:00.000Z`,
          op: 'assert',
          node: `person_unpaged_${i}`,
          type: 'person',
          label: `Unpaged ${i}`,
        })
      }
      await appendGraph(paths, records)

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const context = await engine.sessionContext()

      expect(context.people).toHaveLength(40)
      expect(context.peopleTruncated).toBe(true)
      expect(context.peopleTotal).toBe(45)
      for (let i = 0; i < 5; i++) {
        expect(context.people.some((p) => p.id === `person_paged_${i}`)).toBe(true)
      }
      // The 5 oldest unpaged people (indexes 0 through 4) are dropped; the
      // 35 most recent (indexes 5 through 39) survive.
      for (let i = 0; i < 5; i++) {
        expect(context.people.some((p) => p.id === `person_unpaged_${i}`)).toBe(false)
      }
      for (let i = 5; i < 40; i++) {
        expect(context.people.some((p) => p.id === `person_unpaged_${i}`)).toBe(true)
      }

      await engine.close()
    })

    it('caps entities at 30, keeping the most recently created and dropping the oldest', async () => {
      const records: Parameters<typeof appendGraph>[1] = []
      for (let i = 0; i < 35; i++) {
        records.push({
          ts: `2026-02-01T00:${String(i).padStart(2, '0')}:00.000Z`,
          op: 'assert',
          node: `entity_${i}`,
          type: 'entity',
          label: `Entity ${i}`,
        })
      }
      await appendGraph(paths, records)

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const context = await engine.sessionContext()

      expect(context.entities).toHaveLength(30)
      expect(context.entitiesTruncated).toBe(true)
      expect(context.entitiesTotal).toBe(35)
      // The 5 oldest (indexes 0 through 4) are dropped; the 30 most
      // recent (indexes 5 through 34) survive.
      for (let i = 0; i < 5; i++) {
        expect(context.entities.some((e) => e.id === `entity_${i}`)).toBe(false)
      }
      for (let i = 5; i < 35; i++) {
        expect(context.entities.some((e) => e.id === `entity_${i}`)).toBe(true)
      }

      await engine.close()
    })

    it('pulls intention item texts out of recent session summaries, skipping other kinds', async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const store = await SessionStore.start(paths, yesterday)
      await store.appendLine(paths, { ts: yesterday.toISOString(), role: 'user', content: 'Hi.' })
      await writeDocumentAtomic(paths.files, {
        path: join(store.dir, 'summary.md'),
        meta: {
          id: newId('doc'),
          items: [
            { id: newId('item'), text: 'Call the dentist next week.', kind: 'intention', ts: '' },
            { id: newId('item'), text: 'Felt tired all day.', kind: 'feeling', ts: '' },
          ],
        },
        body: 'A quiet day.\n',
      })

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const context = await engine.sessionContext()

      expect(context.recentIntentions).toEqual([
        { text: 'Call the dentist next week.', date: formatLocalDate(yesterday, 'UTC') },
      ])

      await engine.close()
    })

    it("carries an intention item's stated eventTime into recentIntentions when present", async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const store = await SessionStore.start(paths, yesterday)
      await store.appendLine(paths, { ts: yesterday.toISOString(), role: 'user', content: 'Hi.' })
      await writeDocumentAtomic(paths.files, {
        path: join(store.dir, 'summary.md'),
        meta: {
          id: newId('doc'),
          items: [
            {
              id: newId('item'),
              text: 'See Nightfall with Arjun.',
              kind: 'intention',
              ts: '',
              eventTime: 'this evening',
            },
          ],
        },
        body: 'A quiet day.\n',
      })

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const context = await engine.sessionContext()

      expect(context.recentIntentions).toEqual([
        {
          text: 'See Nightfall with Arjun.',
          date: formatLocalDate(yesterday, 'UTC'),
          eventTime: 'this evening',
        },
      ])

      await engine.close()
    })

    it("tolerates a hand-written summary.md carrying eventTime: '' at both read boundaries (Ruling 11): no anchor in the search index, no eventTime in recentIntentions", async () => {
      // Unlike the write-site tests below, this never goes through
      // engine.remember() at all: it writes the frontmatter directly,
      // the same way a summary.md from before the write-site fixes
      // (commit 1f602e7), or a hand-edited one, exists on a real disk.
      // AGENTS.md: the memory folder is truth and SQLite is a derived
      // index rebuildable from it, so this is the untrusted-input case
      // the write-site fixes alone cannot cover.
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const store = await SessionStore.start(paths, yesterday)
      await store.appendLine(paths, { ts: yesterday.toISOString(), role: 'user', content: 'Hi.' })
      await writeDocumentAtomic(paths.files, {
        path: join(store.dir, 'summary.md'),
        meta: {
          id: newId('doc'),
          date: formatLocalDate(yesterday, 'UTC'),
          items: [
            {
              id: newId('item'),
              text: 'Watching Zephyrquest',
              kind: 'intention',
              ts: '',
              eventTime: '',
            },
          ],
        },
        body: 'A quiet day.\n',
      })

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      // reindexAll is the path that actually walks this file into the
      // search index (sqlite.ts:itemChunkText); sessionContext reads the
      // frontmatter directly and needs no reindex.
      await engine.reindexAll()

      const hits = (await engine.search('Zephyrquest')).documents
      expect(hits.length).toBeGreaterThan(0)
      const snippet = hits[0]?.snippet ?? ''
      expect(snippet).not.toContain('eventTime')
      expect(snippet).not.toContain('as stated on')

      const context = await engine.sessionContext()
      const intention = context.recentIntentions.find((i) => i.text === 'Watching Zephyrquest')
      expect(intention).toBeDefined()
      expect('eventTime' in (intention ?? {})).toBe(false)

      await engine.close()
    })

    it.each([
      ['empty string', ''],
      ['whitespace-only', '   '],
    ])(
      'remember normalizes a %s eventTime to absent: no eventTime key in the summary, no anchor in the indexed chunk, no eventTime in recentIntentions',
      async (_label, eventTime) => {
        const chat = new FakeChatProvider([
          { text: JSON.stringify(emptyReflectionOutput('A quiet check-in.')), toolCalls: [] },
        ])
        const engine = await MemoryEngine.open(dir, fakeDeps(chat))
        const startedAt = new Date()
        const sessionId = await engine.startSession(startedAt)
        await engine.appendTranscript(sessionId, {
          ts: startedAt.toISOString(),
          role: 'user',
          content: 'Just checking in.',
        })

        // Called directly, bypassing tools.ts's schema entirely, so this
        // proves the write-site normalization in engine.remember() itself,
        // not just the schema layer in front of it.
        await engine.remember(
          sessionId,
          'See Nightfall with Arjun, unstated time',
          'intention',
          eventTime,
        )

        await engine.endSession(sessionId)

        const summaryPath = join(
          paths.sessionsDir,
          `${formatLocalDate(startedAt, engine.timezone())}-${sessionId}`,
          'summary.md',
        )
        const summaryDoc = await readDocument(paths.files, summaryPath)
        const items = summaryDoc.meta.items as { text: string; eventTime?: string }[]
        const item = items.find((i) => i.text === 'See Nightfall with Arjun, unstated time')
        expect(item).toBeDefined()
        expect('eventTime' in (item ?? {})).toBe(false)

        // No fabricated anchor in the indexed chunk: itemChunkText only
        // appends the "(eventTime: ..., as stated on ...)" anchor when
        // eventTime is present, so its absence here is the assertion.
        const hits = (await engine.search('Nightfall')).documents
        expect(hits.length).toBeGreaterThan(0)
        const snippet = hits[0]?.snippet ?? ''
        expect(snippet).not.toContain('eventTime')
        expect(snippet).not.toContain('as stated on')

        // No parenthetical possible in the rendered prompt either: the
        // object context.ts renders from has no eventTime key to render.
        const context = await engine.sessionContext()
        const intention = context.recentIntentions.find(
          (i) => i.text === 'See Nightfall with Arjun, unstated time',
        )
        expect(intention).toBeDefined()
        expect('eventTime' in (intention ?? {})).toBe(false)

        await engine.close()
      },
    )

    it('tolerates a hand-written summary.md with no items key at all, in the same recentSummaries window', async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const store = await SessionStore.start(paths, yesterday)
      await store.appendLine(paths, { ts: yesterday.toISOString(), role: 'user', content: 'Hi.' })
      await writeDocumentAtomic(paths.files, {
        path: join(store.dir, 'summary.md'),
        meta: { id: newId('doc') },
        body: 'A quiet day, written by hand.\n',
      })

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const context = await engine.sessionContext()

      expect(context.recentIntentions).toEqual([])

      await engine.close()
    })
  })

  describe('MemoryEngine.recordCommitment: the live-tool timing write site', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-commitment-timing-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    it.each([
      ['empty string', ''],
      ['whitespace-only', '   '],
    ])(
      'never fabricates a timing block from a %s statedTime, called directly (Important 4, second site)',
      async (_label, statedTime) => {
        // Calls engine.recordCommitment directly, bypassing tools.ts's
        // statedTimeField schema entirely, so this proves the write-site
        // normalization inside MemoryEngine's own private
        // buildCommitmentTiming, not just the schema layer in front of it.
        // Before this normalization existed, this call wrote a timing
        // block with no words in it (`{ words: '', anchor: <now> }`),
        // which context.ts would render as `(said <today>: "")`.
        const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
        const sessionId = await engine.startSession()

        const recorded = await engine.recordCommitment(sessionId, {
          label: 'Start swimming',
          flavor: 'plan',
          statedTime,
        })

        expect(recorded.timing).toBeUndefined()

        await engine.close()
      },
    )
  })

  describe('sessionContext commitments', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-commitments-context-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    it('carries an eligible commitment with its own words, the local date it was said, and its gloss, with no field to carry a bracket', async () => {
      await recordCommitment(
        paths,
        {
          label: 'Start swimming again',
          flavor: 'plan',
          sessionId: 'session_test',
          timing: {
            words: 'come summer',
            anchor: '2026-08-13T09:00:00.000Z',
            interpretation: {
              statedPrecision: 'period',
              gloss: 'Summer where they live runs roughly February to May.',
              bracketFrom: '2027-02-01',
              bracketTo: '2027-05-31',
              interpretationConfidence: 'medium',
            },
          },
        },
        new Date(),
      )

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      // 2027-01-10 is inside the period lead window (30 days before the
      // 2027-02-01 bracket opens, i.e. eligible from 2027-01-02).
      const context = await engine.sessionContext(new Date('2027-01-10T00:00:00.000Z'))

      expect(context.commitments).toEqual([
        {
          label: 'Start swimming again',
          words: 'come summer',
          date: '2026-08-13',
          gloss: 'Summer where they live runs roughly February to May.',
        },
      ])

      await engine.close()
    })

    it("reads the date said in the person's own local timezone, not the UTC date the anchor's ISO string starts with", async () => {
      // 2026-08-13T20:30:00.000Z is already 2026-08-14 local time in
      // Asia/Kolkata (UTC+5:30). A test pinned to UTC cannot distinguish
      // "converted to local time" from "read the ISO date prefix off the
      // anchor directly": both would print 2026-08-13. Pinning a non-UTC
      // zone and crossing the local day boundary is the only way to make
      // the two implementations disagree.
      const profile = await loadProfile(paths, 'UTC')
      await writeProfile(paths, {
        meta: { ...profile.meta, timezone: 'Asia/Kolkata', timezoneSource: 'user-confirmed' },
        body: profile.body,
      })
      await recordCommitment(
        paths,
        {
          label: 'Call the dentist',
          flavor: 'errand',
          sessionId: 'session_test',
          // A resolved window is required for eligibility (Important 8): an
          // unresolved, unglossed timing has no bracket to be eligible
          // through. 2026-08-14 is the local day the commitment is said on
          // (the property this test is actually about), and also the local
          // "today" of the sessionContext call below, so the window is open.
          timing: {
            words: 'tomorrow',
            anchor: '2026-08-13T20:30:00.000Z',
            resolved: { from: '2026-08-14', to: '2026-08-14', statedPrecision: 'day' },
          },
        },
        new Date(),
      )

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const context = await engine.sessionContext(new Date('2026-08-14T00:00:00.000Z'))

      expect(context.commitments).toEqual([
        { label: 'Call the dentist', words: 'tomorrow', date: '2026-08-14' },
      ])

      await engine.close()
    })

    it('excludes a commitment with no timing at all: spec Section 4 defines eligibility only in terms of a bracket', async () => {
      // Important 8: an untimed ("someday") commitment has no bracket and
      // can never fall within one, or within a lead time before one, so it
      // is never eligible through this standing, always-rendered section.
      // Nothing else in the live companion surfaces it either (see
      // BACKLOG.md): it stays invisible to the live conversation, though
      // reflection still sees it, uncapped, at session end.
      await recordCommitment(
        paths,
        {
          label: 'Do something, someday',
          flavor: 'errand',
          sessionId: 'session_test',
        },
        new Date(),
      )

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const context = await engine.sessionContext()

      expect(context.commitments).toEqual([])

      await engine.close()
    })

    it('excludes a commitment not yet inside its eligible window', async () => {
      await recordCommitment(
        paths,
        {
          label: 'Start swimming again',
          flavor: 'plan',
          sessionId: 'session_test',
          timing: {
            words: 'come summer',
            anchor: '2026-08-13T09:00:00.000Z',
            interpretation: {
              statedPrecision: 'period',
              gloss: 'Summer where they live runs roughly February to May.',
              bracketFrom: '2027-02-01',
              bracketTo: '2027-05-31',
              interpretationConfidence: 'medium',
            },
          },
        },
        new Date(),
      )

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const context = await engine.sessionContext(new Date('2026-09-01T00:00:00.000Z'))

      expect(context.commitments).toEqual([])

      await engine.close()
    })

    it('excludes a quiet commitment even when its window is eligible', async () => {
      // Carries a real, currently-eligible timing so this test actually
      // exercises the quiet filter: an untimed commitment would be
      // excluded anyway (see the untimed test above), which would make
      // this pass for the wrong reason.
      const recorded = await recordCommitment(
        paths,
        {
          label: 'Call the dentist',
          flavor: 'errand',
          sessionId: 'session_test',
          timing: {
            words: 'today',
            anchor: '2026-08-14T09:00:00.000Z',
            resolved: { from: '2026-08-14', to: '2026-08-14', statedPrecision: 'day' },
          },
        },
        new Date(),
      )
      await resolveCommitment(paths, recorded.id, 'quiet', new Date())

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const context = await engine.sessionContext(new Date('2026-08-14T00:00:00.000Z'))

      expect(context.commitments).toEqual([])

      await engine.close()
    })

    it('excludes a resolved commitment (done or dropped) even when its window is eligible', async () => {
      // Critical 1: the allow-list fix. A resolved commitment must not
      // keep loading into the prompt after the model has recorded an
      // outcome for it.
      const recorded = await recordCommitment(
        paths,
        {
          label: 'Call the dentist',
          flavor: 'errand',
          sessionId: 'session_test',
          timing: {
            words: 'today',
            anchor: '2026-08-14T09:00:00.000Z',
            resolved: { from: '2026-08-14', to: '2026-08-14', statedPrecision: 'day' },
          },
        },
        new Date(),
      )
      await resolveCommitment(paths, recorded.id, 'done', new Date())

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const context = await engine.sessionContext(new Date('2026-08-14T00:00:00.000Z'))

      expect(context.commitments).toEqual([])

      await engine.close()
    })
  })

  describe('sessionContext recentSummaries', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-recent-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    async function reflectedSessionOn(date: Date, body: string): Promise<void> {
      const store = await SessionStore.start(paths, date)
      await store.appendLine(paths, { ts: date.toISOString(), role: 'user', content: body })
      await writeDocumentAtomic(paths.files, {
        path: join(store.dir, 'summary.md'),
        meta: { id: newId('doc') },
        body: `${body}\n`,
      })
    }

    it('includes a session dated exactly seven days ago and excludes one dated eight days ago', async () => {
      const now = new Date()
      const sevenDaysAgo = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 7),
      )
      const eightDaysAgo = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 8),
      )
      await reflectedSessionOn(sevenDaysAgo, 'Right at the edge of the window.')
      await reflectedSessionOn(eightDaysAgo, 'One day too old for the window.')

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const context = await engine.sessionContext(now)

      const bodies = context.recentSummaries.map((s) => s.body.trim())
      expect(bodies).toContain('Right at the edge of the window.')
      expect(bodies).not.toContain('One day too old for the window.')

      await engine.close()
    })

    it('caps recentSummaries at three, keeping the three most recent and dropping the oldest', async () => {
      const now = new Date()
      const daysAgo = (n: number) =>
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - n))

      await reflectedSessionOn(daysAgo(1), 'Most recent.')
      await reflectedSessionOn(daysAgo(2), 'Second most recent.')
      await reflectedSessionOn(daysAgo(3), 'Third most recent.')
      await reflectedSessionOn(daysAgo(4), 'Oldest, should be dropped.')

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const context = await engine.sessionContext(now)

      expect(context.recentSummaries).toHaveLength(3)
      expect(context.recentSummaries.map((s) => s.body.trim())).toEqual([
        'Most recent.',
        'Second most recent.',
        'Third most recent.',
      ])

      await engine.close()
    })

    it('orders recentSummaries most recent first', async () => {
      const now = new Date()
      const threeDaysAgo = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3),
      )
      const oneDayAgo = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
      )
      await reflectedSessionOn(threeDaysAgo, 'The older of the two.')
      await reflectedSessionOn(oneDayAgo, 'The more recent of the two.')

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const context = await engine.sessionContext(now)

      expect(context.recentSummaries.map((s) => s.body.trim())).toEqual([
        'The more recent of the two.',
        'The older of the two.',
      ])

      await engine.close()
    })

    it('excludes an unreflected session even when its date falls inside the window', async () => {
      const now = new Date()
      const twoDaysAgo = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2),
      )
      const store = await SessionStore.start(paths, twoDaysAgo)
      await store.appendLine(paths, {
        ts: twoDaysAgo.toISOString(),
        role: 'user',
        content: 'Never reflected.',
      })
      // No summary.md written: this session stays unreflected.

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const context = await engine.sessionContext(now)

      expect(context.recentSummaries).toHaveLength(0)

      await engine.close()
    })

    it('excludes a skipped session even when its date falls inside the window', async () => {
      const now = new Date()
      const twoDaysAgo = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2),
      )
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      // A greeting-only session, ended with no user line: this is the
      // exact shape a proactive greeting followed by an abandoned session
      // produces, reflected via the real skip path (not hand-written),
      // so this test fails if listSessions or the recentSummaries filter
      // ever stops reading the skipped flag it depends on.
      const store = await SessionStore.start(paths, twoDaysAgo)
      await store.appendLine(paths, {
        ts: twoDaysAgo.toISOString(),
        role: 'assistant',
        content: 'Good to see you.',
      })
      await engine.endSession(store.sessionId)

      const context = await engine.sessionContext(now)

      expect(context.recentSummaries).toHaveLength(0)

      await engine.close()
    })
  })

  describe('sessionContext isFirstSession', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-firstsession-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    it('is true on a completely fresh memory folder with no reflected sessions and no arcs', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

      const context = await engine.sessionContext()

      expect(context.isFirstSession).toBe(true)

      await engine.close()
    })

    it('is not turned false merely by starting a new, still-unreflected session', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Hello there.',
      })

      const context = await engine.sessionContext()

      expect(context.isFirstSession).toBe(true)

      await engine.close()
    })

    it('is false once a session has been reflected', async () => {
      const chat = new FakeChatProvider([
        { text: JSON.stringify(emptyReflectionOutput('A quiet first hello.')), toolCalls: [] },
      ])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'user',
        content: 'Hello there.',
      })
      await engine.endSession(sessionId)

      const context = await engine.sessionContext()

      expect(context.isFirstSession).toBe(false)

      await engine.close()
    })

    it('stays true after a session that was skipped (greeting only, no user message)', async () => {
      // The exact scenario this guards: a user opens the app once, the
      // proactive greeting streams, and they close it without ever
      // typing anything. That session is skipped, not reflected, and
      // must not cost this person their guided first-conversation flow
      // the next time they actually do open up.
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const sessionId = await engine.startSession()
      await engine.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        role: 'assistant',
        content: 'Good to see you.',
      })
      await engine.endSession(sessionId)

      const context = await engine.sessionContext()

      expect(context.isFirstSession).toBe(true)

      await engine.close()
    })

    it('is false when an arc exists, even a dormant one, with no reflected sessions', async () => {
      const dormantArcPath = join(paths.arcsDir, 'dormant-arc.md')
      await writeDocumentAtomic(paths.files, {
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

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

      const context = await engine.sessionContext()

      expect(context.isFirstSession).toBe(false)

      await engine.close()
    })
  })

  describe('sessionContext journalingProtocol', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-journalctx-'))
      paths = memoryPaths(dir, nodeStores())
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('leaves journalingProtocol undefined and never reads journaling.md when mode is not journal', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      await engine.startSession()
      const context = await engine.sessionContext(new Date(), 'general')
      expect(context.journalingProtocol).toBeUndefined()
      await engine.close()
    })

    it('leaves journalingProtocol undefined when sessionContext is called with no mode at all', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      await engine.startSession()
      const context = await engine.sessionContext()
      expect(context.journalingProtocol).toBeUndefined()
      await engine.close()
    })

    it('holds the ABSENT sentinel when mode is journal and journaling.md does not exist', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      await engine.startSession()
      const context = await engine.sessionContext(new Date(), 'journal')
      expect(context.journalingProtocol).toContain('has never set up journal mode before')
      await engine.close()
    })

    it('holds the trimmed journaling.md body when mode is journal and the file exists', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      await writeDocumentAtomic(paths.files, {
        path: paths.journaling,
        meta: { id: 'doc_01JZZZ', kind: 'journaling', updated: '2026-08-16T21:04:00.000Z' },
        body: 'Gratitude, three times a week.\n',
      })
      await engine.startSession()
      const context = await engine.sessionContext(new Date(), 'journal')
      expect(context.journalingProtocol).toBe('Gratitude, three times a week.')
      await engine.close()
    })
  })

  describe('warnings', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-warnings-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
      await pinTimezoneUtc(paths)
    })

    afterEach(async () => {
      await rmWithRetry(dir)
    })

    it('surfaces a commitMemory failure as a warning after runMaintenance instead of swallowing it silently', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      expect(engine.warnings).toEqual([])

      // Break git so every future commitMemory call fails: replace the
      // .git directory with a plain file, which makes `git init` itself
      // refuse to run on the next commit attempt.
      await rm(join(paths.root, '.git'), { recursive: true, force: true })
      await writeFile(join(paths.root, '.git'), 'not a real git directory', 'utf8')

      await engine.runMaintenance()

      expect(engine.warnings.length).toBeGreaterThan(0)
      expect(engine.warnings.some((w) => w.includes('git commit failed'))).toBe(true)

      await engine.close()
    })

    it('runMaintenance over two stale sessions that both produce warnings keeps warnings from both', async () => {
      const now = new Date()
      const threeDaysAgo = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3),
      )
      const twoDaysAgo = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2),
      )

      // Provide scripted reflections for both sessions plus rollups.
      const chat = new FakeChatProvider([
        {
          text: JSON.stringify(emptyReflectionOutput('First session reflected.')),
          toolCalls: [],
        },
        {
          text: JSON.stringify(emptyReflectionOutput('Second session reflected.')),
          toolCalls: [],
        },
        { text: 'Daily rollup prose for date 1.', toolCalls: [] },
        { text: 'Daily rollup prose for date 2.', toolCalls: [] },
      ])
      const deps = fakeDeps(chat)

      // Open the engine with good git so it can initialize cleanly.
      const engine = await MemoryEngine.open(dir, deps)
      expect(engine.warnings).toEqual([])

      // Break git so commitMemory warnings are generated for each session.
      await rm(join(paths.root, '.git'), { recursive: true, force: true })
      await writeFile(join(paths.root, '.git'), 'not a real git directory', 'utf8')

      // Create two stale sessions AFTER breaking git, so they will be
      // reflected in the next runMaintenance call with git broken.
      const staleStore1 = await SessionStore.start(paths, threeDaysAgo)
      await staleStore1.appendLine(paths, {
        ts: threeDaysAgo.toISOString(),
        role: 'user',
        content: 'First stale session.',
      })

      const staleStore2 = await SessionStore.start(paths, twoDaysAgo)
      await staleStore2.appendLine(paths, {
        ts: twoDaysAgo.toISOString(),
        role: 'user',
        content: 'Second stale session.',
      })

      // runMaintenance should accumulate warnings from both sessions' commits failing.
      await engine.runMaintenance(now)

      // Expect at least 2 warnings (one from each session's commit failure).
      expect(engine.warnings.length).toBeGreaterThanOrEqual(2)
      const sessionWarnings = engine.warnings.filter((w) => w.includes('git commit failed'))
      expect(sessionWarnings.length).toBeGreaterThanOrEqual(2)

      await engine.close()
    })

    it('no-op endSession on an already-reflected session leaves existing warnings unchanged', async () => {
      const chat = new FakeChatProvider([
        {
          text: JSON.stringify(emptyReflectionOutput('Will be reflected once.')),
          toolCalls: [],
        },
      ])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const startedAt = new Date()
      const sessionId = await engine.startSession(startedAt)
      await engine.appendTranscript(sessionId, {
        ts: startedAt.toISOString(),
        role: 'user',
        content: 'A session to reflect.',
      })

      // First endSession: reflects the session.
      await engine.endSession(sessionId)
      expect(engine.warnings).toEqual([])

      // Manually set a warning to verify it persists.
      engine.warnings.push('Manually added warning')
      expect(engine.warnings).toEqual(['Manually added warning'])

      // Second endSession: should be a no-op (already reflected) and must
      // not clear warnings.
      await engine.endSession(sessionId)
      expect(engine.warnings).toEqual(['Manually added warning'])

      await engine.close()
    })

    // Engine-level probe for the resolveNarratives containment fix: a page
    // the user hand-deleted, with its graph node and doc pointer still
    // live, must not abort reflection. This proves both halves of that fix
    // at the engine boundary, not just at resolveNarratives/applyReflection
    // directly: the session actually ends up reflected, and the onFailure
    // callback wired in engine.ts actually reaches engine.warnings, naming
    // the arc, rather than being dropped or left untested.
    it('reflects a session and records a warning naming the arc when its page was hand-deleted before endSession runs', async () => {
      const arcDocPath = join(paths.arcsDir, 'health.md')
      await writeDocumentAtomic(paths.files, {
        path: arcDocPath,
        meta: { id: newId('doc'), name: 'Health' },
        body: 'Original arc narrative.\n',
      })
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'arc_health',
          type: 'arc',
          label: 'Health',
          doc: arcDocPath,
        },
      ])
      // The user hand-deletes the page; the graph node and its doc pointer
      // both stay exactly as they were.
      await rm(arcDocPath)

      const chat = new FakeChatProvider([
        {
          text: JSON.stringify({
            ...emptyReflectionOutput('Talked about health.'),
            arcUpdates: [{ arcId: 'arc_health', note: 'Should be skipped, the page is gone.' }],
          }),
          toolCalls: [],
        },
      ])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const startedAt = new Date()
      const sessionId = await engine.startSession(startedAt)
      await engine.appendTranscript(sessionId, {
        ts: startedAt.toISOString(),
        role: 'user',
        content: 'Talked about health today.',
      })

      await engine.endSession(sessionId)

      const sessions = await SessionStore.listSessions(paths)
      const session = sessions.find((s) => s.sessionId === sessionId)
      expect(session?.reflected).toBe(true)

      expect(engine.warnings.some((w) => w.includes('Health'))).toBe(true)
      expect(engine.warnings.some((w) => w.includes('arc_health'))).toBe(true)

      await engine.close()
    })
  })

  describe('forget', () => {
    let forgetDir: string
    let forgetPaths: MemoryPaths

    beforeEach(async () => {
      forgetDir = await mkdtemp(join(tmpdir(), 'openreverie-engine-forget-'))
      forgetPaths = memoryPaths(forgetDir, nodeStores())
    })

    afterEach(async () => {
      await rmWithRetry(forgetDir)
    })

    it('retracts requested nodes and edges: foldGraph drops them, and the tool reports what actually changed', async () => {
      await ensureMemoryTree(forgetPaths, 'UTC')
      await appendGraph(forgetPaths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'person_x',
          type: 'person',
          label: 'Alex',
        },
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'item_x',
          type: 'item',
          label: 'A note',
        },
        {
          ts: '2026-08-01T00:00:01.000Z',
          op: 'assert',
          edge: 'involves',
          from: 'item_x',
          to: 'person_x',
          confidence: 0.8,
          confirmed: false,
        },
      ])

      const engine = await MemoryEngine.open(forgetDir, fakeDeps(new FakeChatProvider([])))
      const result = await engine.forget({
        what: 'a person who does not belong in this record',
        nodeIds: ['person_x'],
        edges: [{ edge: 'involves', from: 'item_x', to: 'person_x' }],
      })

      expect(result).toEqual({ retractedNodes: 1, retractedEdges: 1, rewrittenDocuments: [] })

      const state = await readGraph(forgetPaths)
      expect(state.nodes.has('person_x')).toBe(false)
      expect(state.edges.has('involves:item_x:person_x')).toBe(false)

      await engine.close()
    })

    it('preserves history: the original assert lines stay in graph.jsonl alongside the new retract lines', async () => {
      await ensureMemoryTree(forgetPaths, 'UTC')
      await appendGraph(forgetPaths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'person_y',
          type: 'person',
          label: 'Sam',
        },
      ])

      const engine = await MemoryEngine.open(forgetDir, fakeDeps(new FakeChatProvider([])))
      await engine.forget({ what: 'a contact who moved away', nodeIds: ['person_y'] })

      const raw = await readFile(forgetPaths.graphLog, 'utf8')
      const records = raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { node?: string; op: string })
      const forPersonY = records.filter((r) => r.node === 'person_y')
      expect(forPersonY.map((r) => r.op)).toEqual(['assert', 'retract'])

      await engine.close()
    })

    it('rejects a document rewrite with an empty or whitespace-only body, changing nothing on disk', async () => {
      await ensureMemoryTree(forgetPaths, 'UTC')
      const docId = newId('doc')
      const docPath = join(forgetPaths.arcsDir, 'marathon.md')
      await writeDocumentAtomic(forgetPaths.files, {
        path: docPath,
        meta: { id: docId, name: 'Marathon training', status: 'active' },
        body: 'Training for the spring marathon.\n',
      })

      const engine = await MemoryEngine.open(forgetDir, fakeDeps(new FakeChatProvider([])))

      await expect(
        engine.forget({ what: 'the marathon plan', documents: [{ docId, body: '   \n  ' }] }),
      ).rejects.toThrow(/empty|whitespace/)

      const stillThere = await readDocument(forgetPaths.files, docPath)
      expect(stillThere.body).toBe('Training for the spring marathon.\n')

      await engine.close()
    })

    it('rewrites a document atomically when the new body is real content', async () => {
      await ensureMemoryTree(forgetPaths, 'UTC')
      const docId = newId('doc')
      const docPath = join(forgetPaths.arcsDir, 'marathon.md')
      await writeDocumentAtomic(forgetPaths.files, {
        path: docPath,
        meta: { id: docId, name: 'Marathon training', status: 'active' },
        body: 'Training for the spring marathon, with a friend named Alex.\n',
      })

      const engine = await MemoryEngine.open(forgetDir, fakeDeps(new FakeChatProvider([])))
      const result = await engine.forget({
        what: "Alex's name out of the marathon arc",
        documents: [{ docId, body: 'Training for the spring marathon.\n' }],
      })

      expect(result.rewrittenDocuments).toEqual([docPath])
      const rewritten = await readDocument(forgetPaths.files, docPath)
      expect(rewritten.body).toBe('Training for the spring marathon.\n')

      await engine.close()
    })

    it('never writes to a transcript or a session summary', async () => {
      await ensureMemoryTree(forgetPaths, 'UTC')
      await appendGraph(forgetPaths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'person_z',
          type: 'person',
          label: 'Jo',
        },
      ])

      const engine = await MemoryEngine.open(forgetDir, fakeDeps(new FakeChatProvider([])))
      const startedAt = new Date()
      const sessionId = await engine.startSession(startedAt)
      await engine.appendTranscript(sessionId, {
        ts: startedAt.toISOString(),
        role: 'user',
        content: 'Jo and I had a falling out.',
      })

      const sessionDir = join(
        forgetPaths.sessionsDir,
        `${formatLocalDate(startedAt, engine.timezone())}-${sessionId}`,
      )
      const transcriptPath = join(sessionDir, 'transcript.jsonl')
      const before = await readFile(transcriptPath, 'utf8')

      await engine.forget({ what: 'the falling out with Jo', nodeIds: ['person_z'] })

      const after = await readFile(transcriptPath, 'utf8')
      expect(after).toBe(before)
      await expect(
        readDocument(forgetPaths.files, join(sessionDir, 'summary.md')),
      ).rejects.toThrow()

      await engine.close()
    })

    it('rejects rewriting a session summary or a rollup even given a valid docId for one, leaving the file untouched', async () => {
      // The transcript test above proves forget never targets a
      // transcript, but a forget call never names a transcript path in
      // the first place, since nothing hands a model a transcript's docId.
      // A session summary and a rollup DO get docIds (walkAllDocuments
      // indexes both), so this is the case that actually exercises
      // kindForDocumentPath's guard: a caller with a real, resolvable
      // docId for one of them must still be refused, not silently allowed
      // because the id happened to resolve.
      await ensureMemoryTree(forgetPaths, 'UTC')

      const summaryId = newId('doc')
      const summaryDir = join(forgetPaths.sessionsDir, '2026-08-01-session_fake')
      await mkdir(summaryDir, { recursive: true })
      const summaryPath = join(summaryDir, 'summary.md')
      await writeDocumentAtomic(forgetPaths.files, {
        path: summaryPath,
        meta: { id: summaryId, session: 'session_fake' },
        body: 'What actually happened in this session.\n',
      })

      const rollupId = newId('doc')
      const rollupPath = join(forgetPaths.rollupsDailyDir, '2026-08-01.md')
      await writeDocumentAtomic(forgetPaths.files, {
        path: rollupPath,
        meta: { id: rollupId, date: '2026-08-01' },
        body: 'The daily rollup for that date.\n',
      })

      const engine = await MemoryEngine.open(forgetDir, fakeDeps(new FakeChatProvider([])))
      // reindexAll walks the whole folder, including sessions/*/summary.md
      // and the rollups directories, so both docs above are now resolvable
      // by id exactly the way a model's earlier read_document call would
      // have made them resolvable.
      await engine.reindexAll()
      expect(engine.docIdForPath(summaryPath)).toBe(summaryId)
      expect(engine.docIdForPath(rollupPath)).toBe(rollupId)

      await expect(
        engine.forget({
          what: 'the session',
          documents: [{ docId: summaryId, body: 'rewritten' }],
        }),
      ).rejects.toThrow(/not a document kind/)
      await expect(
        engine.forget({ what: 'the rollup', documents: [{ docId: rollupId, body: 'rewritten' }] }),
      ).rejects.toThrow(/not a document kind/)

      const summaryAfter = await readDocument(forgetPaths.files, summaryPath)
      expect(summaryAfter.body).toBe('What actually happened in this session.\n')
      const rollupAfter = await readDocument(forgetPaths.files, rollupPath)
      expect(rollupAfter.body).toBe('The daily rollup for that date.\n')

      await engine.close()
    })

    it('commits the change with message "forget: <what>"', async () => {
      await ensureMemoryTree(forgetPaths, 'UTC')
      await appendGraph(forgetPaths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'person_w',
          type: 'person',
          label: 'Pat',
        },
      ])
      const engine = await MemoryEngine.open(forgetDir, fakeDeps(new FakeChatProvider([])))

      await engine.forget({ what: 'an old contact named Pat', nodeIds: ['person_w'] })

      const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%s'], {
        cwd: forgetDir,
      })
      expect(stdout.trim()).toBe('forget: an old contact named Pat')

      await engine.close()
    })
  })

  describe('journal document kind', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-journal-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('walkAllDocuments (via listPublicDocuments) includes a hand-written journal entry', async () => {
      await writeDocumentAtomic(paths.files, {
        path: join(paths.journalDir, '2026-08-16-doc_01JZZZ.md'),
        meta: {
          id: 'doc_01JZZZ',
          kind: 'journal',
          method: 'gratitude',
          mode: 'journal',
          entryDate: '2026-08-16',
          recordedAt: '2026-08-16T21:04:00.000Z',
          session: 'session_01JAAA',
        },
        body: 'Grateful for a quiet morning.\n',
      })
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const rows = await engine.listPublicDocuments()
      const journalRow = rows.find((row) => row.kind === 'journal')
      expect(journalRow?.docId).toBe('doc_01JZZZ')
      expect(journalRow?.method).toBe('gratitude')
      expect(journalRow?.entryDate).toBe('2026-08-16')
      await engine.close()
    })

    it('walkAllDocuments includes journaling.md, once it exists, with kind journaling', async () => {
      await writeDocumentAtomic(paths.files, {
        path: paths.journaling,
        meta: { id: 'doc_01JZZZ2', kind: 'journaling', updated: '2026-08-16T21:04:00.000Z' },
        body: 'Gratitude, three times a week.\n',
      })
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const rows = await engine.listPublicDocuments()
      expect(rows.find((row) => row.kind === 'journaling')?.docId).toBe('doc_01JZZZ2')
      await engine.close()
    })

    it('walkAllDocuments does not fail when journaling.md is absent', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const rows = await engine.listPublicDocuments()
      expect(rows.find((row) => row.kind === 'journaling')).toBeUndefined()
      await engine.close()
    })

    it('a journal row without a name-worthy title reports method and entryDate as its own fields, not folded into title', async () => {
      await writeDocumentAtomic(paths.files, {
        path: join(paths.journalDir, '2026-08-16-doc_01JZZZ.md'),
        meta: {
          id: 'doc_01JZZZ',
          kind: 'journal',
          method: 'examen',
          mode: 'journal',
          entryDate: '2026-08-16',
          recordedAt: '2026-08-16T21:04:00.000Z',
          session: 'session_01JAAA',
        },
        body: 'Right now, tired but okay.\n',
      })
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const doc = await engine.getPublicDocument('doc_01JZZZ')
      expect(doc?.method).toBe('examen')
      expect(doc?.entryDate).toBe('2026-08-16')
      await engine.close()
    })

    it('a journal row carries a short excerpt of its body, truncated', async () => {
      const longFirstLine = 'A'.repeat(200)
      await writeDocumentAtomic(paths.files, {
        path: join(paths.journalDir, '2026-08-16-doc_01JZZZ.md'),
        meta: {
          id: 'doc_01JZZZ',
          kind: 'journal',
          method: 'open',
          mode: 'journal',
          entryDate: '2026-08-16',
          recordedAt: '2026-08-16T21:04:00.000Z',
          session: 'session_01JAAA',
        },
        body: `${longFirstLine}\nSecond line, not part of the excerpt.\n`,
      })
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const rows = await engine.listPublicDocuments()
      const row = rows.find((r) => r.kind === 'journal')
      expect(row?.excerpt?.length).toBeLessThanOrEqual(141)
      expect(row?.excerpt).not.toContain('Second line')
      await engine.close()
    })

    it('a non-journal row never carries an excerpt', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const rows = await engine.listPublicDocuments()
      expect(rows.every((row) => row.excerpt === undefined)).toBe(true)
      await engine.close()
    })
  })

  describe('dream document kind', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-dream-'))
      paths = memoryPaths(dir, nodeStores())
      await ensureMemoryTree(paths, 'UTC')
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('serves a dream directory that has only insight.md, with no dream.md, without throwing', async () => {
      const dreamDir = join(paths.dreamsDir, '2026-08-20-dream_a')
      await mkdir(dreamDir, { recursive: true })
      await writeDocumentAtomic(paths.files, {
        path: join(dreamDir, 'insight.md'),
        meta: { id: 'doc_01JZDREAM1', date: '2026-08-20' },
        body: 'An insight with no accompanying narrative.\n',
      })

      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const rows = await engine.listPublicDocuments()
      const dreamRows = rows.filter((row) => row.kind === 'dream' || row.kind === 'dream_insight')
      expect(dreamRows).toHaveLength(1)
      expect(dreamRows[0]?.kind).toBe('dream_insight')
      expect(dreamRows[0]?.docId).toBe('doc_01JZDREAM1')
      const full = await engine.getPublicDocument('doc_01JZDREAM1')
      expect(full?.kind).toBe('dream_insight')
      await engine.close()
    })

    it('never serves dreams/log.jsonl, dreams/.lock, or a dream directory process.jsonl as documents', async () => {
      const dreamDir = join(paths.dreamsDir, '2026-08-21-dream_b')
      await mkdir(dreamDir, { recursive: true })
      await writeDocumentAtomic(paths.files, {
        path: join(dreamDir, 'dream.md'),
        meta: { id: 'doc_01JZDREAM2', date: '2026-08-21' },
        body: 'A dream narrative.\n',
      })
      await writeDocumentAtomic(paths.files, {
        path: join(dreamDir, 'insight.md'),
        meta: { id: 'doc_01JZDREAM3', date: '2026-08-21' },
        body: 'A dream insight.\n',
      })
      // A non-document sibling inside the dream directory, and two
      // non-document files at the top of dreamsDir. None of these have
      // frontmatter and none should ever be read as a document.
      await writeFile(join(dreamDir, 'process.jsonl'), '{"step":"explore"}\n', 'utf8')
      await writeFile(join(paths.dreamsDir, 'log.jsonl'), '{"dreamId":"dream_b"}\n', 'utf8')
      await writeFile(join(paths.dreamsDir, '.lock'), '', 'utf8')

      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const rows = await engine.listPublicDocuments()
      const dreamRows = rows.filter((row) => row.kind === 'dream' || row.kind === 'dream_insight')
      expect(dreamRows.map((row) => row.docId).sort()).toEqual(
        ['doc_01JZDREAM2', 'doc_01JZDREAM3'].sort(),
      )
      await engine.close()
    })
  })

  describe('session journal method', () => {
    let dir: string

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-journalmethod-'))
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('records and reads back the declared method for a session', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const sessionId = await engine.startSession(new Date('2026-08-16T09:00:00.000Z'))
      await engine.setSessionJournalMethod(sessionId, 'gratitude')
      expect(await engine.sessionJournalMethod(sessionId)).toBe('gratitude')
      await engine.close()
    })

    it('reports the method as absent for a session that never declared one', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const sessionId = await engine.startSession(new Date('2026-08-16T09:00:00.000Z'))
      expect(await engine.sessionJournalMethod(sessionId)).toBeUndefined()
      await engine.close()
    })

    // The design note above setSessionJournalMethod promises a read-merge-write:
    // declaring a method must not clobber a mode already written by
    // setSessionMode. Nothing else in this plan asserts that property, so this
    // is also the falsify target for that guarantee.
    it('declaring a method leaves an already-set mode intact', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
      const sessionId = await engine.startSession(new Date('2026-08-16T09:00:00.000Z'))
      await engine.setSessionMode(sessionId, 'journal')
      await engine.setSessionJournalMethod(sessionId, 'gratitude')
      expect(await engine.sessionMode(sessionId)).toBe('journal')
      expect(await engine.sessionJournalMethod(sessionId)).toBe('gratitude')
      await engine.close()
    })
  })
})

describe('buildReflectionContext people and entities wiring', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-people-'))
    paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
    await pinTimezoneUtc(paths)
  })

  afterEach(async () => {
    await rmWithRetry(dir)
  })

  it('includes existing people in the reflection prompt built by the engine', async () => {
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'person_sam',
        type: 'person',
        label: 'Sam',
      },
    ])

    const chat = new FakeChatProvider([
      { text: JSON.stringify(emptyReflectionOutput('A session.')), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))

    const sessionId = await engine.startSession()
    await engine.appendTranscript(sessionId, {
      ts: new Date().toISOString(),
      role: 'user',
      content: 'Hello there.',
    })
    await engine.endSession(sessionId)

    const prompt = chat.requests[0]?.messages[0]?.content ?? ''
    expect(prompt).toContain('person_sam: Sam')

    await engine.close()
  })

  it('includes existing entities in the reflection prompt built by the engine', async () => {
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'entity_film',
        type: 'entity',
        label: 'A Favorite Film',
      },
    ])

    const chat = new FakeChatProvider([
      { text: JSON.stringify(emptyReflectionOutput('A session.')), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))

    const sessionId = await engine.startSession()
    await engine.appendTranscript(sessionId, {
      ts: new Date().toISOString(),
      role: 'user',
      content: 'Hello there.',
    })
    await engine.endSession(sessionId)

    const prompt = chat.requests[0]?.messages[0]?.content ?? ''
    expect(prompt).toContain('Known entities:')
    // Entities never get a page in this release, so unlike people, their
    // listing carries no page-status suffix at all (see MINOR 1 in the
    // fix-round report: entities used to be marked "(no page yet)" even
    // though the same prompt says they never get a page).
    expect(prompt).toContain('entity_film: A Favorite Film')
    expect(prompt).not.toContain('entity_film: A Favorite Film (no page yet)')

    await engine.close()
  })

  it('marks a known person with a page differently from one without, in the prompt built by the engine', async () => {
    const personDocPath = join(paths.peopleDir, 'alex.md')
    await writeDocumentAtomic(paths.files, {
      path: personDocPath,
      meta: { id: newId('doc'), name: 'Alex', node: 'person_alex' },
      body: 'Alex has a page already.\n',
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'person_sam',
        type: 'person',
        label: 'Sam',
      },
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'person_alex',
        type: 'person',
        label: 'Alex',
        doc: personDocPath,
      },
    ])

    const chat = new FakeChatProvider([
      { text: JSON.stringify(emptyReflectionOutput('A session.')), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))

    const sessionId = await engine.startSession()
    await engine.appendTranscript(sessionId, {
      ts: new Date().toISOString(),
      role: 'user',
      content: 'Hello there.',
    })
    await engine.endSession(sessionId)

    const prompt = chat.requests[0]?.messages[0]?.content ?? ''
    expect(prompt).toContain('person_sam: Sam (no page yet)')
    expect(prompt).toContain('person_alex: Alex (has a page)')

    await engine.close()
  })

  it('marks the known-entities listing as truncated in the reflection prompt once there are more entities than ENTITIES_CAP', async () => {
    const records: Parameters<typeof appendGraph>[1] = []
    for (let i = 0; i < 35; i++) {
      records.push({
        ts: `2026-02-01T00:${String(i).padStart(2, '0')}:00.000Z`,
        op: 'assert',
        node: `entity_${i}`,
        type: 'entity',
        label: `Entity ${i}`,
      })
    }
    await appendGraph(paths, records)

    const chat = new FakeChatProvider([
      { text: JSON.stringify(emptyReflectionOutput('A session.')), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))

    const sessionId = await engine.startSession()
    await engine.appendTranscript(sessionId, {
      ts: new Date().toISOString(),
      role: 'user',
      content: 'Hello there.',
    })
    await engine.endSession(sessionId)

    const prompt = chat.requests[0]?.messages[0]?.content ?? ''
    expect(prompt).toContain('list truncated')
    // Only 30 of the 35 entity lines actually appear (plus the note above).
    expect(prompt).not.toContain('entity_0: Entity 0')
    expect(prompt).toContain('entity_34: Entity 34')

    await engine.close()
  })
})

describe('MemoryEngine profile', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-profile-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('caches the seeded profile on open and reports it as a system default', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })

    expect(engine.timezoneSource()).toBe('system-default')
    expect(typeof engine.timezone()).toBe('string')
    expect(engine.timezone().length).toBeGreaterThan(0)

    await engine.close()
  })

  it('updateProfile writes a confirmed timezone to disk and refreshes the cached copy', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })

    const updated = await engine.updateProfile({ timezone: 'Asia/Kolkata' })

    expect(updated.meta.timezone).toBe('Asia/Kolkata')
    expect(engine.timezone()).toBe('Asia/Kolkata')
    expect(engine.timezoneSource()).toBe('user-confirmed')

    const onDisk = await loadProfile(memoryPaths(dir, nodeStores()), 'UTC')
    expect(onDisk.meta.timezone).toBe('Asia/Kolkata')
    expect(onDisk.meta.timezoneSource).toBe('user-confirmed')

    await engine.close()
  })

  it('updateProfile rejects a timezone Intl does not recognize and leaves the cache untouched', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })
    const before = engine.timezone()

    await expect(engine.updateProfile({ timezone: 'Nowhere/Fake' })).rejects.toThrow(
      'is not a recognized IANA timezone',
    )
    expect(engine.timezone()).toBe(before)

    await engine.close()
  })

  it('updateProfile keeps unrelated frontmatter keys that were already in the file', async () => {
    const paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
    await pinTimezoneUtc(paths)
    const seeded = await loadProfile(paths, 'UTC')
    await writeProfile(paths, { meta: { ...seeded.meta, pronouns: 'she/her' }, body: seeded.body })

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })
    await engine.updateProfile({ timezone: 'Europe/Berlin' })

    const onDisk = await loadProfile(paths, 'UTC')
    expect(onDisk.meta.pronouns).toBe('she/her')
    expect(onDisk.meta.timezone).toBe('Europe/Berlin')

    await engine.close()
  })
})

describe('profile writes', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-profile-writes-'))
    paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // No shared helper for opening an engine against a temp folder exists in
  // this file (every other block builds one inline), so this follows the
  // same pattern the "public read projections" and "MemoryEngine profile"
  // blocks above already use.
  async function openEngine(): Promise<MemoryEngine> {
    return MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), { maintenance: false })
  }

  it('exposes the cached profile synchronously', async () => {
    const engine = await openEngine()
    expect(engine.profile().meta.id).toMatch(/^doc_/)
    await engine.close()
  })

  it('writes an allowlisted field and refreshes the cache', async () => {
    const engine = await openEngine()
    await engine.updateProfile({ preferredName: 'Vish', occupation: 'nurse' })
    expect(engine.profile().meta.preferredName).toBe('Vish')
    expect(engine.profile().meta.occupation).toBe('nurse')
    await engine.close()
  })

  it('marks a timezone written through the model path as user-confirmed', async () => {
    const engine = await openEngine()
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })
    expect(engine.profile().meta.timezone).toBe('Asia/Kolkata')
    expect(engine.profile().meta.timezoneSource).toBe('user-confirmed')
    await engine.close()
  })

  it('rejects a style write through the model path', async () => {
    const engine = await openEngine()
    await expect(engine.updateProfile({ style: { tone: 'direct' } } as never)).rejects.toThrow(
      /style/,
    )
    await engine.close()
  })

  it('writes style through the settings path and leaves other fields byte-identical', async () => {
    const engine = await openEngine()
    await engine.updateProfile({ preferredName: 'Vish', location: 'Bengaluru' })
    await engine.updateProfileSettings({ style: { tone: 'direct' } })
    const profile = engine.profile()
    expect(profile.meta.style).toEqual({ tone: 'direct' })
    expect(profile.meta.preferredName).toBe('Vish')
    expect(profile.meta.location).toBe('Bengaluru')
    expect(paths.profile.endsWith('profile.md')).toBe(true)
    await engine.close()
  })

  it('clears a field when the settings path is given null', async () => {
    const engine = await openEngine()
    await engine.updateProfile({ location: 'Bengaluru' })
    await engine.updateProfileSettings({ location: null })
    expect(engine.profile().meta.location).toBeUndefined()
    await engine.close()
  })

  // The web Settings Dreams section patches one dream field at a time
  // (voice, openerMention, promptSection each their own onChange). If
  // updateProfileSettings ever replaced meta.dreams wholesale instead of
  // merging it, a one-key patch would silently delete the person's other
  // two saved dream preferences.
  it('merges a dreams patch shallowly, leaving the other dream fields untouched', async () => {
    const engine = await openEngine()
    await engine.updateProfileSettings({
      dreams: { voice: 'first', openerMention: false, promptSection: false },
    })
    await engine.updateProfileSettings({ dreams: { voice: 'second' } })
    expect(engine.profile().meta.dreams).toEqual({
      voice: 'second',
      openerMention: false,
      promptSection: false,
    })
    await engine.close()
  })

  it('resolves style with the balanced/warm/listening defaults when unset', async () => {
    const engine = await openEngine()
    expect(engine.currentStyle()).toEqual({
      engagement: 'balanced',
      tone: 'warm',
      orientation: 'listening',
    })
    await engine.close()
  })

  it('writes the profile atomically, leaving no temp file behind', async () => {
    const engine = await openEngine()
    await engine.updateProfile({ preferredName: 'Vish' })
    const entries = await readdir(paths.root)
    expect(entries.filter((name) => name.includes('.tmp-'))).toEqual([])
    await engine.close()
  })
})

describe('local day boundaries', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-localday-'))
    paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('builds the daily and the completed weekly rollup using the local day, not the UTC day', async () => {
    // 2026-08-16T20:00:00Z is 2026-08-17 01:30 in Asia/Kolkata. Local today
    // is therefore 2026-08-17 (a Monday, ISO week 2026-W34), which makes
    // 2026-08-16 (a Sunday, ISO week 2026-W33) both strictly before today
    // and in a completed week. Under UTC, today would be 2026-08-16, which
    // is neither, and zero rollups would be built.
    const now = new Date('2026-08-16T20:00:00.000Z')

    const store = await SessionStore.start(paths, new Date('2026-08-16T09:00:00.000Z'), 'UTC')
    await store.appendLine(paths, {
      ts: '2026-08-16T09:00:00.000Z',
      role: 'user',
      content: 'A good Sunday.',
    })
    await writeDocumentAtomic(paths.files, {
      path: join(store.dir, 'summary.md'),
      meta: {
        id: newId('doc'),
        kind: 'summary',
        session: store.sessionId,
        date: '2026-08-16',
        items: [],
      },
      body: 'A good Sunday.\n',
    })

    // Two completions: the daily rollup, then the weekly. runMaintenance
    // re-reads the daily rollup files from disk after its daily loop, so
    // the weekly leg fires in the same pass as the daily one.
    const chat = new FakeChatProvider([
      { text: 'A quiet Sunday.', toolCalls: [] },
      { text: 'A quiet week.', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat), { maintenance: false })
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })

    await engine.runMaintenance(now)

    await expect(
      readDocument(paths.files, join(paths.rollupsDailyDir, '2026-08-16.md')),
    ).resolves.toBeDefined()
    await expect(
      readDocument(paths.files, join(paths.rollupsWeeklyDir, '2026-W33.md')),
    ).resolves.toBeDefined()

    await engine.close()
  })

  it('windows recent summaries against the local day, not the UTC day', async () => {
    // Local today is 2026-08-17, so the seven-day cutoff is 2026-08-10 and
    // a session dated 2026-08-10 is still inside the window. Under UTC the
    // cutoff would be 2026-08-09.
    const now = new Date('2026-08-16T20:00:00.000Z')

    const store = await SessionStore.start(paths, new Date('2026-08-10T09:00:00.000Z'), 'UTC')
    await store.appendLine(paths, {
      ts: '2026-08-10T09:00:00.000Z',
      role: 'user',
      content: 'Monday.',
    })
    await writeDocumentAtomic(paths.files, {
      path: join(store.dir, 'summary.md'),
      meta: {
        id: newId('doc'),
        kind: 'summary',
        session: store.sessionId,
        date: '2026-08-10',
        items: [],
      },
      body: 'Monday happened.\n',
    })

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })

    const context = await engine.sessionContext(now)
    expect(context.recentSummaries.map((summary) => summary.date)).toContain('2026-08-10')

    await engine.close()
  })

  it('names a new session directory with the local day', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })
    await engine.updateProfile({ timezone: 'Asia/Kolkata' })

    const sessionId = await engine.startSession(new Date('2026-08-16T20:00:00.000Z'))

    const sessions = await SessionStore.listSessions(paths)
    const created = sessions.find((session) => session.sessionId === sessionId)
    expect(created?.dirName).toBe(`2026-08-17-${sessionId}`)

    await engine.close()
  })
})

describe('a session whose logical date differs from its directory prefix', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-divergent-'))
    paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
    await pinTimezoneUtc(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // The directory is 2026-08-15-<id>; the summary inside it says 2026-08-16.
  async function seedDivergentSession(summaryBody: string): Promise<string> {
    const store = await SessionStore.start(paths, new Date('2026-08-15T21:00:00Z'), 'UTC')
    await store.appendLine(paths, {
      ts: '2026-08-15T21:00:00.000Z',
      utcOffsetMinutes: 330,
      role: 'user',
      content: 'Late one.',
    })
    await writeDocumentAtomic(paths.files, {
      path: join(store.dir, 'summary.md'),
      meta: {
        id: newId('doc'),
        kind: 'summary',
        session: store.sessionId,
        date: '2026-08-16',
        items: [],
      },
      body: summaryBody,
    })
    return store.sessionId
  }

  it('sessionContext reads the summary out of the directory that actually exists', async () => {
    const sessionId = await seedDivergentSession('A late Saturday night.\n')
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })

    const context = await engine.sessionContext(new Date('2026-08-17T12:00:00.000Z'))

    const entry = context.recentSummaries.find((summary) => summary.sessionId === sessionId)
    expect(entry?.date).toBe('2026-08-16')
    expect(entry?.body.trim()).toBe('A late Saturday night.')

    await engine.close()
  })

  it('buildDailyRollup finds the divergent session summary for its logical date', async () => {
    await seedDivergentSession('A late Saturday night.\n')
    const chat = new FakeChatProvider([{ text: 'A quiet late night.', toolCalls: [] }])

    const doc = await buildDailyRollup({ chat, model: 'fake-reflect', paths }, '2026-08-16')

    expect(doc.body.trim()).toBe('A quiet late night.')

    await expect(
      readDocument(paths.files, join(paths.rollupsDailyDir, '2026-08-16.md')),
    ).resolves.toBeDefined()
  })

  it('a skipped summary is written into the existing directory, never into a second one', async () => {
    const store = await SessionStore.start(paths, new Date('2026-08-15T21:00:00Z'), 'UTC')
    await store.appendLine(paths, {
      ts: '2026-08-15T21:00:00.000Z',
      utcOffsetMinutes: 330,
      role: 'assistant',
      content: 'Good to see you.',
    })

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])), {
      maintenance: false,
    })
    await engine.runMaintenance(new Date('2026-08-17T12:00:00.000Z'))

    const entries = await readdir(paths.sessionsDir, { withFileTypes: true })
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    expect(dirs).toEqual([`2026-08-15-${store.sessionId}`])

    const summary = await readDocument(paths.files, join(store.dir, 'summary.md'))
    expect(summary.meta.skipped).toBe(true)
    expect(summary.meta.date).toBe('2026-08-16')

    await engine.close()
  })
})

describe('reflection profileUpdates', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-profileupdates-'))
    paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
    await pinTimezoneUtc(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes a confirmed timezone reported by reflection', async () => {
    const reflectionWith = {
      ...emptyReflectionOutput('They moved to Berlin.'),
      profileUpdates: { timezone: 'Europe/Berlin' },
    }
    const chat = new FakeChatProvider([
      { text: JSON.stringify(reflectionWith), toolCalls: [] },
      { text: 'A rewritten narrative.', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat), { maintenance: false })
    const sessionId = await engine.startSession(new Date('2026-08-16T09:00:00.000Z'))
    await engine.appendTranscript(sessionId, {
      ts: '2026-08-16T09:00:00.000Z',
      utcOffsetMinutes: 0,
      role: 'user',
      content: 'I moved to Berlin last month.',
    })

    await engine.endSession(sessionId)

    expect(engine.timezone()).toBe('Europe/Berlin')
    expect(engine.timezoneSource()).toBe('user-confirmed')
    const onDisk = await loadProfile(paths, 'UTC')
    expect(onDisk.meta.timezone).toBe('Europe/Berlin')

    await engine.close()
  })

  it('leaves the timezone alone when reflection reports no profile updates', async () => {
    const reflectionWithout = {
      ...emptyReflectionOutput('An ordinary session.'),
      profileUpdates: {},
    }
    const chat = new FakeChatProvider([
      { text: JSON.stringify(reflectionWithout), toolCalls: [] },
      { text: 'A rewritten narrative.', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat), { maintenance: false })
    const sessionId = await engine.startSession(new Date('2026-08-16T09:00:00.000Z'))
    await engine.appendTranscript(sessionId, {
      ts: '2026-08-16T09:00:00.000Z',
      utcOffsetMinutes: 0,
      role: 'user',
      content: 'Nothing much happened.',
    })

    await engine.endSession(sessionId)

    expect(engine.timezone()).toBe('UTC')

    await engine.close()
  })
})

describe('index schema migration', () => {
  it('rebuilds the index from the folder instead of leaving it empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-migration-'))
    const paths = memoryPaths(dir, nodeStores())

    let engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    await writeDocumentAtomic(paths.files, {
      path: join(paths.realmsDir, 'fitness.md'),
      meta: { id: 'doc_migration_realm', name: 'Fitness' },
      body: 'Kayaking on the lake every Sunday morning.\n',
    })
    await engine.reindexAll()
    const before = await engine.search('kayaking')
    expect(before.documents.some((hit) => hit.docId === 'doc_migration_realm')).toBe(true)
    await engine.close()

    const db = new Database(paths.indexDb)
    db.pragma('user_version = 1')
    db.close()

    engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const after = await engine.search('kayaking')
    expect(after.documents.some((hit) => hit.docId === 'doc_migration_realm')).toBe(true)
    expect(engine.warnings.some((w) => w.includes('search index schema'))).toBe(true)
    await engine.close()

    await rm(dir, { recursive: true, force: true })
  })
})

describe('listArcs and listRealms', () => {
  it('returns docId, real status from frontmatter, and no filesystem path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-listings-'))
    const paths = memoryPaths(dir, nodeStores())
    await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([]))).then((e) => e.close())

    const activeArcPath = join(paths.arcsDir, 'marathon.md')
    await writeDocumentAtomic(paths.files, {
      path: activeArcPath,
      meta: {
        id: 'doc_arc_active',
        name: 'Marathon Training',
        status: 'active',
        updated: '2026-08-10',
      },
      body: 'Training for the fall marathon.\n',
    })
    const closedArcPath = join(paths.arcsDir, 'move.md')
    await writeDocumentAtomic(paths.files, {
      path: closedArcPath,
      meta: { id: 'doc_arc_closed', name: 'Moving House', status: 'closed', updated: '2026-03-02' },
      body: 'The move is done.\n',
    })
    const realmPath = join(paths.realmsDir, 'fitness.md')
    await writeDocumentAtomic(paths.files, {
      path: realmPath,
      meta: { id: 'doc_realm', name: 'Fitness' },
      body: 'Running, lifting, sleep.\n',
    })

    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_active',
        type: 'arc',
        label: 'Marathon Training',
        doc: activeArcPath,
      },
      {
        ts: '2026-07-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_closed',
        type: 'arc',
        label: 'Moving House',
        doc: closedArcPath,
      },
      {
        ts: '2026-06-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_no_page',
        type: 'arc',
        label: 'Unpaged Arc',
      },
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

    const all = await engine.listArcs()
    expect(all.total).toBe(3)
    expect(all.offset).toBe(0)
    expect(all.limit).toBe(50)
    expect(all.returned).toBe(3)
    expect(all.hasMore).toBe(false)
    expect(all.rows.map((row) => row.id)).toEqual(['arc_active', 'arc_closed', 'arc_no_page'])

    const active = all.rows[0]
    expect(active).toEqual({
      id: 'arc_active',
      type: 'arc',
      label: 'Marathon Training',
      assertedAt: '2026-08-01T00:00:00.000Z',
      docId: 'doc_arc_active',
      status: 'active',
      lastTouched: '2026-08-10',
    })
    // The filesystem path is deliberately not part of the row.
    expect(Object.keys(active ?? {})).not.toContain('doc')

    // An arc with no page has no status to read, and status is absent
    // rather than defaulted to active.
    expect(all.rows[2]).toEqual({
      id: 'arc_no_page',
      type: 'arc',
      label: 'Unpaged Arc',
      assertedAt: '2026-06-01T00:00:00.000Z',
    })

    // The docId chains into read_document's engine method.
    const arcDoc = await engine.readDocumentById('doc_arc_active')
    expect(arcDoc?.body).toContain('Training for the fall marathon.')

    const onlyActive = await engine.listArcs({ status: 'active' })
    expect(onlyActive.total).toBe(1)
    expect(onlyActive.rows.map((row) => row.id)).toEqual(['arc_active'])

    const onlyClosed = await engine.listArcs({ status: 'closed' })
    expect(onlyClosed.rows.map((row) => row.id)).toEqual(['arc_closed'])

    const realms = engine.listRealms()
    expect(realms.total).toBe(1)
    expect(realms.rows).toEqual([
      {
        id: 'realm_fitness',
        type: 'realm',
        label: 'Fitness',
        assertedAt: '2026-08-01T00:00:00.000Z',
        docId: 'doc_realm',
      },
    ])

    await engine.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('pages arcs with a stable total order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-listings-page-'))
    const paths = memoryPaths(dir, nodeStores())
    await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([]))).then((e) => e.close())

    for (let i = 0; i < 5; i++) {
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: `arc_${i}`,
          type: 'arc',
          label: `Arc ${i}`,
        },
      ])
    }

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const first = await engine.listArcs({ limit: 2 })
    expect(first.returned).toBe(2)
    expect(first.hasMore).toBe(true)
    const second = await engine.listArcs({ offset: 2, limit: 2 })
    const third = await engine.listArcs({ offset: 4, limit: 2 })
    expect(third.hasMore).toBe(false)

    const paged = [...first.rows, ...second.rows, ...third.rows].map((row) => row.id)
    const unpaged = (await engine.listArcs()).rows.map((row) => row.id)
    expect(paged).toEqual(unpaged)
    expect(new Set(paged).size).toBe(5)

    // limit is clamped rather than trusted.
    const clamped = await engine.listArcs({ limit: 5000 })
    expect(clamped.limit).toBe(200)

    await engine.close()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('listPeople and listEntities', () => {
  async function seedPeople(dir: string, count: number, pagedCount: number): Promise<void> {
    const paths = memoryPaths(dir, nodeStores())
    await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([]))).then((e) => e.close())
    for (let i = 0; i < count; i++) {
      const hasPage = i < pagedCount
      let personPath: string | undefined
      if (hasPage) {
        personPath = join(paths.peopleDir, `person-${i}.md`)
        await writeDocumentAtomic(paths.files, {
          path: personPath,
          meta: { id: `doc_person_${i}`, name: `Person ${i}`, node: `person_${i}` },
          body: `Person ${i} has a page.\n`,
        })
      }
      await appendGraph(paths, [
        {
          ts: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00.000Z`,
          op: 'assert',
          node: `person_${i}`,
          type: 'person',
          label: `Person ${i}`,
          ...(personPath ? { doc: personPath } : {}),
        },
      ])
    }
  }

  it('reaches a person past the prompt cap, with a docId only when a page exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-people-'))
    await seedPeople(dir, 45, 5)

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const all = engine.listPeople({ limit: 200 })
    expect(all.total).toBe(45)
    expect(all.returned).toBe(45)

    const past = engine.listPeople({ offset: 40, limit: 50 })
    expect(past.offset).toBe(40)
    expect(past.returned).toBe(5)
    expect(past.hasMore).toBe(false)

    const paged = engine.listPeople({ hasPage: true, limit: 200 })
    expect(paged.total).toBe(5)
    for (const row of paged.rows) {
      expect(row.hasPage).toBe(true)
      expect(typeof row.docId).toBe('string')
    }

    const unpaged = engine.listPeople({ hasPage: false, limit: 200 })
    expect(unpaged.total).toBe(40)
    for (const row of unpaged.rows) {
      expect(row.hasPage).toBe(false)
      expect(row.docId).toBeUndefined()
    }

    const byName = engine.listPeople({ nameContains: 'person 41' })
    expect(byName.total).toBe(1)
    expect(byName.rows[0]).toMatchObject({ id: 'person_41', name: 'Person 41', hasPage: false })
    expect(typeof byName.rows[0]?.firstSeen).toBe('string')

    await engine.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('pages through every person exactly once, in an order stable across rebuilds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-people-paging-'))
    const paths = memoryPaths(dir, nodeStores())
    await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([]))).then((e) => e.close())

    // 45 people, of which five share an identical ts. Without the id
    // tiebreak the order of that tied group depends on graph.jsonl's line
    // order, which changes when the log is rewritten.
    for (let i = 0; i < 45; i++) {
      const ts =
        i < 5
          ? '2026-08-01T00:00:00.000Z'
          : `2026-07-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00.000Z`
      await appendGraph(paths, [
        { ts, op: 'assert', node: `person_${i}`, type: 'person', label: `Person ${i}` },
      ])
    }

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const collected: string[] = []
    for (let offset = 0; offset < 45; offset += 7) {
      collected.push(...engine.listPeople({ offset, limit: 7 }).rows.map((row) => row.id))
    }
    const unpaged = engine.listPeople({ limit: 200 }).rows.map((row) => row.id)
    expect(collected).toEqual(unpaged)
    expect(new Set(collected).size).toBe(45)
    await engine.close()

    // Rewrite graph.jsonl with the tied group in the opposite order, then
    // reopen. The tiebreak is what keeps the total order identical, so
    // paging still covers all 45 exactly once with no duplicate and no gap.
    const original = (await readFile(paths.graphLog, 'utf8')).split('\n').filter(Boolean)
    const tied = original.slice(0, 5).reverse()
    const rest = original.slice(5)
    await writeFile(paths.graphLog, `${[...tied, ...rest].join('\n')}\n`, 'utf8')

    const reopened = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const afterRebuild: string[] = []
    for (let offset = 0; offset < 45; offset += 7) {
      afterRebuild.push(...reopened.listPeople({ offset, limit: 7 }).rows.map((row) => row.id))
    }
    expect(afterRebuild).toEqual(unpaged)
    expect(new Set(afterRebuild).size).toBe(45)
    await reopened.close()

    await rm(dir, { recursive: true, force: true })
  })

  it('lists entities with no page fields at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-entities-'))
    const paths = memoryPaths(dir, nodeStores())
    await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([]))).then((e) => e.close())

    for (let i = 0; i < 3; i++) {
      await appendGraph(paths, [
        {
          ts: `2026-08-0${i + 1}T00:00:00.000Z`,
          op: 'assert',
          node: `entity_${i}`,
          type: 'entity',
          label: `Entity ${i}`,
        },
      ])
    }

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const listed = engine.listEntities()
    expect(listed.total).toBe(3)
    expect(listed.rows[0]).toEqual({
      id: 'entity_2',
      name: 'Entity 2',
      firstSeen: '2026-08-03T00:00:00.000Z',
    })
    expect(Object.keys(listed.rows[0] ?? {}).sort()).toEqual(['firstSeen', 'id', 'name'])

    const filtered = engine.listEntities({ nameContains: 'entity 1' })
    expect(filtered.total).toBe(1)
    expect(filtered.rows[0]?.id).toBe('entity_1')

    await engine.close()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('search node lane', () => {
  it('finds a person with no page by name and gives back an id, not a docId', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-node-lane-'))
    const paths = memoryPaths(dir, nodeStores())
    await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([]))).then((e) => e.close())

    const pagedPath = join(paths.peopleDir, 'priya.md')
    await writeDocumentAtomic(paths.files, {
      path: pagedPath,
      meta: { id: 'doc_priya', name: 'Priya', node: 'person_priya' },
      body: 'Priya runs the reading group.\n',
    })
    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'person_priya',
        type: 'person',
        label: 'Priya',
        doc: pagedPath,
      },
      {
        ts: '2026-08-02T00:00:00.000Z',
        op: 'assert',
        node: 'person_dara',
        type: 'person',
        label: 'Dara',
      },
    ])

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

    const unpaged = await engine.search('Dara')
    expect(unpaged.nodes).toEqual([
      { nodeId: 'person_dara', name: 'Dara', type: 'person', hasPage: false },
    ])
    expect(unpaged.documents.some((hit) => hit.docId === 'doc_dara')).toBe(false)

    const paged = await engine.search('Priya')
    expect(paged.nodes[0]).toEqual({
      nodeId: 'person_priya',
      name: 'Priya',
      type: 'person',
      hasPage: true,
      docId: 'doc_priya',
    })

    await engine.close()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('reflection receives the full constitution', () => {
  it('the reflection prompt carries the whole constitution body, sentinel included', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreverie-reflect-full-'))
    const paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')

    const sentinel = 'THE SENTINEL SENTENCE THAT MUST SURVIVE REFLECTION'
    const body = `${'p'.repeat(12000)}\n\n${sentinel}`
    await writeDocumentAtomic(paths.files, {
      path: paths.constitution,
      meta: { id: newId('doc') },
      body,
    })

    const chat = new FakeChatProvider([
      { text: JSON.stringify(emptyReflectionOutput('A session.')), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))

    const sessionId = await engine.startSession()
    await engine.appendTranscript(sessionId, {
      ts: new Date().toISOString(),
      role: 'user',
      content: 'Hello there.',
    })
    await engine.endSession(sessionId)

    const prompt = chat.requests[0]?.messages[0]?.content ?? ''
    expect(prompt).toContain('p'.repeat(12000))
    expect(prompt).toContain(sentinel)
    expect(prompt).not.toContain('(truncated:')

    await engine.close()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('session mode', () => {
  // No shared helper for opening an engine against a temp folder exists in
  // this file (every other block builds its own inline, see "profile
  // writes" above), so this follows the same established pattern rather
  // than introducing a second one. Tracks every root it creates so afterEach
  // can clean them all up, since each test opens its own temp folder.
  const roots: string[] = []

  afterEach(async () => {
    while (roots.length > 0) {
      const root = roots.pop()
      if (root) await rmWithRetry(root)
    }
  })

  async function openTestEngine(): Promise<{
    engine: MemoryEngine
    root: string
    deps: EngineDeps
  }> {
    const root = await mkdtemp(join(tmpdir(), 'openreverie-engine-session-mode-'))
    roots.push(root)
    const paths = memoryPaths(root, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
    const deps = fakeDeps(
      new FakeChatProvider([
        { text: JSON.stringify(emptyReflectionOutput('A session.')), toolCalls: [] },
      ]),
    )
    const engine = await MemoryEngine.open(root, deps, { maintenance: false })
    return { engine, root, deps }
  }

  it('records a mode set at session start', async () => {
    const { engine } = await openTestEngine()
    const sessionId = await engine.startSession()
    await engine.setSessionMode(sessionId, 'listen')
    expect(await engine.sessionMode(sessionId)).toBe('listen')
    await engine.close()
  })

  it('keeps the mode in force at the end, not the whole sequence', async () => {
    const { engine } = await openTestEngine()
    const sessionId = await engine.startSession()
    await engine.setSessionMode(sessionId, 'general')
    await engine.setSessionMode(sessionId, 'journal')
    expect(await engine.sessionMode(sessionId)).toBe('journal')
    await engine.close()
  })

  it('reports a session with no AgentSession behind it as having no mode', async () => {
    const { engine } = await openTestEngine()
    const sessionId = await engine.startSession()
    expect(await engine.sessionMode(sessionId)).toBeUndefined()
    await engine.close()
  })

  // The case section 9.4 exists to close. Holding the mode in an in-memory
  // map instead of session.json fails here while the same-process cases
  // above keep passing.
  it('survives closing and reopening the engine between the write and the read', async () => {
    const { engine, root, deps } = await openTestEngine()
    const sessionId = await engine.startSession()
    await engine.setSessionMode(sessionId, 'journal')
    await engine.close()

    const reopened = await MemoryEngine.open(root, deps, { maintenance: false })
    expect(await reopened.sessionMode(sessionId)).toBe('journal')
    await reopened.close()
  })

  it('has the mode available at end of session, from a fresh engine instance', async () => {
    const { engine, root, deps } = await openTestEngine()
    const sessionId = await engine.startSession()
    await engine.setSessionMode(sessionId, 'journal')
    await engine.appendTranscript(sessionId, {
      ts: new Date().toISOString(),
      role: 'user',
      content: 'hello',
    })
    await engine.close()

    const reopened = await MemoryEngine.open(root, deps, { maintenance: false })
    expect(await reopened.sessionMode(sessionId)).toBe('journal')
    await reopened.endSession(sessionId)
    expect(await reopened.sessionMode(sessionId)).toBe('journal')
    await reopened.close()
  })
})

describe('journal entry write', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-journalwrite-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes no file under journal/ for a session whose mode was never journal', async () => {
    const scriptedReflection = emptyReflectionOutput('An ordinary conversation.')
    const chat = new FakeChatProvider([{ text: JSON.stringify(scriptedReflection), toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const sessionId = await engine.startSession(new Date('2026-08-16T09:00:00.000Z'))
    await engine.appendTranscript(sessionId, {
      ts: '2026-08-16T09:00:00.000Z',
      role: 'user',
      content: 'Just talking, nothing structured.',
    })
    await engine.endSession(sessionId)
    const rows = await engine.listPublicDocuments()
    expect(rows.find((row) => row.kind === 'journal')).toBeUndefined()
    await engine.close()
  })

  // Distinct from the test above: here a method IS declared, but the
  // session's mode was never set to journal (e.g. journal mode was
  // considered and a method picked in some other flow, then the session
  // continued in a different mode). A gate that checks only `method` and
  // never `mode` would still write a file here, since method alone is
  // truthy; only a mode check catches it. Added because falsifying the
  // `mode === 'journal'` check alone against the other three tests in this
  // block produced no failure: none of them declare a method without also
  // setting the mode to journal, so removing the mode gate in isolation
  // passed all of them. This test exists to make that removal fail.
  it('writes no file under journal/ when a method was declared but the session mode was never set to journal', async () => {
    const scriptedReflection = emptyReflectionOutput(
      'Considered journaling, stayed in general mode.',
    )
    const chat = new FakeChatProvider([{ text: JSON.stringify(scriptedReflection), toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const sessionId = await engine.startSession(new Date('2026-08-16T09:00:00.000Z'))
    await engine.setSessionJournalMethod(sessionId, 'gratitude')
    await engine.appendTranscript(sessionId, {
      ts: '2026-08-16T09:00:00.000Z',
      role: 'user',
      content: 'Never actually entered journal mode.',
    })
    await engine.endSession(sessionId)
    const rows = await engine.listPublicDocuments()
    expect(rows.find((row) => row.kind === 'journal')).toBeUndefined()
    await engine.close()
  })

  it('writes exactly one file under journal/ for a session whose mode was journal, with the declared method', async () => {
    const scriptedReflection = emptyReflectionOutput('A short gratitude session.')
    const chat = new FakeChatProvider([{ text: JSON.stringify(scriptedReflection), toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const sessionId = await engine.startSession(new Date('2026-08-16T09:00:00.000Z'))
    await engine.setSessionMode(sessionId, 'journal')
    await engine.setSessionJournalMethod(sessionId, 'gratitude')
    await engine.appendTranscript(sessionId, {
      ts: '2026-08-16T09:00:00.000Z',
      role: 'user',
      content: 'Grateful for the quiet morning.',
    })
    await engine.endSession(sessionId)
    const rows = await engine.listPublicDocuments()
    const journalRows = rows.filter((row) => row.kind === 'journal')
    expect(journalRows).toHaveLength(1)
    expect(journalRows[0]?.method).toBe('gratitude')
    const doc = await engine.getPublicDocument(journalRows[0]?.docId ?? '')
    expect(doc?.body).toContain('Grateful for the quiet morning.')
    await engine.close()
  })

  it('writes nothing under journal/ when the mode was journal but no method was ever declared', async () => {
    // Absent method is treated the same as absent mode: the write is
    // additive and gated, not an error. A session cannot reach this
    // state through the real product (declare_journal_method is called
    // as soon as the method is clear), but a test transcript can, and
    // the write must degrade to "no journal document captured," per
    // spec section 11, rather than writing a frontmatter with no method.
    const scriptedReflection = emptyReflectionOutput('Started journal mode, then abandoned it.')
    const chat = new FakeChatProvider([{ text: JSON.stringify(scriptedReflection), toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const sessionId = await engine.startSession(new Date('2026-08-16T09:00:00.000Z'))
    await engine.setSessionMode(sessionId, 'journal')
    await engine.appendTranscript(sessionId, {
      ts: '2026-08-16T09:00:00.000Z',
      role: 'user',
      content: 'Actually, never mind.',
    })
    await engine.endSession(sessionId)
    const rows = await engine.listPublicDocuments()
    expect(rows.find((row) => row.kind === 'journal')).toBeUndefined()
    await engine.close()
  })

  it('survives the engine being closed and reopened between declaring the method and endSession (the crash path)', async () => {
    const scriptedReflection = emptyReflectionOutput('A short gratitude session, reflected late.')
    const startedAt = new Date('2026-08-14T09:00:00.000Z')

    const firstChat = new FakeChatProvider([])
    let engine = await MemoryEngine.open(dir, fakeDeps(firstChat))
    const sessionId = await engine.startSession(startedAt)
    await engine.setSessionMode(sessionId, 'journal')
    await engine.setSessionJournalMethod(sessionId, 'gratitude')
    await engine.appendTranscript(sessionId, {
      ts: startedAt.toISOString(),
      role: 'user',
      content: 'Grateful for a slow start today.',
    })
    // Simulate the process dying before /bye or an orderly endSession:
    // close the engine with the session still unreflected.
    await engine.close()

    const secondChat = new FakeChatProvider([
      { text: JSON.stringify(scriptedReflection), toolCalls: [] },
    ])
    // A fresh MemoryEngine instance, as a later process would construct.
    // MemoryEngine.open runs runMaintenance by default, which reflects
    // any unreflected session it finds, calling _doEndSession on it.
    engine = await MemoryEngine.open(dir, fakeDeps(secondChat))
    const rows = await engine.listPublicDocuments()
    const journalRows = rows.filter((row) => row.kind === 'journal')
    expect(journalRows).toHaveLength(1)
    expect(journalRows[0]?.method).toBe('gratitude')
    const doc = await engine.getPublicDocument(journalRows[0]?.docId ?? '')
    expect(doc?.body).toContain('Grateful for a slow start today.')
    await engine.close()
  })
})

describe('updateJournalingProtocol', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-updatejournaling-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes journaling.md on the first call and reindexes it', async () => {
    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const doc = await engine.updateJournalingProtocol('Gratitude, three times a week.')
    expect(doc.body.trim()).toBe('Gratitude, three times a week.')
    const rows = await engine.listPublicDocuments()
    expect(rows.find((row) => row.kind === 'journaling')?.docId).toBe(doc.meta.id)
    await engine.close()
  })

  it('preserves the id and replaces the body on a second call', async () => {
    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const first = await engine.updateJournalingProtocol('Gratitude, three times a week.')
    const second = await engine.updateJournalingProtocol('Switched to the examen instead.')
    expect(second.meta.id).toBe(first.meta.id)
    expect(second.body).not.toContain('Gratitude')
    await engine.close()
  })

  it('reflection writes and reindexes journaling.md when journalingUpdate is set', async () => {
    const scriptedReflection = {
      ...emptyReflectionOutput('Talked about wanting to journal more.'),
      journalingUpdate: 'Gratitude, three times a week.',
    }
    const chat = new FakeChatProvider([{ text: JSON.stringify(scriptedReflection), toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const sessionId = await engine.startSession(new Date('2026-08-16T09:00:00.000Z'))
    await engine.appendTranscript(sessionId, {
      ts: '2026-08-16T09:00:00.000Z',
      role: 'user',
      content: 'I want to start journaling regularly.',
    })
    await engine.endSession(sessionId)
    const rows = await engine.listPublicDocuments()
    expect(rows.find((row) => row.kind === 'journaling')).toBeDefined()
    const hits = (await engine.search('Gratitude, three times a week')).documents
    expect(hits.some((hit) => hit.kind === 'journaling')).toBe(true)
    await engine.close()
  })
})

// P0-3 (docs/superpowers/specs/2026-08-27-hostable-engine-design.md): the
// engine must never read the ambient timezone or wall clock, since inside
// a Cloudflare Durable Object Intl.DateTimeFormat().resolvedOptions().timeZone
// always resolves to 'UTC' and Date.now() is pinned for the life of one
// request. Both zones below (Pacific/Kiritimati, UTC+14, and Pacific/Midway,
// UTC-11) are chosen because they sit 25 hours apart: at any single instant
// they are on different calendar days from each other, so this cannot pass
// by coincidence with whatever zone the test runner itself happens to be
// in, the failure mode AGENTS.md records from 2026-08-25.
describe('MemoryEngine clock and timezone injection (P0-3)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-p0-3-'))
  })

  afterEach(async () => {
    await rmWithRetry(dir)
  })

  it('names a new session directory by the local day of the injected zone, and two far-apart zones land on different calendar days from the identical pinned instant', async () => {
    const pinnedNow = new Date('2026-08-27T23:30:00.000Z')
    const chat = new FakeChatProvider([])

    const kiritimatiRoot = join(dir, 'kiritimati')
    const midwayRoot = join(dir, 'midway')

    const kiritimatiEngine = await MemoryEngine.open(kiritimatiRoot, {
      ...fakeDeps(chat),
      timezone: 'Pacific/Kiritimati',
      now: () => pinnedNow,
    })
    const midwayEngine = await MemoryEngine.open(midwayRoot, {
      ...fakeDeps(chat),
      timezone: 'Pacific/Midway',
      now: () => pinnedNow,
    })

    try {
      // Neither startSession() call passes a `now` argument: this only
      // proves the injected clock and zone if the default routes through
      // deps.now/deps.timezone rather than a fresh new Date() and Intl read.
      const kiritimatiSessionId = await kiritimatiEngine.startSession()
      const midwaySessionId = await midwayEngine.startSession()

      const kiritimatiEntries = await readdir(memoryPaths(kiritimatiRoot, nodeStores()).sessionsDir)
      const midwayEntries = await readdir(memoryPaths(midwayRoot, nodeStores()).sessionsDir)

      const kiritimatiEntry = kiritimatiEntries.find((name) => name.includes(kiritimatiSessionId))
      const midwayEntry = midwayEntries.find((name) => name.includes(midwaySessionId))
      if (!kiritimatiEntry || !midwayEntry) {
        throw new Error('expected a session directory for each engine')
      }

      expect(kiritimatiEntry.slice(0, 10)).toBe(formatLocalDate(pinnedNow, 'Pacific/Kiritimati'))
      expect(midwayEntry.slice(0, 10)).toBe(formatLocalDate(pinnedNow, 'Pacific/Midway'))
      expect(formatLocalDate(pinnedNow, 'Pacific/Kiritimati')).toBe('2026-08-28')
      expect(formatLocalDate(pinnedNow, 'Pacific/Midway')).toBe('2026-08-27')
      expect(kiritimatiEntry.slice(0, 10)).not.toBe(midwayEntry.slice(0, 10))
    } finally {
      await kiritimatiEngine.close()
      await midwayEngine.close()
    }
  })

  it('draws the dream RNG seed from the injected clock, never from a fresh Date.now() read', async () => {
    const pinnedNow = new Date('2026-08-27T12:00:00.000Z')
    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, {
      ...fakeDeps(chat),
      timezone: 'UTC',
      now: () => pinnedNow,
      dreamingModel: 'fake-dream',
      dreaming: {
        enabled: true,
        cadence: 'daily',
        triggers: { afterSession: false, onStart: false, serverTimer: false },
        maxToolCalls: 10,
      },
    })
    try {
      // dryRun: true reaches the rngSeed line (both maybeDream and
      // dreamNow compute it before any due-ness gate that dryRun would
      // trip) without touching the chat provider or the dream lock, so a
      // spy on the real clock is the whole test.
      const dateNowSpy = vi.spyOn(Date, 'now')
      await engine.dreamNow({ dryRun: true })
      expect(dateNowSpy).not.toHaveBeenCalled()
      dateNowSpy.mockRestore()
    } finally {
      await engine.close()
    }
  })

  it("engine.timezone() falls back to deps.timezone, not the machine's own zone, when profile.md carries none", async () => {
    // The profile.md rewrite has to happen BEFORE MemoryEngine.open, not
    // against an already-open engine: profileCache is read once at
    // construction (fromPaths's loadProfile call) and never refreshed by a
    // writeProfile call this test makes directly, so mutating the file
    // under a live engine would silently test the stale in-memory cache
    // instead of the fallback this test is named for.
    const paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
    const seeded = await loadProfile(paths, 'UTC')
    // Strips the timezone ensureMemoryTree just seeded, the same shape a
    // hand-edited or pre-P0-3 profile.md can be in. profileMetaSchema
    // accepts this (see profile.test.ts: "accepts a document with no
    // timezone at all").
    const { timezone: _dropped, timezoneSource: _droppedSource, ...rest } = seeded.meta
    await writeProfile(paths, { meta: rest, body: seeded.body })

    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, {
      ...fakeDeps(chat),
      timezone: 'Pacific/Kiritimati',
    })
    try {
      expect(engine.timezone()).toBe('Pacific/Kiritimati')
    } finally {
      await engine.close()
    }
  })
})
