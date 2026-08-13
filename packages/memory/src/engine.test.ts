import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { FakeChatProvider, FakeEmbeddingProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listDocuments, newId, readDocument, writeDocumentAtomic } from './documents.js'
import { type EngineDeps, MemoryEngine } from './engine.js'
import { appendGraph, readGraph } from './graph.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'
import { appendProposals, type Proposal, pendingProposals } from './proposals.js'
import { applyReflection, type ReflectionItem, type ReflectionOutput } from './reflection.js'
import { SessionStore } from './transcripts.js'

const execFileAsync = promisify(execFile)

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function emptyReflectionOutput(summary: string): ReflectionOutput {
  return {
    summary,
    items: [],
    attributions: [],
    newArcs: [],
    newPersons: [],
    arcNarratives: [],
    constitutionUpdate: null,
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

describe('MemoryEngine', () => {
  describe('full session lifecycle', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-'))
      paths = memoryPaths(dir)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('captures a session, reflects it, and produces a rebuildable, searchable index with git history', async () => {
      // Pre-seed an arc and its realm so the scripted reflection can
      // attribute an item to it with high confidence.
      await ensureMemoryTree(paths)
      const arcDocId = newId('doc')
      const arcDocPath = join(paths.arcsDir, 'health.md')
      await writeDocumentAtomic({
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
          },
        ],
        newPersons: [],
        arcNarratives: [],
        constitutionUpdate: null,
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
      const sessionDir = join(paths.sessionsDir, `${isoDate(startedAt)}-${sessionId}`)
      const summaryDoc = await readDocument(join(sessionDir, 'summary.md'))
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

      // The new-arc suggestion is a pending proposal, not an auto-created arc.
      const pending = await pendingProposals(paths)
      const newArcProposal = pending.find((p) => p.kind === 'new_arc')
      expect(newArcProposal).toBeDefined()
      expect(newArcProposal?.payload).toEqual({
        name: 'presentation prep',
        realm: 'realm_health',
        itemIds: [anxiousItem.id],
      })
      expect(engine.listArcs()).toHaveLength(1)
      expect(engine.listRealms()).toHaveLength(1)

      // graphQuery surfaces the item filed under the pre-existing arc.
      const arcItems = engine.graphQuery({ kind: 'items_in_arc', arcId: 'arc_health' })
      expect(arcItems).toHaveLength(1)

      // readDocumentById resolves through the engine's document cache.
      const byId = await engine.readDocumentById(summaryDoc.meta.id as string)
      expect(byId?.path).toBe(join(sessionDir, 'summary.md'))

      // Search finds the reflected item text.
      const hits = await engine.search('anxious')
      expect(hits.length).toBeGreaterThan(0)

      // Prove index.db is fully rebuildable from the folder: delete it,
      // reopen (which does not itself reindex documents), confirm the
      // index really is empty, then reindexAll and confirm search works
      // again.
      await engine.close()
      await rm(paths.indexDb)

      engine = await MemoryEngine.open(dir, deps)
      const hitsBeforeRebuild = await engine.search('anxious')
      expect(hitsBeforeRebuild).toEqual([])

      await engine.reindexAll()
      const hitsAfterRebuild = await engine.search('anxious')
      expect(hitsAfterRebuild.length).toBeGreaterThan(0)

      await engine.close()

      const log = await execFileAsync('git', ['-C', dir, 'log', '--oneline'])
      const commitLines = log.stdout.trim().split('\n').filter(Boolean)
      expect(commitLines.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('runMaintenance', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-maint-'))
      paths = memoryPaths(dir)
      await ensureMemoryTree(paths)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
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
      await staleStore.appendLine({
        ts: twoDaysAgo.toISOString(),
        role: 'user',
        content: 'A stale session about work stress that never got reflected.',
      })

      // Yesterday: already reflected (has a summary), but no daily rollup
      // has been built for that date yet.
      const yesterdayStore = await SessionStore.start(paths, yesterday)
      await yesterdayStore.appendLine({
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

      const staleDate = isoDate(twoDaysAgo)
      const staleSummary = await readDocument(
        join(paths.sessionsDir, `${staleDate}-${staleStore.sessionId}`, 'summary.md'),
      )
      expect(staleSummary.body.length).toBeGreaterThan(0)

      const staleDaily = await readDocument(join(paths.rollupsDailyDir, `${staleDate}.md`))
      expect(staleDaily.body.length).toBeGreaterThan(0)

      const yesterdayDate = isoDate(yesterday)
      const yesterdayDaily = await readDocument(join(paths.rollupsDailyDir, `${yesterdayDate}.md`))
      expect(yesterdayDaily.body.length).toBeGreaterThan(0)

      await engine.close()
    })
  })

  describe('resolveProposal materialization', () => {
    let dir: string
    let paths: MemoryPaths
    let engine: MemoryEngine

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-proposals-'))
      paths = memoryPaths(dir)
      await ensureMemoryTree(paths)
      engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    })

    afterEach(async () => {
      await engine.close()
      await rm(dir, { recursive: true, force: true })
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
      await appendProposals(paths, [proposal])

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
      const arcDoc = await readDocument(arcNode.doc)
      expect(arcDoc.meta.status).toBe('active')
      expect(arcDoc.meta.realm).toBe(realmNode.id)
      expect(arcDoc.body).toBe('This arc is new. It grows as we talk.\n')

      const realmDoc = await readDocument(realmNode.doc)
      expect(realmDoc.body).toBe('This realm is new. It grows as we talk.\n')

      expect(engine.listArcs().some((n) => n.id === arcNode.id)).toBe(true)
      expect(engine.listRealms().some((n) => n.id === realmNode.id)).toBe(true)
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
      await appendProposals(paths, [first])
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
      await appendProposals(paths, [second])
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

      const arcDocs = await listDocuments(paths.arcsDir)
      const filenames = arcDocs.map((d) => d.path.split('/').pop())
      expect(filenames).toContain('marathon-training.md')
      expect(filenames).toContain('marathon-training-2.md')
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
      await appendProposals(paths, [proposal])

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
      await appendProposals(paths, [proposal])

      await engine.resolveProposal(proposal.id, 'rejected')

      const pending = await pendingProposals(paths)
      expect(pending.find((p) => p.id === proposal.id)).toBeUndefined()

      const graph = await readGraph(paths)
      expect([...graph.nodes.values()].some((n) => n.label === 'Ghost Arc')).toBe(false)
      expect([...graph.nodes.values()].some((n) => n.label === 'Ghost Realm')).toBe(false)

      const arcDocs = await listDocuments(paths.arcsDir)
      expect(arcDocs.some((d) => d.meta.name === 'Ghost Arc')).toBe(false)
    })
  })
})
