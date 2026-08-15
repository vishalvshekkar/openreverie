import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import graphology from 'graphology'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphSnapshot } from './api.js'
import { Atlas, buildAtlasModel } from './atlas.js'

const Graph = graphology as unknown as typeof import('graphology').default

const revision = 'a'.repeat(64)

const snapshot: GraphSnapshot = {
  revision,
  nodes: [
    { id: 'arc_1', type: 'arc', label: 'House', assertedAt: '2026-08-15T12:00:00.000Z' },
    {
      id: 'person_1',
      type: 'person',
      label: 'Mina',
      docId: 'doc_mina',
      assertedAt: '2026-08-15T12:00:01.000Z',
    },
    { id: 'realm_1', type: 'realm', label: 'Home', assertedAt: '2026-08-15T12:00:02.000Z' },
  ],
  edges: [],
}

const atlasSnapshot: GraphSnapshot = {
  revision,
  nodes: [
    {
      id: 'person_1',
      type: 'person',
      label: 'Mina',
      docId: 'doc_mina',
      assertedAt: '2026-08-15T12:00:01.000Z',
    },
    { id: 'arc_1', type: 'arc', label: 'Move', assertedAt: '2026-08-15T12:00:00.000Z' },
    { id: 'person_2', type: 'person', label: 'Noor', assertedAt: '2026-08-15T12:00:02.000Z' },
  ],
  edges: [
    {
      key: 'edge_1',
      type: 'relates_to',
      from: 'person_1',
      to: 'person_2',
      confidence: 0.82,
      confirmed: false,
      sourceSessionId: 'session_1',
      assertedAt: '2026-08-15T12:00:03.000Z',
    },
    {
      key: 'edge_2',
      type: 'involves',
      from: 'person_1',
      to: 'arc_1',
      confidence: 0.9,
      confirmed: true,
      assertedAt: '2026-08-15T12:00:04.000Z',
    },
  ],
}

const emptySnapshot: GraphSnapshot = { revision, nodes: [], edges: [] }

const danglingSnapshot: GraphSnapshot = {
  revision,
  nodes: [
    { id: 'person_1', type: 'person', label: 'Mina', assertedAt: '2026-08-15T12:00:00.000Z' },
    { id: 'realm_1', type: 'realm', label: 'Home', assertedAt: '2026-08-15T12:00:01.000Z' },
  ],
  edges: [
    {
      key: 'edge_dangle',
      type: 'part_of',
      from: 'person_1',
      to: 'realm_1',
      confidence: 1,
      confirmed: true,
      assertedAt: '2026-08-15T12:00:02.000Z',
    },
  ],
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildAtlasModel', () => {
  it('assigns the same seeded coordinates to the same id across calls', () => {
    const first = buildAtlasModel(snapshot, new Set(['arc', 'person']))
    const second = buildAtlasModel(snapshot, new Set(['arc', 'person']))
    expect(first.graph.getNodeAttributes('arc_1').x).toBe(second.graph.getNodeAttributes('arc_1').x)
    expect(first.graph.getNodeAttributes('arc_1').y).toBe(second.graph.getNodeAttributes('arc_1').y)
    expect(first.graph.getNodeAttributes('person_1').x).toBe(
      second.graph.getNodeAttributes('person_1').x,
    )
  })

  it('omits a dangling edge from the canvas graph but leaves the snapshot intact', () => {
    const model = buildAtlasModel(danglingSnapshot, new Set(['person']))
    expect(model.graph.order).toBe(1)
    expect(model.graph.hasEdge('edge_dangle')).toBe(false)
    expect(danglingSnapshot.edges.map((edge) => edge.key)).toContain('edge_dangle')
  })

  it('adds an edge only when both endpoints survive the filter', () => {
    const all = buildAtlasModel(atlasSnapshot, new Set(['person', 'arc']))
    expect(all.graph.hasEdge('edge_1')).toBe(true)
    expect(all.graph.hasEdge('edge_2')).toBe(true)

    const personsOnly = buildAtlasModel(atlasSnapshot, new Set(['person']))
    expect(personsOnly.graph.hasEdge('edge_1')).toBe(true)
    expect(personsOnly.graph.hasEdge('edge_2')).toBe(false)
  })
})

describe('Atlas', () => {
  it('uses the same filtered node set for Sigma data and the semantic list', () => {
    const model = buildAtlasModel(snapshot, new Set(['person', 'arc']))
    expect(model.graph.nodes()).toEqual(['arc_1', 'person_1'])
    expect(model.semanticNodes.map((node) => node.id)).toEqual(['arc_1', 'person_1'])
  })

  it('selects a node by keyboard, exposes graph provenance, and opens only an optional docId', async () => {
    const openDocument = vi.fn()
    render(<Atlas snapshot={atlasSnapshot} onOpenDocument={openDocument} />)
    await userEvent.tab()
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByRole('heading', { name: 'Mina' })).toBeVisible()
    expect(screen.getByText('Confidence: 0.82')).toBeVisible()
    expect(screen.getByText('Unconfirmed')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Open document' }))
    expect(openDocument).toHaveBeenCalledWith('doc_mina')
    await userEvent.click(screen.getByRole('button', { name: 'Noor' }))
    expect(screen.queryByRole('button', { name: 'Open document' })).toBeNull()
  })

  it('keeps Phase C controls absent', () => {
    render(<Atlas snapshot={atlasSnapshot} onOpenDocument={vi.fn()} />)
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(
      screen.queryByRole('button', { name: /history|time lens|save layout|realm influence/i }),
    ).toBeNull()
  })

  it('renders an empty graph without attempting to add edges', () => {
    const addEdgeSpy = vi.spyOn(Graph.prototype, 'addEdgeWithKey')
    render(<Atlas snapshot={emptySnapshot} onOpenDocument={vi.fn()} />)
    expect(screen.getByText('No graph records yet.')).toBeVisible()
    expect(addEdgeSpy).not.toHaveBeenCalled()
  })
})
