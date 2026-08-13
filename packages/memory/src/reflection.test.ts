import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeChatProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listDocuments, newId, readDocument, writeDocumentAtomic } from './documents.js'
import { appendGraph, readGraph } from './graph.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'
import { pendingProposals } from './proposals.js'
import {
  applyReflection,
  CONFIDENCE_THRESHOLD,
  type ReflectionItem,
  type ReflectionOutput,
  reflectSession,
} from './reflection.js'
import type { TranscriptLine } from './transcripts.js'

const TRANSCRIPT: TranscriptLine[] = [
  { ts: '2026-08-13T09:00:00.000Z', role: 'user', content: 'I went for a long run this morning.' },
  {
    ts: '2026-08-13T09:01:00.000Z',
    role: 'assistant',
    content: 'That sounds like a good start to the day.',
  },
]

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

describe('reflection', () => {
  let dir: string
  let paths: MemoryPaths
  let sessionId: string
  let sessionDir: string
  let arcDocPath: string
  let arcDocId: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-memory-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    sessionId = newId('session')
    sessionDir = join(paths.sessionsDir, `2026-08-13-${sessionId}`)
    await mkdir(sessionDir, { recursive: true })

    arcDocPath = join(paths.arcsDir, 'health.md')
    arcDocId = newId('doc')
    await writeDocumentAtomic({
      path: arcDocPath,
      meta: { id: arcDocId, name: 'Health' },
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
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  describe('reflectSession', () => {
    it('parses a valid scripted reply on the first try', async () => {
      const out = emptyReflectionOutput('A quiet, reflective session.')
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])

      const result = await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'Empty constitution.',
        arcs: [],
        realms: [],
      })

      expect(result).toEqual(out)
      expect(chat.requests).toHaveLength(1)
    })

    it('includes the constitution, arc and realm listings with ids, and the transcript in the prompt', async () => {
      const out = emptyReflectionOutput('A quiet, reflective session.')
      const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])

      await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'The user values honesty over comfort.',
        arcs: [{ id: 'arc_health', type: 'arc', label: 'Health', ts: '2026-08-01T00:00:00.000Z' }],
        realms: [
          { id: 'realm_health', type: 'realm', label: 'Health', ts: '2026-08-01T00:00:00.000Z' },
        ],
      })

      const prompt = chat.requests[0]?.messages[0]?.content ?? ''
      expect(prompt).toContain('The user values honesty over comfort.')
      expect(prompt).toContain('arc_health: Health')
      expect(prompt).toContain('realm_health: Health')
      expect(prompt).toContain('user: I went for a long run this morning.')
      expect(prompt).toContain('assistant: That sounds like a good start to the day.')
      expect(prompt).toContain('"constitutionUpdate": string | null')
    })

    it('retries once when the reply is valid JSON but fails schema validation', async () => {
      const out = emptyReflectionOutput('Recovered after a schema failure.')
      const chat = new FakeChatProvider([
        { text: '{"summary": 123, "items": []}', toolCalls: [] },
        { text: JSON.stringify(out), toolCalls: [] },
      ])

      const result = await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'Empty constitution.',
        arcs: [],
        realms: [],
      })

      expect(result).toEqual(out)
      expect(chat.requests).toHaveLength(2)
      const retryPrompt = chat.requests[1]?.messages[0]?.content ?? ''
      expect(retryPrompt).toContain('failed validation')
      expect(retryPrompt).toContain('summary')
    })

    it('retries once on malformed JSON and consumes the second scripted result', async () => {
      const out = emptyReflectionOutput('Recovered after a retry.')
      const chat = new FakeChatProvider([
        { text: 'this is not json', toolCalls: [] },
        { text: JSON.stringify(out), toolCalls: [] },
      ])

      const result = await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'Empty constitution.',
        arcs: [],
        realms: [],
      })

      expect(result).toEqual(out)
      expect(chat.requests).toHaveLength(2)
      expect(chat.requests[1]?.messages[0]?.content).toContain('failed validation')
      expect(chat.requests[1]?.messages[0]?.content).toContain('this is not json')
    })

    it('degrades to a summary-only result after two malformed replies', async () => {
      const chat = new FakeChatProvider([
        { text: 'still not json', toolCalls: [] },
        { text: 'also not json', toolCalls: [] },
      ])

      const result = await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'Empty constitution.',
        arcs: [],
        realms: [],
      })

      expect(result).toEqual({ summary: 'also not json', degraded: true })
      expect(chat.requests).toHaveLength(2)
    })

    it('falls back to a plain line when the second reply has no usable text', async () => {
      const chat = new FakeChatProvider([
        { text: 'not json', toolCalls: [] },
        { text: '   ', toolCalls: [] },
      ])

      const result = await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'Empty constitution.',
        arcs: [],
        realms: [],
      })

      expect(result).toEqual({
        summary: 'Reflection could not be parsed for this session.',
        degraded: true,
      })
    })
  })

  describe('applyReflection', () => {
    const now = new Date('2026-08-13T10:00:00.000Z')

    it('writes the summary, splits attributions by confidence, and queues proposals', async () => {
      const out: ReflectionOutput = {
        summary: 'Talked about a morning run and an upcoming deadline.',
        items: [
          { text: 'Went for a long run', kind: 'event' },
          { text: 'Feeling anxious about a work deadline', kind: 'feeling' },
        ],
        attributions: [
          { itemIndex: 0, arcId: 'arc_health', confidence: 0.9 },
          { itemIndex: 1, arcId: 'arc_unknown', confidence: 0.3 },
        ],
        newArcs: [
          {
            name: 'marathon training',
            realm: 'realm_health',
            reason: 'mentioned running multiple times',
            itemIndexes: [0],
          },
        ],
        newPersons: [
          {
            name: 'Sam',
            reason: 'mentioned as a running partner',
            itemIndexes: [1],
          },
        ],
        arcNarratives: [{ arcId: 'arc_health', narrative: 'Training is going well.' }],
        constitutionUpdate: null,
      }

      const result = await applyReflection(paths, out, sessionId, [], now)

      // Summary document
      expect(result.summaryDoc.meta.kind).toBe('summary')
      expect(result.summaryDoc.meta.session).toBe(sessionId)
      expect(result.summaryDoc.meta.date).toBe('2026-08-13')
      expect(result.summaryDoc.body).toBe(`${out.summary}\n`)
      const items = result.summaryDoc.meta.items as ReflectionItem[]
      expect(items).toHaveLength(2)
      expect(items[0]?.text).toBe('Went for a long run')
      expect(items[0]?.kind).toBe('event')
      expect(items[0]?.ts).toBe(now.toISOString())
      expect(items[1]?.text).toBe('Feeling anxious about a work deadline')

      const onDisk = await readDocument(join(sessionDir, 'summary.md'))
      expect(onDisk.body).toBe(result.summaryDoc.body)

      // Graph: item nodes, from-edges, and the confidence split
      const graph = await readGraph(paths)
      const runItem = items[0] as ReflectionItem
      const deadlineItem = items[1] as ReflectionItem

      expect(graph.nodes.get(runItem.id)).toMatchObject({
        type: 'item',
        label: 'Went for a long run',
        doc: join(sessionDir, 'summary.md'),
      })
      expect(graph.edges.get(`from:${runItem.id}:${sessionId}`)).toMatchObject({ confirmed: true })

      const partOfKey = `part_of:${runItem.id}:arc_health`
      expect(graph.edges.get(partOfKey)).toMatchObject({
        confidence: 0.9,
        confirmed: false,
      })
      expect(result.autoAsserted).toBe(1)

      // Low confidence attribution is not asserted as an edge
      expect(graph.edges.get(`part_of:${deadlineItem.id}:arc_unknown`)).toBeUndefined()

      // Proposals: the low-confidence link, the new arc, and the new person,
      // never auto-created into the graph or the arcs directory.
      const proposals = await pendingProposals(paths)
      expect(proposals).toHaveLength(3)
      expect(result.proposals).toHaveLength(3)

      const linkProposal = proposals.find((p) => p.kind === 'link')
      expect(linkProposal).toBeDefined()
      expect(linkProposal?.payload).toEqual({
        edge: 'part_of',
        from: deadlineItem.id,
        to: 'arc_unknown',
        confidence: 0.3,
      })
      expect(linkProposal?.summary.length).toBeGreaterThan(0)

      const newArcProposal = proposals.find((p) => p.kind === 'new_arc')
      expect(newArcProposal).toBeDefined()
      expect(newArcProposal?.payload).toEqual({
        name: 'marathon training',
        realm: 'realm_health',
        itemIds: [runItem.id],
      })
      expect(newArcProposal?.summary.length).toBeGreaterThan(0)

      const newPersonProposal = proposals.find((p) => p.kind === 'new_person')
      expect(newPersonProposal).toBeDefined()
      expect(newPersonProposal?.payload).toEqual({
        name: 'Sam',
        itemIds: [deadlineItem.id],
      })
      expect(newPersonProposal?.summary.length).toBeGreaterThan(0)

      // Nothing proposed was auto-created: only the seeded arc node exists,
      // no person node exists, and no new arc document landed on disk.
      const arcNodes = [...graph.nodes.values()].filter((node) => node.type === 'arc')
      expect(arcNodes).toHaveLength(1)
      expect(arcNodes[0]?.id).toBe('arc_health')
      const personNodes = [...graph.nodes.values()].filter((node) => node.type === 'person')
      expect(personNodes).toHaveLength(0)
      const arcDocs = await listDocuments(paths.arcsDir)
      expect(arcDocs).toHaveLength(1)

      // Arc narrative rewritten atomically, meta preserved except updated
      const arcDoc = await readDocument(arcDocPath)
      expect(arcDoc.body).toBe('Training is going well.\n')
      expect(arcDoc.meta.id).toBe(arcDocId)
      expect(arcDoc.meta.name).toBe('Health')
      expect(arcDoc.meta.updated).toBe(now.toISOString())

      // Constitution untouched when constitutionUpdate is null
      const constitutionDoc = await readDocument(paths.constitution)
      expect(constitutionDoc.body).toBe('This constitution is empty. It grows as we talk.\n')
      expect(constitutionDoc.meta.updated).toBeUndefined()
    })

    it('rewrites the constitution when constitutionUpdate is set', async () => {
      const out = {
        ...emptyReflectionOutput('A session that touched something foundational.'),
        constitutionUpdate: 'Updated constitution body.',
      }

      await applyReflection(paths, out, sessionId, [], now)

      const constitutionDoc = await readDocument(paths.constitution)
      expect(constitutionDoc.body).toBe('Updated constitution body.\n')
      expect(constitutionDoc.meta.updated).toBe(now.toISOString())
    })

    it('still writes summary.md for a degraded, summary-only reflection', async () => {
      const chat = new FakeChatProvider([
        { text: 'nope', toolCalls: [] },
        { text: 'still nope', toolCalls: [] },
      ])

      const degraded = await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
        constitution: 'Empty constitution.',
        arcs: [],
        realms: [],
      })
      expect('degraded' in degraded && degraded.degraded).toBe(true)

      // The engine wraps a degraded result into a full ReflectionOutput before
      // calling applyReflection; this test exercises that wrapped shape.
      const wrapped = emptyReflectionOutput((degraded as { summary: string }).summary)
      const result = await applyReflection(paths, wrapped, sessionId, [], now)

      expect(result.summaryDoc.body).toBe('still nope\n')
      expect(result.summaryDoc.meta.items).toEqual([])
      expect(result.autoAsserted).toBe(0)
      expect(result.proposals).toHaveLength(0)

      const onDisk = await readDocument(join(sessionDir, 'summary.md'))
      expect(onDisk.body).toBe('still nope\n')
    })

    it('dedupes live items against minted items by case-insensitive exact text', async () => {
      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A run and a phone call.'),
        items: [{ text: 'Went for a run', kind: 'event' }],
      }
      const liveItems: ReflectionItem[] = [
        {
          id: newId('item'),
          text: 'went for a run',
          kind: 'event',
          ts: '2026-08-13T08:00:00.000Z',
        },
        { id: newId('item'), text: 'Called mom', kind: 'event', ts: '2026-08-13T08:05:00.000Z' },
      ]

      const result = await applyReflection(paths, out, sessionId, liveItems, now)

      const items = result.summaryDoc.meta.items as ReflectionItem[]
      expect(items).toHaveLength(2)
      expect(items.map((item) => item.text)).toEqual(['Went for a run', 'Called mom'])
      expect(items[1]?.id).toBe(liveItems[1]?.id)

      const graph = await readGraph(paths)
      expect(graph.nodes.has(liveItems[1]?.id as string)).toBe(true)
      // The duplicate live item never got its own node under a new id.
      expect(graph.nodes.has(liveItems[0]?.id as string)).toBe(false)
    })
  })

  it('CONFIDENCE_THRESHOLD is 0.8', () => {
    expect(CONFIDENCE_THRESHOLD).toBe(0.8)
  })
})
