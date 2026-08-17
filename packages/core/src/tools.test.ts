import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendGraph,
  type EngineDeps,
  MemoryEngine,
  memoryPaths,
  newId,
  readDocument,
  writeDocumentAtomic,
} from '@openreverie/memory'
import { FakeChatProvider, FakeEmbeddingProvider, type ToolCall } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StyleConfig } from './config.js'
import { dispatchTool, type ToolDeps, toolDefinitions } from './tools.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openreverie-tools-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function fakeDeps(chat: FakeChatProvider = new FakeChatProvider([])): EngineDeps {
  return {
    chat,
    embeddings: new FakeEmbeddingProvider(),
    reflectionModel: 'fake-reflect',
    embeddingModel: 'fake-embed',
  }
}

function call(name: string, args: unknown): ToolCall {
  return { id: 'call_1', name, arguments: JSON.stringify(args) }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

// ReflectionOutput itself is not part of @openreverie/memory's public
// surface, so this mirrors its shape structurally rather than importing
// the type. FakeChatProvider only needs the JSON text to match on parse.
function emptyReflectionOutput(summary: string) {
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
  }
}

describe('toolDefinitions', () => {
  it('lists exactly the eight memory and style tools with non-empty descriptions and a JSON schema', () => {
    const defs = toolDefinitions()
    const names = defs.map((d) => d.name).sort()
    expect(names).toEqual(
      [
        'graph_query',
        'list_arcs',
        'list_realms',
        'read_document',
        'read_transcript',
        'remember',
        'search_memory',
        'update_style',
      ].sort(),
    )
    for (const def of defs) {
      expect(def.description.length).toBeGreaterThan(20)
      expect(def.parameters).toMatchObject({ type: 'object' })
    }
  })

  // resolve_proposal is the literal cause of the dogfooding failure this
  // round of work fixes: it is what let the model ask permission to
  // remember something. Asking is removed entirely, not narrowed, so this
  // guards against the tool coming back on the list by accident.
  it('does not list a resolve_proposal tool: asking permission to remember is removed entirely', () => {
    const defs = toolDefinitions()
    const names = defs.map((d) => d.name)
    expect(names).not.toContain('resolve_proposal')
  })

  it('never uses an em dash in a tool description', () => {
    const emDash = String.fromCharCode(0x2014)
    for (const def of toolDefinitions()) {
      expect(def.description).not.toContain(emDash)
    }
  })

  it('lists person among the valid kinds for search_memory', () => {
    const defs = toolDefinitions()
    const searchMemory = defs.find((d) => d.name === 'search_memory')
    if (!searchMemory) throw new Error('expected a search_memory tool definition')
    const kinds = (searchMemory.parameters as { properties: { kinds: { description: string } } })
      .properties.kinds
    expect(kinds.description).toContain('person')
  })

  // The forget feature is parked: MemoryEngine.forget still exists as
  // dormant code, but no tool exposes it. This guards against it coming
  // back on the tool list by accident, unnoticed, in some later change.
  it('does not list a forget tool: the feature is parked, not shipped', () => {
    const defs = toolDefinitions()
    const names = defs.map((d) => d.name)
    expect(names).not.toContain('forget')
  })
})

describe('dispatchTool', () => {
  it('returns a JSON error, not a throw, for unparseable arguments', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps())
    const sessionId = await engine.startSession()

    const malformed: ToolCall = { id: 'call_2', name: 'search_memory', arguments: 'not json{' }
    const malformedResult = await dispatchTool(engine, sessionId, malformed)

    expect(JSON.parse(malformedResult).error).toMatch(/JSON/)
    await engine.close()
  })

  it('returns a JSON error, not a throw, for arguments that fail schema validation', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps())
    const sessionId = await engine.startSession()

    const missingQuery = await dispatchTool(engine, sessionId, call('search_memory', {}))
    expect(JSON.parse(missingQuery).error).toMatch(/search_memory/)

    const wrongType = await dispatchTool(
      engine,
      sessionId,
      call('graph_query', { kind: 'not_a_real_kind', nodeId: 'x' }),
    )
    expect(JSON.parse(wrongType).error).toMatch(/graph_query/)

    const extraKey = await dispatchTool(
      engine,
      sessionId,
      call('read_document', { docId: 'doc_1', extra: 'nope' }),
    )
    expect(JSON.parse(extraKey).error).toMatch(/read_document/)

    await engine.close()
  })

  it('returns a JSON error, not a throw, for an unknown tool name', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps())
    const sessionId = await engine.startSession()

    const result = await dispatchTool(engine, sessionId, call('not_a_real_tool', {}))
    expect(JSON.parse(result).error).toBe('unknown tool: not_a_real_tool')

    await engine.close()
  })

  it('treats empty arguments as {} for zero-parameter tools', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps())
    const sessionId = await engine.startSession()

    const emptyCall: ToolCall = { id: 'call_3', name: 'list_arcs', arguments: '' }
    const result = await dispatchTool(engine, sessionId, emptyCall)
    expect(JSON.parse(result)).toEqual([])

    await engine.close()
  })

  it('search_memory retrieves what a reflected session actually wrote', async () => {
    const chat = new FakeChatProvider([
      {
        text: JSON.stringify(emptyReflectionOutput('Talked about a kayaking trip on the lake.')),
        toolCalls: [],
      },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const sessionId = await engine.startSession()
    await engine.appendTranscript(sessionId, {
      ts: new Date().toISOString(),
      role: 'user',
      content: 'We went kayaking today.',
    })
    await engine.endSession(sessionId)

    const result = await dispatchTool(
      engine,
      sessionId,
      call('search_memory', { query: 'kayaking', kinds: ['summary'], limit: 5 }),
    )
    const hits = JSON.parse(result) as { docId: string; kind: string }[]
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.kind).toBe('summary')

    await engine.close()
  })

  it('graph_query maps nodeId to the right underlying field for each kind', async () => {
    const paths = memoryPaths(dir)
    await MemoryEngine.open(dir, fakeDeps()).then((e) => e.close())

    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_x',
        type: 'arc',
        label: 'Test Arc',
      },
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'realm_x',
        type: 'realm',
        label: 'Test Realm',
      },
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'item_x',
        type: 'item',
        label: 'Test Item',
      },
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'person_x',
        type: 'person',
        label: 'Test Person',
      },
      {
        ts: '2026-08-01T00:00:01.000Z',
        op: 'assert',
        edge: 'in',
        from: 'arc_x',
        to: 'realm_x',
        confidence: 1,
        confirmed: true,
      },
      {
        ts: '2026-08-01T00:00:02.000Z',
        op: 'assert',
        edge: 'part_of',
        from: 'item_x',
        to: 'arc_x',
        confidence: 1,
        confirmed: true,
      },
      {
        ts: '2026-08-01T00:00:03.000Z',
        op: 'assert',
        edge: 'involves',
        from: 'item_x',
        to: 'person_x',
        confidence: 1,
        confirmed: true,
      },
    ])

    const engine = await MemoryEngine.open(dir, fakeDeps())
    const sessionId = await engine.startSession()

    const neighborsResult = await dispatchTool(
      engine,
      sessionId,
      call('graph_query', { kind: 'neighbors', nodeId: 'arc_x' }),
    )
    const neighbors = JSON.parse(neighborsResult) as {
      edge: { edge: string }
      node: { id: string }
    }[]
    expect(neighbors.map((n) => n.node.id).sort()).toEqual(['item_x', 'realm_x'])

    const itemsResult = await dispatchTool(
      engine,
      sessionId,
      call('graph_query', { kind: 'items_in_arc', nodeId: 'arc_x' }),
    )
    const items = JSON.parse(itemsResult) as { id: string }[]
    expect(items.map((n) => n.id)).toEqual(['item_x'])

    const arcsResult = await dispatchTool(
      engine,
      sessionId,
      call('graph_query', { kind: 'arcs_involving_person', nodeId: 'person_x' }),
    )
    const arcs = JSON.parse(arcsResult) as { id: string }[]
    expect(arcs.map((n) => n.id)).toEqual(['arc_x'])

    await engine.close()
  })

  it('read_document returns {meta, body} for a real document and an error for a missing one', async () => {
    const paths = memoryPaths(dir)
    const docId = newId('doc')
    const docPath = join(paths.arcsDir, 'health.md')

    const engine = await MemoryEngine.open(dir, fakeDeps())
    await writeDocumentAtomic({
      path: docPath,
      meta: { id: docId, name: 'Health', status: 'active' },
      body: 'Original arc narrative.\n',
    })
    const sessionId = await engine.startSession()

    const found = await dispatchTool(engine, sessionId, call('read_document', { docId }))
    const parsedFound = JSON.parse(found)
    expect(parsedFound.meta.id).toBe(docId)
    expect(parsedFound.body).toBe('Original arc narrative.\n')
    expect(parsedFound.path).toBeUndefined()

    const missing = await dispatchTool(
      engine,
      sessionId,
      call('read_document', { docId: 'doc_missing' }),
    )
    expect(JSON.parse(missing)).toEqual({ error: 'not found: doc_missing' })

    await engine.close()
  })

  it('read_transcript returns the full verbatim transcript, and errors on an unknown session', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps())
    const sessionId = await engine.startSession()
    await engine.appendTranscript(sessionId, {
      ts: '2026-08-01T00:00:00.000Z',
      role: 'user',
      content: 'Hello there.',
    })
    await engine.appendTranscript(sessionId, {
      ts: '2026-08-01T00:00:01.000Z',
      role: 'assistant',
      content: 'Hi. How are you?',
    })

    const result = await dispatchTool(engine, sessionId, call('read_transcript', { sessionId }))
    const lines = JSON.parse(result) as { content: string }[]
    expect(lines.map((l) => l.content)).toEqual(['Hello there.', 'Hi. How are you?'])

    const missing = await dispatchTool(
      engine,
      sessionId,
      call('read_transcript', { sessionId: 'session_does_not_exist' }),
    )
    expect(typeof JSON.parse(missing).error).toBe('string')

    await engine.close()
  })

  it('remember captures a live item that survives to the reflected session summary', async () => {
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

    const result = await dispatchTool(
      engine,
      sessionId,
      call('remember', { text: 'Wants to try pottery classes', kind: 'intention' }),
    )
    expect(JSON.parse(result)).toEqual({ ok: true })

    await engine.endSession(sessionId)

    const paths = memoryPaths(dir)
    const summaryPath = join(paths.sessionsDir, `${isoDate(startedAt)}-${sessionId}`, 'summary.md')
    const summaryDoc = await readDocument(summaryPath)
    const items = summaryDoc.meta.items as { text: string; kind: string }[]
    expect(
      items.some((i) => i.text === 'Wants to try pottery classes' && i.kind === 'intention'),
    ).toBe(true)

    await engine.close()
  })

  it('remember passes an event time through to the engine when the model states one', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const sessionId = await engine.startSession()

    const result = await dispatchTool(engine, sessionId, {
      id: 'call_1',
      name: 'remember',
      arguments: JSON.stringify({
        text: 'Watching Halcyon',
        kind: 'event',
        eventTime: 'tonight at 7:25pm',
      }),
    })

    expect(JSON.parse(result)).toEqual({ ok: true })

    const definition = toolDefinitions().find((tool) => tool.name === 'remember')
    const properties = definition?.parameters.properties as Record<string, unknown>
    expect(properties.eventTime).toBeDefined()

    await engine.close()
  })

  it('list_arcs and list_realms return cheap orientation lists', async () => {
    const paths = memoryPaths(dir)
    await MemoryEngine.open(dir, fakeDeps()).then((e) => e.close())

    await appendGraph(paths, [
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'arc_y',
        type: 'arc',
        label: 'Fitness',
      },
      {
        ts: '2026-08-01T00:00:00.000Z',
        op: 'assert',
        node: 'realm_y',
        type: 'realm',
        label: 'Health',
      },
    ])

    const engine = await MemoryEngine.open(dir, fakeDeps())
    const sessionId = await engine.startSession()

    const arcsResult = await dispatchTool(engine, sessionId, call('list_arcs', {}))
    const arcs = JSON.parse(arcsResult) as { id: string; label: string }[]
    expect(arcs).toEqual([expect.objectContaining({ id: 'arc_y', label: 'Fitness' })])

    const realmsResult = await dispatchTool(engine, sessionId, call('list_realms', {}))
    const realms = JSON.parse(realmsResult) as { id: string; label: string }[]
    expect(realms).toEqual([expect.objectContaining({ id: 'realm_y', label: 'Health' })])

    await engine.close()
  })

  it('dispatching resolve_proposal returns an unknown-tool JSON error, not a throw: the tool no longer exists', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps())
    const sessionId = await engine.startSession()

    const result = await dispatchTool(
      engine,
      sessionId,
      call('resolve_proposal', { proposalId: 'prop_x', resolution: 'accepted' }),
    )
    expect(JSON.parse(result)).toEqual({ error: 'unknown tool: resolve_proposal' })

    await engine.close()
  })

  describe('update_style', () => {
    const initialStyle: StyleConfig = {
      engagement: 'balanced',
      tone: 'warm',
      orientation: 'listening',
    }

    function fakeStyleDeps(initial: StyleConfig): {
      deps: ToolDeps
      calls: Partial<StyleConfig>[]
    } {
      let current = { ...initial }
      const calls: Partial<StyleConfig>[] = []
      const deps: ToolDeps = {
        updateStyle: async (patch) => {
          calls.push(patch)
          current = { ...current, ...patch }
          return { ...current }
        },
      }
      return { deps, calls }
    }

    it('applies a full patch and reports that it applies now and persists', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()
      const { deps } = fakeStyleDeps(initialStyle)

      const result = await dispatchTool(
        engine,
        sessionId,
        call('update_style', { engagement: 'leading', tone: 'playful', orientation: 'solutions' }),
        deps,
      )
      const parsed = JSON.parse(result)

      expect(parsed.ok).toBe(true)
      expect(parsed.style).toEqual({
        engagement: 'leading',
        tone: 'playful',
        orientation: 'solutions',
      })
      expect(String(parsed.message).toLowerCase()).toMatch(/from this moment/)
      expect(String(parsed.message).toLowerCase()).toMatch(/persist/)

      await engine.close()
    })

    it('applies a partial patch, passing only the provided fields to the persister', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()
      const { deps, calls } = fakeStyleDeps(initialStyle)

      const result = await dispatchTool(
        engine,
        sessionId,
        call('update_style', { engagement: 'following' }),
        deps,
      )
      const parsed = JSON.parse(result)

      expect(parsed.ok).toBe(true)
      expect(calls).toEqual([{ engagement: 'following' }])
      expect(parsed.style).toEqual({
        engagement: 'following',
        tone: 'warm',
        orientation: 'listening',
      })

      await engine.close()
    })

    it('returns a JSON error, not a throw, when no fields are given', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()
      const { deps, calls } = fakeStyleDeps(initialStyle)

      const result = await dispatchTool(engine, sessionId, call('update_style', {}), deps)

      expect(JSON.parse(result).error).toMatch(/update_style/)
      expect(calls).toEqual([])

      await engine.close()
    })

    it('returns a JSON error, not a throw, when the persister rejects', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()
      const deps: ToolDeps = {
        updateStyle: async () => {
          throw new Error('could not write config file')
        },
      }

      const result = await dispatchTool(
        engine,
        sessionId,
        call('update_style', { tone: 'direct' }),
        deps,
      )

      expect(JSON.parse(result).error).toMatch(/could not write config file/)

      await engine.close()
    })

    it('returns a JSON error, not a throw, when no persister is wired up for this session', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()

      const result = await dispatchTool(engine, sessionId, call('update_style', { tone: 'direct' }))

      expect(typeof JSON.parse(result).error).toBe('string')

      await engine.close()
    })
  })
})
