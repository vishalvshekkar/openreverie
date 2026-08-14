import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  type EmbeddingProvider,
  FakeChatProvider,
  FakeEmbeddingProvider,
} from '@openreverie/providers'
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
    arcUpdates: [],
    personUpdates: [],
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

// An EmbeddingProvider that always fails, used to prove that a document's
// caller (e.g. createPersonPage) survives an indexing failure instead of
// throwing out of it, the same guarantee reindexOrWarn gives every other
// caller.
class ThrowingEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'throwing'

  async embed(_model: string, _texts: string[]): Promise<number[][]> {
    throw new Error('embeddings unavailable')
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
            narrative: 'Presentation prep starts here.',
          },
        ],
        newPersons: [],
        arcUpdates: [],
        personUpdates: [],
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

      // The new arc is materialized directly by reflection, with no proposal.
      const pending = await pendingProposals(paths)
      expect(pending.find((p) => p.kind === 'new_arc')).toBeUndefined()
      const newArc = engine.listArcs().find((n) => n.label === 'presentation prep')
      if (!newArc?.doc) throw new Error('expected the new arc to have a doc pointer')
      expect(await readDocument(newArc.doc)).toMatchObject({
        body: 'Presentation prep starts here.\n',
      })
      // Direct materialization from reflection: nobody affirmed this arc,
      // so confirmed is false, unlike an accepted proposal's confirmed: true.
      expect(graph.edges.get(`part_of:${anxiousItem.id}:${newArc.id}`)).toMatchObject({
        confidence: 1,
        confirmed: false,
      })
      expect(engine.listArcs()).toHaveLength(2)
      expect(engine.listRealms()).toHaveLength(1)

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
        new Map(),
        async () => {},
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
      await appendProposals(paths, [proposal])

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

      const arcDoc = await readDocument(arcNode.doc)
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
      await appendProposals(paths, [proposal])

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

      const personDoc = await readDocument(personNode.doc)
      expect(personDoc.path).toBe(join(paths.peopleDir, 'sam.md'))
      expect(personDoc.meta.name).toBe('Sam')
      expect(personDoc.meta.node).toBe(personNode.id)
      expect(typeof personDoc.meta.opened).toBe('string')
      expect(personDoc.body).toBe('This page is new. It grows as we talk.\n')

      const hits = await engine.search('grows as we talk')
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
      await appendProposals(paths, [proposal])

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

      const personDoc = await readDocument(personNode.doc)
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
      await appendProposals(paths, [first])
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
      await appendProposals(paths, [second])
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

      const firstDoc = await readDocument(firstNode.doc)
      const secondDoc = await readDocument(secondNode.doc)
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

  describe('reflection materializes directly, proposals stay dormant', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-save-by-default-'))
      paths = memoryPaths(dir)
      await ensureMemoryTree(paths)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
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

      const arcDoc = await readDocument(arcNode.doc)
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

      const personDoc = await readDocument(personNode.doc)
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

      const arcDoc = await readDocument(arcNode.doc)
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

      const personDoc = await readDocument(personNode.doc)
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

    it('a pre-existing pending proposal still surfaces in sessionContext and still resolves end to end', async () => {
      const proposal: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'new_arc',
        summary: 'A proposal that predates this release.',
        payload: { name: 'Legacy Arc', realm: 'Legacy Realm', itemIds: [newId('item')] },
        source: 'session_legacy',
      }
      await appendProposals(paths, [proposal])

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

      const context = await engine.sessionContext()
      expect(context.pendingProposals.map((p) => p.id)).toContain(proposal.id)

      await engine.resolveProposal(proposal.id, 'accepted')

      const graph = await readGraph(paths)
      const arcNode = [...graph.nodes.values()].find(
        (n) => n.type === 'arc' && n.label === 'Legacy Arc',
      )
      expect(arcNode).toBeDefined()

      const pending = await pendingProposals(paths)
      expect(pending.find((p) => p.id === proposal.id)).toBeUndefined()

      await engine.close()
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
      await writeDocumentAtomic({
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

      const arcDoc = await readDocument(arcDocPath)
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

      const sessionDir = join(paths.sessionsDir, `${isoDate(new Date())}-${sessionId}`)
      await expect(readDocument(join(sessionDir, 'summary.md'))).rejects.toThrow()

      const graph = await readGraph(paths)
      expect([...graph.nodes.values()].some((n) => n.label === 'Marathon Training')).toBe(false)

      // Retryable: with the permission restored, endSession on the same
      // sessionId (still unreflected, since summary.md never landed) now
      // succeeds and actually creates the arc.
      await engine.endSession(sessionId)
      const summaryDoc = await readDocument(join(sessionDir, 'summary.md'))
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
      await staleStore.appendLine({
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
      // runMaintenance's loop has always swallowed: no warning is recorded,
      // and the retry on the next pass is the recovery.
      expect(engine.warnings).toEqual([])

      const staleSessionDir = join(
        paths.sessionsDir,
        `${isoDate(twoDaysAgo)}-${staleStore.sessionId}`,
      )
      await expect(readDocument(join(staleSessionDir, 'summary.md'))).rejects.toThrow()

      const graph = await readGraph(paths)
      expect([...graph.nodes.values()].some((n) => n.label === 'Marathon Training')).toBe(false)

      // arcsDir is writable again now; a second scripted reflection lets
      // the retry actually succeed.
      script.push({ text: JSON.stringify(out), toolCalls: [] })
      await engine.runMaintenance()

      expect(engine.warnings).toEqual([])
      const summaryDoc = await readDocument(join(staleSessionDir, 'summary.md'))
      expect(summaryDoc.body.length).toBeGreaterThan(0)
      const graphAfterRetry = await readGraph(paths)
      expect([...graphAfterRetry.nodes.values()].some((n) => n.label === 'Marathon Training')).toBe(
        true,
      )

      await engine.close()
    })
  })

  describe('peopleDir indexing', () => {
    let dir: string
    let paths: MemoryPaths
    let engine: MemoryEngine

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-people-'))
      paths = memoryPaths(dir)
      await ensureMemoryTree(paths)
      engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    })

    afterEach(async () => {
      await engine.close()
      await rm(dir, { recursive: true, force: true })
    })

    it('reindexAll walks peopleDir and indexes person pages under kind person', async () => {
      const personDocId = newId('doc')
      const personDocPath = join(paths.peopleDir, 'sam.md')
      await writeDocumentAtomic({
        path: personDocPath,
        meta: { id: personDocId, name: 'Sam' },
        body: 'Sam is a close friend who shows up in a lot of stories about kayaking.\n',
      })

      await engine.reindexAll()

      const hits = await engine.search('kayaking')
      expect(hits.some((h) => h.docId === personDocId && h.kind === 'person')).toBe(true)

      const filteredHits = await engine.search('kayaking', { kinds: ['person'] })
      expect(filteredHits.some((h) => h.docId === personDocId)).toBe(true)
    })
  })

  describe('docIdForPath and graph_query docId', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-docid-'))
      paths = memoryPaths(dir)
      await ensureMemoryTree(paths)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('resolves a doc path to its document id, and carries docId on graph nodes that have a doc but not on ones that do not', async () => {
      const arcDocId = newId('doc')
      const arcDocPath = join(paths.arcsDir, 'health.md')
      await writeDocumentAtomic({
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
      paths = memoryPaths(dir)
      await ensureMemoryTree(paths)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
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
        `${isoDate(startedAt)}-${sessionId}`,
        'summary.md',
      )
      const hits = await engine.search('reflection')
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

  describe('malformed documents do not brick the engine', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-corrupt-'))
      paths = memoryPaths(dir)
      await ensureMemoryTree(paths)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
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

      await expect(readDocument(corruptPath)).rejects.toThrow(corruptPath)
    })
  })

  describe('reindexAll true full rebuild', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-reindex-'))
      paths = memoryPaths(dir)
      await ensureMemoryTree(paths)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('drops rows for documents whose source file was deleted, not just upserts current ones', async () => {
      const tempRealmDocId = newId('doc')
      const tempRealmPath = join(paths.realmsDir, 'temp-realm.md')
      await writeDocumentAtomic({
        path: tempRealmPath,
        meta: { id: tempRealmDocId, name: 'Temp Realm' },
        body: 'A realm about kayaking expeditions.\n',
      })

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      await engine.reindexAll()

      const hitsBeforeDelete = await engine.search('kayaking')
      expect(hitsBeforeDelete.some((h) => h.docId === tempRealmDocId)).toBe(true)

      await rm(tempRealmPath)
      await engine.reindexAll()

      // The orphaned row for the deleted file must be gone, not just
      // out-ranked: a vector-search fallback can still surface unrelated
      // documents for any query, so absence of the specific docId is the
      // correct assertion, not an empty result set.
      const hitsAfterDelete = await engine.search('kayaking')
      expect(hitsAfterDelete.some((h) => h.docId === tempRealmDocId)).toBe(false)

      await engine.close()
    })
  })

  describe('sessionContext', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-context-'))
      paths = memoryPaths(dir)
      await ensureMemoryTree(paths)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('includes only active arcs, alongside the constitution text and pending proposals', async () => {
      const activeArcId = 'arc_active'
      const dormantArcId = 'arc_dormant'
      const activeArcPath = join(paths.arcsDir, 'active-arc.md')
      const dormantArcPath = join(paths.arcsDir, 'dormant-arc.md')
      await writeDocumentAtomic({
        path: activeArcPath,
        meta: { id: newId('doc'), name: 'Active Arc', status: 'active' },
        body: 'Still going.\n',
      })
      await writeDocumentAtomic({
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

      const proposal: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'link',
        summary: 'Pending link proposal for the context test.',
        payload: { edge: 'part_of', from: newId('item'), to: activeArcId, confidence: 0.5 },
        source: 'session_seed',
      }
      await appendProposals(paths, [proposal])

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

      const context = await engine.sessionContext()

      expect(context.arcs.map((a) => a.id)).toEqual([activeArcId])
      expect(context.arcs[0]?.status).toBe('active')
      expect(context.constitution.length).toBeGreaterThan(0)
      expect(context.pendingProposals.map((p) => p.id)).toContain(proposal.id)

      await engine.close()
    })
  })

  describe('sessionContext recentSummaries', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-recent-'))
      paths = memoryPaths(dir)
      await ensureMemoryTree(paths)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    async function reflectedSessionOn(date: Date, body: string): Promise<void> {
      const store = await SessionStore.start(paths, date)
      await store.appendLine({ ts: date.toISOString(), role: 'user', content: body })
      await writeDocumentAtomic({
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
      await store.appendLine({
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
  })

  describe('sessionContext isFirstSession', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-firstsession-'))
      paths = memoryPaths(dir)
      await ensureMemoryTree(paths)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
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

    it('is false when an arc exists, even a dormant one, with no reflected sessions', async () => {
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

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

      const context = await engine.sessionContext()

      expect(context.isFirstSession).toBe(false)

      await engine.close()
    })
  })

  describe('warnings', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-warnings-'))
      paths = memoryPaths(dir)
      await ensureMemoryTree(paths)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
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
      await staleStore1.appendLine({
        ts: threeDaysAgo.toISOString(),
        role: 'user',
        content: 'First stale session.',
      })

      const staleStore2 = await SessionStore.start(paths, twoDaysAgo)
      await staleStore2.appendLine({
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
  })

  describe('forget', () => {
    let forgetDir: string
    let forgetPaths: MemoryPaths

    beforeEach(async () => {
      forgetDir = await mkdtemp(join(tmpdir(), 'openreverie-engine-forget-'))
      forgetPaths = memoryPaths(forgetDir)
    })

    afterEach(async () => {
      await rm(forgetDir, { recursive: true, force: true })
    })

    it('retracts requested nodes and edges: foldGraph drops them, and the tool reports what actually changed', async () => {
      await ensureMemoryTree(forgetPaths)
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
      await ensureMemoryTree(forgetPaths)
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
      await ensureMemoryTree(forgetPaths)
      const docId = newId('doc')
      const docPath = join(forgetPaths.arcsDir, 'marathon.md')
      await writeDocumentAtomic({
        path: docPath,
        meta: { id: docId, name: 'Marathon training', status: 'active' },
        body: 'Training for the spring marathon.\n',
      })

      const engine = await MemoryEngine.open(forgetDir, fakeDeps(new FakeChatProvider([])))

      await expect(
        engine.forget({ what: 'the marathon plan', documents: [{ docId, body: '   \n  ' }] }),
      ).rejects.toThrow(/empty|whitespace/)

      const stillThere = await readDocument(docPath)
      expect(stillThere.body).toBe('Training for the spring marathon.\n')

      await engine.close()
    })

    it('rewrites a document atomically when the new body is real content', async () => {
      await ensureMemoryTree(forgetPaths)
      const docId = newId('doc')
      const docPath = join(forgetPaths.arcsDir, 'marathon.md')
      await writeDocumentAtomic({
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
      const rewritten = await readDocument(docPath)
      expect(rewritten.body).toBe('Training for the spring marathon.\n')

      await engine.close()
    })

    it('never writes to a transcript or a session summary', async () => {
      await ensureMemoryTree(forgetPaths)
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

      const sessionDir = join(forgetPaths.sessionsDir, `${isoDate(startedAt)}-${sessionId}`)
      const transcriptPath = join(sessionDir, 'transcript.jsonl')
      const before = await readFile(transcriptPath, 'utf8')

      await engine.forget({ what: 'the falling out with Jo', nodeIds: ['person_z'] })

      const after = await readFile(transcriptPath, 'utf8')
      expect(after).toBe(before)
      await expect(readDocument(join(sessionDir, 'summary.md'))).rejects.toThrow()

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
      await ensureMemoryTree(forgetPaths)

      const summaryId = newId('doc')
      const summaryDir = join(forgetPaths.sessionsDir, '2026-08-01-session_fake')
      await mkdir(summaryDir, { recursive: true })
      const summaryPath = join(summaryDir, 'summary.md')
      await writeDocumentAtomic({
        path: summaryPath,
        meta: { id: summaryId, session: 'session_fake' },
        body: 'What actually happened in this session.\n',
      })

      const rollupId = newId('doc')
      const rollupPath = join(forgetPaths.rollupsDailyDir, '2026-08-01.md')
      await writeDocumentAtomic({
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

      const summaryAfter = await readDocument(summaryPath)
      expect(summaryAfter.body).toBe('What actually happened in this session.\n')
      const rollupAfter = await readDocument(rollupPath)
      expect(rollupAfter.body).toBe('The daily rollup for that date.\n')

      await engine.close()
    })

    it('commits the change with message "forget: <what>"', async () => {
      await ensureMemoryTree(forgetPaths)
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
})

describe('buildReflectionContext people wiring', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-people-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
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
})
