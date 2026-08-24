import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendGraph,
  type EngineDeps,
  formatLocalDate,
  MemoryEngine,
  memoryPaths,
  newId,
  readCommitments,
  readDocument,
  writeDocumentAtomic,
} from '@openreverie/memory'
import { FakeChatProvider, FakeEmbeddingProvider, type ToolCall } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MODE_NAMES } from './modes.js'
import { dispatchTool, toolDefinitions } from './tools.js'

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
    journalingUpdate: null,
  }
}

describe('toolDefinitions', () => {
  it('lists exactly the thirteen memory and style tools with non-empty descriptions and a JSON schema', () => {
    const defs = toolDefinitions()
    const names = defs.map((d) => d.name).sort()
    expect(names).toEqual(
      [
        'declare_journal_method',
        'graph_query',
        'list_arcs',
        'list_entities',
        'list_people',
        'list_realms',
        'read_document',
        'read_transcript',
        'remember',
        'search_memory',
        'set_mode',
        'update_journaling_protocol',
        'update_profile',
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

  it('never uses an em dash anywhere in a tool definition, including nested parameter descriptions', () => {
    const emDash = String.fromCharCode(0x2014)
    for (const def of toolDefinitions()) {
      expect(def.description).not.toContain(emDash)
      // Whole-definition scan, not just the top-level description: remember's
      // parameters carry substantial nested prose (the commitment,
      // reviseCommitment and resolveCommitment property descriptions), and a
      // check that only reads def.description would miss an em dash there.
      expect(JSON.stringify(def.parameters)).not.toContain(emDash)
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

  it('search_memory documents journal and journaling as valid kinds', () => {
    const definitions = toolDefinitions()
    const searchMemory = definitions.find((tool) => tool.name === 'search_memory')
    const description = JSON.stringify(searchMemory?.parameters)
    expect(description).toContain('journal, journaling')
  })

  // The forget feature is parked: MemoryEngine.forget still exists as
  // dormant code, but no tool exposes it. This guards against it coming
  // back on the tool list by accident, unnoticed, in some later change.
  it('does not list a forget tool: the feature is parked, not shipped', () => {
    const defs = toolDefinitions()
    const names = defs.map((d) => d.name)
    expect(names).not.toContain('forget')
  })

  it('says plainly which kinds the date filters apply to and which they never exclude', () => {
    const defs = toolDefinitions()
    const searchMemory = defs.find((d) => d.name === 'search_memory')
    if (!searchMemory) throw new Error('expected a search_memory tool definition')
    const properties = (
      searchMemory.parameters as {
        properties: { after: { description: string }; before: { description: string } }
      }
    ).properties

    for (const description of [properties.after.description, properties.before.description]) {
      expect(description).toContain('weekly rollup matches if any day of its week falls in range')
      expect(description).toContain('never excluded')
      expect(description).toContain('kinds')
    }
    expect(properties.after.description).toContain('on or after')
    expect(properties.before.description).toContain('on or before')
  })

  it('explains both search lanes and what a node-only hit means', () => {
    const defs = toolDefinitions()
    const searchMemory = defs.find((d) => d.name === 'search_memory')
    if (!searchMemory) throw new Error('expected a search_memory tool definition')
    expect(searchMemory.description).toContain('two parts')
    expect(searchMemory.description).toContain('hasPage: false')
    expect(searchMemory.description).toContain('graph_query')
  })

  it('explains the date span and the multi-chunk fields on a document hit (A7)', () => {
    const defs = toolDefinitions()
    const searchMemory = defs.find((d) => d.name === 'search_memory')
    if (!searchMemory) throw new Error('expected a search_memory tool definition')
    expect(searchMemory.description).toContain('dateStart')
    expect(searchMemory.description).toContain('dateEnd')
    expect(searchMemory.description).toContain('chunks')
    expect(searchMemory.description).toContain('chunksTotal')
    // Absence of a date on a living document must read as absence, not as
    // a fact worth guessing at.
    expect(searchMemory.description.toLowerCase()).toContain('no single date')
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
    expect(JSON.parse(result)).toEqual({
      total: 0,
      offset: 0,
      limit: 50,
      returned: 0,
      hasMore: false,
      rows: [],
    })

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
    const results = JSON.parse(result) as {
      documents: {
        docId: string
        kind: string
        dateStart?: string
        dateEnd?: string
        chunks: string[]
        chunksTotal: number
      }[]
    }
    expect(results.documents.length).toBeGreaterThan(0)
    expect(results.documents[0]?.kind).toBe('summary')
    // The JSON the model actually receives carries the new fields, not
    // just the internal SearchHit/DocumentHit types. A summary is a dated
    // kind (documentDateSpan), so its date span must be present.
    expect(results.documents[0]?.dateStart).toBeDefined()
    expect(results.documents[0]?.dateEnd).toBeDefined()
    expect(results.documents[0]?.chunks.length).toBeGreaterThan(0)
    expect(results.documents[0]?.chunksTotal).toBeGreaterThan(0)

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
    const summaryPath = join(
      paths.sessionsDir,
      `${formatLocalDate(startedAt, engine.timezone())}-${sessionId}`,
      'summary.md',
    )
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

  it.each([
    ['empty string', ''],
    ['whitespace-only', '   '],
  ])(
    'remember treats a %s eventTime as absent, not a fabricated anchor, writing no eventTime key at all',
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

      // The exact shape a model emits instead of omitting the key: see
      // AGENTS-instructed Fix 1, packages/core/src/tools.ts's rememberArgs.
      const result = await dispatchTool(
        engine,
        sessionId,
        call('remember', { text: 'Went out for a walk', kind: 'event', eventTime }),
      )
      expect(JSON.parse(result)).toEqual({ ok: true })

      await engine.endSession(sessionId)

      const paths = memoryPaths(dir)
      const summaryPath = join(
        paths.sessionsDir,
        `${formatLocalDate(startedAt, engine.timezone())}-${sessionId}`,
        'summary.md',
      )
      const summaryDoc = await readDocument(summaryPath)
      const items = summaryDoc.meta.items as { text: string; eventTime?: string }[]
      const item = items.find((i) => i.text === 'Went out for a walk')
      expect(item).toBeDefined()
      // Absent, not present as an empty string: this is the write-site
      // fix, not just a falsy-string check, so the key itself must be gone.
      expect('eventTime' in (item ?? {})).toBe(false)

      await engine.close()
    },
  )

  describe('remember: commitment shapes', () => {
    it('still records a plain item exactly as before', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()

      const result = await dispatchTool(
        engine,
        sessionId,
        call('remember', { text: 'Today felt heavy.', kind: 'feeling' }),
      )
      expect(JSON.parse(result)).toEqual({ ok: true })

      await engine.close()
    })

    // Guards against ever routing remember's validation back through a
    // combined z.union: a union's safeParse collapses every branch's
    // failure into one root-level message with no field name, which this
    // task's own falsification caught (see task-6-report.md). The item
    // shape's error message must keep naming the actual field, exactly as
    // it did before this task added the other three shapes.
    it('still names the actual field in a plain item validation error, not a generic union failure', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()

      const result = await dispatchTool(engine, sessionId, call('remember', { text: 123 }))
      expect(JSON.parse(result).error).toContain('text')
      expect(JSON.parse(result).error).not.toContain('(root): Invalid input')

      await engine.close()
    })

    it('records a commitment as a commitment, not as an item', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()

      const result = await dispatchTool(
        engine,
        sessionId,
        call('remember', {
          commitment: { label: 'See Nightfall with Arjun', flavor: 'plan', statedTime: 'sunday' },
        }),
      )
      expect(JSON.parse(result).ok).toBe(true)

      const live = await readCommitments(memoryPaths(dir))
      expect(live).toHaveLength(1)
      expect(live[0]?.label).toBe('See Nightfall with Arjun')
      expect(live[0]?.flavor).toBe('plan')
      expect(live[0]?.state).toBe('open')
      // The model's only reliable way to later revise or resolve this
      // commitment is the id handed back here; it must be the real one.
      expect(JSON.parse(result).commitmentId).toBe(live[0]?.id)

      await engine.close()
    })

    // waitsOn is real on the Commitment record and on selectCommitments's
    // exclusion, but nothing anywhere clears it once set (see BACKLOG.md),
    // so it must not be reachable from a live tool call. rememberCommitmentArgs
    // is a z.strictObject, so an unknown key is refused rather than silently
    // dropped: silently dropping it would be worse, since the caller would
    // believe the field was recorded when it never reached the engine at all.
    it('refuses a commitment call that still carries waitsOn', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()

      const result = await dispatchTool(
        engine,
        sessionId,
        call('remember', {
          commitment: {
            label: 'See Nightfall with Arjun',
            flavor: 'plan',
            waitsOn: 'once she confirms the venue',
          },
        }),
      )
      expect(JSON.parse(result).error).toBeDefined()

      const live = await readCommitments(memoryPaths(dir))
      expect(live).toHaveLength(0)

      await engine.close()
    })

    it('resolves a stated time it understands into the resolved branch, with no interpretation', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()

      await dispatchTool(
        engine,
        sessionId,
        call('remember', {
          commitment: {
            label: 'Pick up the dry cleaning',
            flavor: 'errand',
            statedTime: 'tomorrow',
          },
        }),
      )

      const live = await readCommitments(memoryPaths(dir))
      expect(live[0]?.timing?.resolved).toBeDefined()
      expect(live[0]?.timing?.interpretation).toBeUndefined()

      await engine.close()
    })

    it('carries a stated time it refuses to resolve as words and an anchor, with no interpretation invented', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()

      await dispatchTool(
        engine,
        sessionId,
        call('remember', {
          commitment: { label: 'Call the dentist', flavor: 'errand', statedTime: 'next friday' },
        }),
      )

      const live = await readCommitments(memoryPaths(dir))
      expect(live[0]?.timing?.words).toBe('next friday')
      expect(live[0]?.timing?.anchor).toBeDefined()
      expect(live[0]?.timing?.resolved).toBeUndefined()
      expect(live[0]?.timing?.interpretation).toBeUndefined()

      await engine.close()
    })

    it('revises an existing commitment by referencing its id', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()

      await dispatchTool(
        engine,
        sessionId,
        call('remember', {
          commitment: { label: 'See Nightfall with Arjun', flavor: 'plan', statedTime: 'sunday' },
        }),
      )
      const [recorded] = await readCommitments(memoryPaths(dir))
      if (!recorded) throw new Error('expected a recorded commitment')

      const result = await dispatchTool(
        engine,
        sessionId,
        call('remember', {
          reviseCommitment: { commitmentId: recorded.id, statedTime: 'sunday the 23rd' },
        }),
      )
      expect(JSON.parse(result).ok).toBe(true)

      const live = await readCommitments(memoryPaths(dir))
      expect(live).toHaveLength(1)
      expect(live[0]?.id).toBe(recorded.id)
      expect(live[0]?.timing?.words).toBe('sunday the 23rd')

      await engine.close()
    })

    it('rejects a revision that does not say what it revises', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()

      const result = await dispatchTool(
        engine,
        sessionId,
        call('remember', { reviseCommitment: { statedTime: 'sunday the 23rd' } }),
      )
      // Asserts where the error came from, not just that one exists: the
      // zod boundary must be what refuses this, naming the missing field,
      // not a downstream "no live commitment" lookup failure that would
      // pass just as well against a flattened, optional-everything schema.
      expect(JSON.parse(result).error).toMatch(/invalid arguments for remember/)
      expect(JSON.parse(result).error).toMatch(/reviseCommitment\.commitmentId/)

      await engine.close()
    })

    it('resolves an existing commitment with a named outcome', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()

      await dispatchTool(
        engine,
        sessionId,
        call('remember', { commitment: { label: 'Return the library book', flavor: 'errand' } }),
      )
      const [recorded] = await readCommitments(memoryPaths(dir))
      if (!recorded) throw new Error('expected a recorded commitment')

      const result = await dispatchTool(
        engine,
        sessionId,
        call('remember', {
          resolveCommitment: { commitmentId: recorded.id, outcome: 'done' },
        }),
      )
      expect(JSON.parse(result).ok).toBe(true)

      const live = await readCommitments(memoryPaths(dir))
      expect(live[0]?.state).toBe('done')

      await engine.close()
    })

    it('rejects a resolution that does not name an outcome', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()

      const result = await dispatchTool(
        engine,
        sessionId,
        call('remember', { resolveCommitment: { commitmentId: 'commitment_01A' } }),
      )
      // Same reasoning as the revision test above: the missing field must
      // be what the zod boundary names, not an unrelated "commitment not
      // found" error that a lookup on a nonexistent id would produce even
      // under a flattened schema.
      expect(JSON.parse(result).error).toMatch(/invalid arguments for remember/)
      expect(JSON.parse(result).error).toMatch(/resolveCommitment\.outcome/)

      await engine.close()
    })

    it('rejects a call that mixes an item field with a commitment field', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()

      const result = await dispatchTool(
        engine,
        sessionId,
        call('remember', {
          text: 'See Nightfall with Arjun',
          commitment: { label: 'See Nightfall with Arjun', flavor: 'plan' },
        }),
      )
      expect(JSON.parse(result).error).toBeDefined()

      await engine.close()
    })
  })

  it('declare_journal_method records the method on the session', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps())
    const sessionId = await engine.startSession()

    const result = await dispatchTool(
      engine,
      sessionId,
      call('declare_journal_method', { method: 'gratitude' }),
    )
    expect(JSON.parse(result)).toEqual({ ok: true })
    expect(await engine.sessionJournalMethod(sessionId)).toBe('gratitude')

    await engine.close()
  })

  it('declare_journal_method rejects an unknown method', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps())
    const sessionId = await engine.startSession()

    const result = await dispatchTool(
      engine,
      sessionId,
      call('declare_journal_method', { method: 'astrology' }),
    )
    expect(JSON.parse(result).error).toBeDefined()

    await engine.close()
  })

  it('update_journaling_protocol rewrites the document and reports ok', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps())
    const sessionId = await engine.startSession()

    const result = await dispatchTool(
      engine,
      sessionId,
      call('update_journaling_protocol', { body: 'Gratitude, three times a week.' }),
    )
    expect(JSON.parse(result).ok).toBe(true)
    const rows = await engine.listPublicDocuments()
    expect(rows.find((row) => row.kind === 'journaling')).toBeDefined()

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
    const arcs = JSON.parse(arcsResult) as { rows: { id: string; label: string }[] }
    expect(arcs.rows).toEqual([expect.objectContaining({ id: 'arc_y', label: 'Fitness' })])

    const realmsResult = await dispatchTool(engine, sessionId, call('list_realms', {}))
    const realms = JSON.parse(realmsResult) as { rows: { id: string; label: string }[] }
    expect(realms.rows).toEqual([expect.objectContaining({ id: 'realm_y', label: 'Health' })])

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

  it('update_profile writes a confirmed timezone through the engine', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const sessionId = await engine.startSession()

    const result = await dispatchTool(engine, sessionId, {
      id: 'call_1',
      name: 'update_profile',
      arguments: JSON.stringify({ timezone: 'Asia/Kolkata' }),
    })

    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(parsed.timezone).toBe('Asia/Kolkata')
    expect(engine.timezone()).toBe('Asia/Kolkata')
    expect(engine.timezoneSource()).toBe('user-confirmed')

    await engine.close()
  })

  it('update_profile reports an unrecognized zone as a tool error instead of throwing', async () => {
    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const sessionId = await engine.startSession()
    const before = engine.timezone()

    const result = await dispatchTool(engine, sessionId, {
      id: 'call_1',
      name: 'update_profile',
      arguments: JSON.stringify({ timezone: 'Nowhere/Fake' }),
    })

    expect(JSON.parse(result).error).toContain('not a recognized IANA timezone')
    expect(engine.timezone()).toBe(before)

    await engine.close()
  })

  describe('update_profile allowlist', () => {
    it('accepts every allowlisted field', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const sessionId = await engine.startSession()
      const result = await dispatchTool(
        engine,
        sessionId,
        call('update_profile', {
          preferredName: 'Vish',
          pronouns: 'they/them',
          location: 'Bengaluru',
          timezone: 'Asia/Kolkata',
          birthday: '04-02',
          occupation: 'nurse',
          birthdayGreetings: false,
        }),
      )
      expect(JSON.parse(result).error).toBeUndefined()
      expect(engine.profile().meta.preferredName).toBe('Vish')

      await engine.close()
    })

    it('refuses a style write, because style is never model-writable', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const sessionId = await engine.startSession()
      const result = await dispatchTool(
        engine,
        sessionId,
        call('update_profile', { style: { tone: 'direct' } }),
      )
      expect(JSON.parse(result).error).toMatch(/update_profile/)
      expect(engine.profile().meta.style).toBeUndefined()

      await engine.close()
    })
  })

  describe('set_mode', () => {
    it('is offered as a tool and update_style is not', () => {
      const names = toolDefinitions().map((definition) => definition.name)
      expect(names).toContain('set_mode')
      expect(names).not.toContain('update_style')
    })

    it('lists all ten modes in its enum', () => {
      const definition = toolDefinitions().find((entry) => entry.name === 'set_mode')
      const properties = definition?.parameters.properties as
        | { mode?: { enum?: string[] } }
        | undefined
      expect(properties?.mode?.enum).toEqual([...MODE_NAMES])
    })

    it('tells the model to point at /style for a lasting change', () => {
      const definition = toolDefinitions().find((entry) => entry.name === 'set_mode')
      expect(definition?.description).toContain('/style')
      expect(definition?.description).toContain('settings pane')
      expect(definition?.description).toContain('this conversation only')
    })

    it('calls the hook with a valid mode', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()
      const calls: string[] = []

      const result = await dispatchTool(engine, sessionId, call('set_mode', { mode: 'listen' }), {
        setMode: async (mode) => {
          calls.push(mode)
        },
      })

      expect(calls).toEqual(['listen'])
      expect(JSON.parse(result)).toEqual({ ok: true, mode: 'listen' })

      await engine.close()
    })

    it('returns the error shape and calls nothing for an unknown mode', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()
      const calls: string[] = []

      const result = await dispatchTool(engine, sessionId, call('set_mode', { mode: 'moody' }), {
        setMode: async (mode) => {
          calls.push(mode)
        },
      })

      expect(JSON.parse(result).error).toMatch(/set_mode/)
      expect(calls).toEqual([])

      await engine.close()
    })

    it('reports the unknown-tool error for a stale update_style call', async () => {
      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()

      const result = await dispatchTool(
        engine,
        sessionId,
        call('update_style', { tone: 'direct' }),
        {},
      )

      expect(JSON.parse(result).error).toBe('unknown tool: update_style')

      await engine.close()
    })
  })
})

it('list_people and list_entities page through nodes the prompt could not show', async () => {
  const paths = memoryPaths(dir)
  await MemoryEngine.open(dir, fakeDeps()).then((e) => e.close())

  for (let i = 0; i < 3; i++) {
    await appendGraph(paths, [
      {
        ts: `2026-08-0${i + 1}T00:00:00.000Z`,
        op: 'assert',
        node: `person_${i}`,
        type: 'person',
        label: `Person ${i}`,
      },
      {
        ts: `2026-08-0${i + 1}T00:00:00.000Z`,
        op: 'assert',
        node: `entity_${i}`,
        type: 'entity',
        label: `Entity ${i}`,
      },
    ])
  }

  const engine = await MemoryEngine.open(dir, fakeDeps())
  const sessionId = await engine.startSession()

  const peopleResult = await dispatchTool(
    engine,
    sessionId,
    call('list_people', { nameContains: 'person 1' }),
  )
  const people = JSON.parse(peopleResult) as {
    total: number
    rows: { id: string; name: string; hasPage: boolean }[]
  }
  expect(people.total).toBe(1)
  expect(people.rows[0]).toMatchObject({ id: 'person_1', name: 'Person 1', hasPage: false })

  const entitiesResult = await dispatchTool(engine, sessionId, call('list_entities', { limit: 2 }))
  const entities = JSON.parse(entitiesResult) as {
    total: number
    returned: number
    hasMore: boolean
  }
  expect(entities).toMatchObject({ total: 3, returned: 2, hasMore: true })

  const badArg = await dispatchTool(engine, sessionId, call('list_people', { sortBy: 'name' }))
  expect(JSON.parse(badArg).error).toMatch(/list_people/)

  await engine.close()
})

it('list_arcs filters by status and pages, and its description matches what it returns', async () => {
  const paths = memoryPaths(dir)
  await MemoryEngine.open(dir, fakeDeps()).then((e) => e.close())

  const openPath = join(paths.arcsDir, 'open.md')
  await writeDocumentAtomic({
    path: openPath,
    meta: { id: 'doc_open_arc', name: 'Open Arc', status: 'active', updated: '2026-08-10' },
    body: 'Still going.\n',
  })
  const donePath = join(paths.arcsDir, 'done.md')
  await writeDocumentAtomic({
    path: donePath,
    meta: { id: 'doc_done_arc', name: 'Done Arc', status: 'closed', updated: '2026-02-02' },
    body: 'Finished.\n',
  })
  await appendGraph(paths, [
    {
      ts: '2026-08-01T00:00:00.000Z',
      op: 'assert',
      node: 'arc_open',
      type: 'arc',
      label: 'Open Arc',
      doc: openPath,
    },
    {
      ts: '2026-02-01T00:00:00.000Z',
      op: 'assert',
      node: 'arc_done',
      type: 'arc',
      label: 'Done Arc',
      doc: donePath,
    },
  ])

  const engine = await MemoryEngine.open(dir, fakeDeps())
  const sessionId = await engine.startSession()

  const closedResult = await dispatchTool(
    engine,
    sessionId,
    call('list_arcs', { status: 'closed' }),
  )
  const closed = JSON.parse(closedResult) as {
    total: number
    rows: { id: string; status: string; docId: string }[]
  }
  expect(closed.total).toBe(1)
  expect(closed.rows[0]).toMatchObject({ id: 'arc_done', status: 'closed', docId: 'doc_done_arc' })

  const pagedResult = await dispatchTool(engine, sessionId, call('list_arcs', { limit: 1 }))
  const paged = JSON.parse(pagedResult) as { total: number; returned: number; hasMore: boolean }
  expect(paged).toMatchObject({ total: 2, returned: 1, hasMore: true })

  const badStatus = await dispatchTool(engine, sessionId, call('list_arcs', { status: 'sideways' }))
  expect(JSON.parse(badStatus).error).toMatch(/list_arcs/)

  const realmsPaged = await dispatchTool(engine, sessionId, call('list_realms', { limit: 1 }))
  expect(JSON.parse(realmsPaged)).toMatchObject({ offset: 0, limit: 1 })

  const defs = toolDefinitions()
  const listArcs = defs.find((d) => d.name === 'list_arcs')
  if (!listArcs) throw new Error('expected a list_arcs tool definition')
  expect(listArcs.description).toContain('docId')
  expect(listArcs.description).toContain('dormant')
  const listArcsProps = (listArcs.parameters as { properties: Record<string, unknown> }).properties
  expect(Object.keys(listArcsProps).sort()).toEqual(['limit', 'offset', 'status'])

  await engine.close()
})
