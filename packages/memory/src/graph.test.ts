import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendGraph,
  edgeKey,
  foldGraph,
  type GraphRecord,
  readGraph,
  readGraphRecords,
} from './graph.js'
import { ensureMemoryTree, memoryPaths } from './paths.js'

describe('edgeKey', () => {
  it('builds a key from edge, from, and to', () => {
    expect(edgeKey({ edge: 'in', from: 'item_1', to: 'realm_1' })).toBe('in:item_1:realm_1')
  })
})

describe('foldGraph', () => {
  it('folds a single node assert into current state', () => {
    const records: GraphRecord[] = [
      { ts: '2026-08-01T00:00:00Z', op: 'assert', node: 'realm_1', type: 'realm', label: 'Work' },
    ]
    const state = foldGraph(records)
    expect(state.nodes.get('realm_1')).toEqual({
      id: 'realm_1',
      type: 'realm',
      label: 'Work',
      doc: undefined,
      ts: '2026-08-01T00:00:00Z',
    })
    expect(state.edges.size).toBe(0)
  })

  it('assert then retract then re-assert folds a node correctly', () => {
    const records: GraphRecord[] = [
      { ts: '2026-08-01T00:00:00Z', op: 'assert', node: 'realm_1', type: 'realm', label: 'Work' },
      { ts: '2026-08-02T00:00:00Z', op: 'retract', node: 'realm_1', type: 'realm', label: 'Work' },
      {
        ts: '2026-08-03T00:00:00Z',
        op: 'assert',
        node: 'realm_1',
        type: 'realm',
        label: 'Work (renamed)',
      },
    ]
    const state = foldGraph(records)
    expect(state.nodes.get('realm_1')).toEqual({
      id: 'realm_1',
      type: 'realm',
      label: 'Work (renamed)',
      doc: undefined,
      ts: '2026-08-03T00:00:00Z',
    })
  })

  it('assert then retract then re-assert folds an edge correctly', () => {
    const records: GraphRecord[] = [
      {
        ts: '2026-08-01T00:00:00Z',
        op: 'assert',
        edge: 'in',
        from: 'item_1',
        to: 'realm_1',
        confidence: 0.5,
        confirmed: false,
      },
      {
        ts: '2026-08-02T00:00:00Z',
        op: 'retract',
        edge: 'in',
        from: 'item_1',
        to: 'realm_1',
        confidence: 0.5,
        confirmed: false,
      },
      {
        ts: '2026-08-03T00:00:00Z',
        op: 'assert',
        edge: 'in',
        from: 'item_1',
        to: 'realm_1',
        confidence: 0.9,
        confirmed: true,
      },
    ]
    const state = foldGraph(records)
    expect(state.edges.get('in:item_1:realm_1')).toEqual({
      edge: 'in',
      from: 'item_1',
      to: 'realm_1',
      confidence: 0.9,
      source: undefined,
      confirmed: true,
      ts: '2026-08-03T00:00:00Z',
    })
  })

  it('edge identity is (edge, from, to): a second assert updates confidence and confirmed in place', () => {
    const records: GraphRecord[] = [
      {
        ts: '2026-08-01T00:00:00Z',
        op: 'assert',
        edge: 'relates_to',
        from: 'person_1',
        to: 'person_2',
        confidence: 0.3,
        source: 'inference',
        confirmed: false,
      },
      {
        ts: '2026-08-02T00:00:00Z',
        op: 'assert',
        edge: 'relates_to',
        from: 'person_1',
        to: 'person_2',
        confidence: 0.95,
        source: 'user confirmed',
        confirmed: true,
      },
    ]
    const state = foldGraph(records)
    expect(state.edges.size).toBe(1)
    expect(state.edges.get('relates_to:person_1:person_2')).toEqual({
      edge: 'relates_to',
      from: 'person_1',
      to: 'person_2',
      confidence: 0.95,
      source: 'user confirmed',
      confirmed: true,
      ts: '2026-08-02T00:00:00Z',
    })
  })

  it('a node retract does not cascade to remove edges pointing at the missing node', () => {
    const records: GraphRecord[] = [
      { ts: '2026-08-01T00:00:00Z', op: 'assert', node: 'item_1', type: 'item', label: 'Guitar' },
      {
        ts: '2026-08-01T00:00:00Z',
        op: 'assert',
        edge: 'in',
        from: 'item_1',
        to: 'realm_1',
        confidence: 0.8,
        confirmed: true,
      },
      { ts: '2026-08-02T00:00:00Z', op: 'retract', node: 'item_1', type: 'item', label: 'Guitar' },
    ]
    const state = foldGraph(records)
    expect(state.nodes.has('item_1')).toBe(false)
    expect(state.edges.has('in:item_1:realm_1')).toBe(true)
  })
})

describe('appendGraph and readGraph', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-memory-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips records through a temp file', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const records: GraphRecord[] = [
      { ts: '2026-08-01T00:00:00Z', op: 'assert', node: 'realm_1', type: 'realm', label: 'Work' },
      {
        ts: '2026-08-01T00:01:00Z',
        op: 'assert',
        edge: 'in',
        from: 'item_1',
        to: 'realm_1',
        confidence: 0.7,
        confirmed: false,
      },
    ]
    await appendGraph(paths, records)

    const state = await readGraph(paths)
    expect(state.nodes.get('realm_1')?.label).toBe('Work')
    expect(state.edges.get('in:item_1:realm_1')?.confidence).toBe(0.7)
  })

  it('appends across multiple calls, preserving order for fold', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    await appendGraph(paths, [
      { ts: '2026-08-01T00:00:00Z', op: 'assert', node: 'realm_1', type: 'realm', label: 'Work' },
    ])
    await appendGraph(paths, [
      { ts: '2026-08-02T00:00:00Z', op: 'retract', node: 'realm_1', type: 'realm', label: 'Work' },
    ])

    const state = await readGraph(paths)
    expect(state.nodes.has('realm_1')).toBe(false)
  })

  it('retains every raw graph operation with its one-based append sequence', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    const assertNode: GraphRecord = {
      ts: '2026-08-01T00:00:00.000Z',
      op: 'assert',
      node: 'person_no_page',
      type: 'person',
      label: 'Noor',
    }
    const retractNode: GraphRecord = { ...assertNode, op: 'retract' }

    await appendGraph(paths, [assertNode, retractNode])

    expect(await readGraphRecords(paths)).toEqual([
      { sequence: 1, record: assertNode },
      { sequence: 2, record: retractNode },
    ])
  })

  it('returns empty state when the graph log does not exist yet', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const state = await readGraph(paths)
    expect(state.nodes.size).toBe(0)
    expect(state.edges.size).toBe(0)
  })

  it('tolerates and skips blank lines', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const line1 = JSON.stringify({
      ts: '2026-08-01T00:00:00Z',
      op: 'assert',
      node: 'realm_1',
      type: 'realm',
      label: 'Work',
    })
    await writeFile(paths.graphLog, `${line1}\n\n\n`, 'utf8')

    const state = await readGraph(paths)
    expect(state.nodes.get('realm_1')?.label).toBe('Work')
  })

  it('throws with the line number when a line is not valid JSON', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const line1 = JSON.stringify({
      ts: '2026-08-01T00:00:00Z',
      op: 'assert',
      node: 'realm_1',
      type: 'realm',
      label: 'Work',
    })
    await writeFile(paths.graphLog, `${line1}\nnot json at all\n`, 'utf8')

    await expect(readGraph(paths)).rejects.toThrow(/line 2/)
  })

  it('throws with line number when a valid JSON line has invalid op value', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const line1 = JSON.stringify({
      ts: '2026-08-01T00:00:00Z',
      op: 'sideways',
      node: 'realm_1',
      type: 'realm',
      label: 'Work',
    })
    await writeFile(paths.graphLog, `${line1}\n`, 'utf8')

    await expect(readGraph(paths)).rejects.toThrow(/line 1/)
  })

  it('throws with line number when a valid JSON edge line is missing the "to" field', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const line1 = JSON.stringify({
      ts: '2026-08-01T00:00:00Z',
      op: 'assert',
      edge: 'in',
      from: 'item_1',
      confidence: 0.5,
      confirmed: false,
    })
    await writeFile(paths.graphLog, `${line1}\n`, 'utf8')

    await expect(readGraph(paths)).rejects.toThrow(/line 1/)
  })

  it('throws and writes nothing when appending a record with confidence out of the 0-1 range', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const badRecords: GraphRecord[] = [
      {
        ts: '2026-08-01T00:00:00Z',
        op: 'assert',
        edge: 'in',
        from: 'item_1',
        to: 'realm_1',
        confidence: 1.5,
        confirmed: false,
      },
    ]

    await expect(appendGraph(paths, badRecords)).rejects.toThrow(/index 0/)

    const state = await readGraph(paths)
    expect(state.edges.size).toBe(0)
  })

  it('throws and writes nothing when appending a record matching neither node nor edge shape', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const wrongShape = {
      ts: '2026-08-01T00:00:00Z',
      op: 'assert',
      foo: 'bar',
    } as unknown as GraphRecord

    await expect(appendGraph(paths, [wrongShape])).rejects.toThrow(/index 0/)

    const state = await readGraph(paths)
    expect(state.nodes.size).toBe(0)
    expect(state.edges.size).toBe(0)
  })

  it('round-trips a commitment node and a waits_on edge through the log', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    await appendGraph(paths, [
      {
        ts: '2026-08-24T10:00:00.000Z',
        op: 'assert',
        node: 'commitment_01ABC',
        type: 'commitment',
        label: 'See Nightfall with Arjun',
      },
      {
        ts: '2026-08-24T10:00:00.000Z',
        op: 'assert',
        edge: 'waits_on',
        from: 'commitment_01ABC',
        to: 'entity_01WEDDING',
        confidence: 1,
        confirmed: true,
      },
    ])

    const graph = await readGraph(paths)

    expect(graph.nodes.get('commitment_01ABC')?.type).toBe('commitment')
    expect(
      Array.from(graph.edges.values()).some(
        (e) => e.edge === 'waits_on' && e.from === 'commitment_01ABC',
      ),
    ).toBe(true)
  })
})
