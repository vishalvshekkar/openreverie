import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
})
