import { render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import graphology from 'graphology'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppApi, Document, GraphEdge, GraphNode, GraphSnapshot } from './api.js'
import {
  Atlas,
  AtlasView,
  borderColorForType,
  buildAtlasModel,
  colorForType,
  edgeColor,
  edgeSize,
  LABEL_RENDERED_SIZE_THRESHOLD,
  type NodeType,
  TYPE_SIZE_BAND,
} from './atlas.js'
import type { Positions } from './graph/layout.js'

const Graph = graphology as unknown as typeof import('graphology').default

const revision = 'a'.repeat(64)

// jsdom's CSSOM normalises an inline `background: #rrggbb` declaration to
// `rgb(r, g, b)` when it is read back, so comparisons against colorForType's
// hex output go through this conversion.
function hexToRgb(hex: string): string {
  const value = hex.replace('#', '')
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
  return `rgb(${r}, ${g}, ${b})`
}

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

/*
 * A fixture resembling the real graph shape reported from the browser:
 * 116 nodes split { item: 89, session: 7, person: 7, arc: 6, entity: 4,
 * realm: 3 }, connected through the same edge types the engine actually
 * writes (arc `in` realm, item `part_of` arc, item `from` session, item
 * `involves` person, item `relates_to` entity).
 */
function buildRealisticSnapshot(): GraphSnapshot {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const ts = (index: number) => new Date(2026, 0, 1, 0, 0, index).toISOString()
  let seq = 0
  let edgeSeq = 0

  const realmIds = Array.from({ length: 3 }, (_, index) => `realm_${index + 1}`)
  for (const [index, id] of realmIds.entries()) {
    nodes.push({ id, type: 'realm', label: `Realm ${index + 1}`, assertedAt: ts(seq++) })
  }

  const arcIds = Array.from({ length: 6 }, (_, index) => `arc_${index + 1}`)
  arcIds.forEach((id, index) => {
    nodes.push({ id, type: 'arc', label: `Arc ${index + 1}`, assertedAt: ts(seq++) })
    const realmId = realmIds[index % realmIds.length]
    if (realmId !== undefined) {
      edges.push({
        key: `edge_in_${edgeSeq++}`,
        type: 'in',
        from: id,
        to: realmId,
        confidence: 1,
        confirmed: true,
        assertedAt: ts(seq++),
      })
    }
  })

  const sessionIds = Array.from({ length: 7 }, (_, index) => `session_${index + 1}`)
  for (const [index, id] of sessionIds.entries()) {
    nodes.push({ id, type: 'session', label: `Session ${index + 1}`, assertedAt: ts(seq++) })
  }

  const personIds = Array.from({ length: 7 }, (_, index) => `person_${index + 1}`)
  for (const [index, id] of personIds.entries()) {
    nodes.push({ id, type: 'person', label: `Person ${index + 1}`, assertedAt: ts(seq++) })
  }

  const entityIds = Array.from({ length: 4 }, (_, index) => `entity_${index + 1}`)
  for (const [index, id] of entityIds.entries()) {
    nodes.push({ id, type: 'entity', label: `Entity ${index + 1}`, assertedAt: ts(seq++) })
  }

  for (let index = 0; index < 89; index++) {
    const id = `item_${index + 1}`
    nodes.push({ id, type: 'item', label: `Item ${index + 1}`, assertedAt: ts(seq++) })
    const arcId = arcIds[index % arcIds.length]
    if (arcId !== undefined) {
      edges.push({
        key: `edge_part_of_${edgeSeq++}`,
        type: 'part_of',
        from: id,
        to: arcId,
        confidence: 0.8,
        confirmed: true,
        assertedAt: ts(seq++),
      })
    }
    if (index % 3 === 0) {
      const sessionId = sessionIds[(index / 3) % sessionIds.length]
      if (sessionId !== undefined) {
        edges.push({
          key: `edge_from_${edgeSeq++}`,
          type: 'from',
          from: id,
          to: sessionId,
          confidence: 1,
          confirmed: true,
          assertedAt: ts(seq++),
        })
      }
    }
    if (index % 4 === 0) {
      const personId = personIds[(index / 4) % personIds.length]
      if (personId !== undefined) {
        edges.push({
          key: `edge_involves_${edgeSeq++}`,
          type: 'involves',
          from: id,
          to: personId,
          confidence: 0.7,
          confirmed: false,
          assertedAt: ts(seq++),
        })
      }
    }
    if (index % 5 === 0) {
      const entityId = entityIds[(index / 5) % entityIds.length]
      if (entityId !== undefined) {
        edges.push({
          key: `edge_relates_to_${edgeSeq++}`,
          type: 'relates_to',
          from: id,
          to: entityId,
          confidence: 0.6,
          confirmed: false,
          assertedAt: ts(seq++),
        })
      }
    }
  }

  return { revision, nodes, edges }
}

const realisticSnapshot = buildRealisticSnapshot()

afterEach(() => {
  vi.restoreAllMocks()
})

const noPositions: Positions = {}

describe('buildAtlasModel', () => {
  it('omits a dangling edge from the canvas graph but leaves the snapshot intact', () => {
    const model = buildAtlasModel(danglingSnapshot, new Set(['person']), noPositions)
    expect(model.graph.order).toBe(1)
    expect(model.graph.hasEdge('edge_dangle')).toBe(false)
    expect(danglingSnapshot.edges.map((edge) => edge.key)).toContain('edge_dangle')
  })

  it('adds an edge only when both endpoints survive the filter', () => {
    const all = buildAtlasModel(atlasSnapshot, new Set(['person', 'arc']), noPositions)
    expect(all.graph.hasEdge('edge_1')).toBe(true)
    expect(all.graph.hasEdge('edge_2')).toBe(true)

    const personsOnly = buildAtlasModel(atlasSnapshot, new Set(['person']), noPositions)
    expect(personsOnly.graph.hasEdge('edge_1')).toBe(true)
    expect(personsOnly.graph.hasEdge('edge_2')).toBe(false)
  })

  it('excludes filtered types from both the canvas graph and the semantic list', () => {
    const model = buildAtlasModel(snapshot, new Set(['person', 'arc']), noPositions)
    expect(model.graph.nodes()).toEqual(['arc_1', 'person_1'])
    expect(model.semanticNodes.map((node) => node.id)).toEqual(['arc_1', 'person_1'])
    expect(model.graph.hasNode('realm_1')).toBe(false)
  })

  // Layout maths lives entirely in ./graph/layout.js now: buildAtlasModel
  // only has to place each node at whatever position it is handed, which is
  // what these two guard, without depending on ForceAtlas2/noverlap at all.
  it('assigns each node the x, y from the given positions map', () => {
    const positions: Positions = { arc_1: { x: 12, y: -7 }, person_1: { x: -3.5, y: 8 } }
    const model = buildAtlasModel(snapshot, new Set(['person', 'arc']), positions)
    expect(model.graph.getNodeAttributes('arc_1').x).toBe(12)
    expect(model.graph.getNodeAttributes('arc_1').y).toBe(-7)
    expect(model.graph.getNodeAttributes('person_1').x).toBe(-3.5)
    expect(model.graph.getNodeAttributes('person_1').y).toBe(8)
  })

  it('defaults a node missing from the positions map to the origin', () => {
    const model = buildAtlasModel(snapshot, new Set(['person', 'arc']), noPositions)
    expect(model.graph.getNodeAttributes('arc_1').x).toBe(0)
    expect(model.graph.getNodeAttributes('arc_1').y).toBe(0)
  })
})

describe('colorForType', () => {
  const types = ['realm', 'arc', 'item', 'session', 'person', 'entity'] as const

  it('returns a distinct monochrome shade for every node type on the light ramp', () => {
    const colors = types.map((type) => colorForType(type, false))
    expect(new Set(colors).size).toBe(types.length)
    for (const color of colors) expect(color).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('returns a distinct monochrome shade for every node type on the dark ramp, different from the light one', () => {
    const lightColors = types.map((type) => colorForType(type, false))
    const darkColors = types.map((type) => colorForType(type, true))
    expect(new Set(darkColors).size).toBe(types.length)
    for (const color of darkColors) expect(color).toMatch(/^#[0-9a-f]{6}$/i)
    for (let index = 0; index < types.length; index++) {
      expect(darkColors[index]).not.toBe(lightColors[index])
    }
  })

  it('defaults to the light ramp when no ground preference is available (as in this test environment)', () => {
    for (const type of types) expect(colorForType(type)).toBe(colorForType(type, false))
  })
})

describe('borderColorForType', () => {
  const types = ['realm', 'arc', 'item', 'session', 'person', 'entity'] as const

  it("returns a ring shade different from that type's own fill, on both grounds", () => {
    for (const dark of [false, true]) {
      for (const type of types) {
        expect(borderColorForType(type, dark)).not.toBe(colorForType(type, dark))
      }
    }
  })

  it('returns a distinct ring shade for every type on the light ramp', () => {
    const colors = types.map((type) => borderColorForType(type, false))
    expect(new Set(colors).size).toBe(types.length)
  })
})

// A small hex-distance helper local to this describe block, independent of
// mixHex's own implementation in atlas.tsx: it measures how far apart two
// hex colours are (summed absolute channel difference) so the edgeColor
// tests below can assert the visual relationship ("confirmed reads stronger
// than unconfirmed", "both are far from full strength") without hardcoding
// the exact mixed hex values, which would just be re-deriving mixHex's own
// arithmetic and would not actually falsify a broken implementation any
// better than an ordering check does.
function hexDistance(a: string, b: string): number {
  const toChannels = (hex: string) => {
    const value = hex.replace('#', '')
    return [0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16))
  }
  const [ar, ag, ab] = toChannels(a)
  const [br, bg, bb] = toChannels(b)
  return (
    Math.abs((ar ?? 0) - (br ?? 0)) +
    Math.abs((ag ?? 0) - (bg ?? 0)) +
    Math.abs((ab ?? 0) - (bb ?? 0))
  )
}

describe('edgeColor', () => {
  const grounds = [false, true] as const

  it('returns a 6-digit opaque hex for every confirmed/ground combination', () => {
    for (const dark of grounds) {
      for (const confirmed of [true, false]) {
        expect(edgeColor(confirmed, dark)).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })

  it('gives confirmed and unconfirmed edges different colours, on both grounds', () => {
    for (const dark of grounds) {
      expect(edgeColor(true, dark)).not.toBe(edgeColor(false, dark))
    }
  })

  it('keeps a confirmed edge visually stronger (closer to the realm colour) than an unconfirmed one, on both grounds', () => {
    for (const dark of grounds) {
      const anchor = colorForType('realm', dark)
      const confirmedDistance = hexDistance(edgeColor(true, dark), anchor)
      const unconfirmedDistance = hexDistance(edgeColor(false, dark), anchor)
      expect(confirmedDistance).toBeLessThan(unconfirmedDistance)
    }
  })

  it('keeps both edge states clearly dimmer than full realm strength (edges recede, they are not the brightest thing on screen)', () => {
    for (const dark of grounds) {
      const anchor = colorForType('realm', dark)
      // 255 is the maximum possible summed distance for a single channel
      // swing; requiring at least a third of that confirms these are
      // genuinely muted colours, not a token nudge.
      expect(hexDistance(edgeColor(true, dark), anchor)).toBeGreaterThan(85)
      expect(hexDistance(edgeColor(false, dark), anchor)).toBeGreaterThan(85)
    }
  })
})

describe('edgeSize', () => {
  it('stays within a narrow band across the whole confidence range', () => {
    expect(edgeSize(0)).toBeCloseTo(1)
    expect(edgeSize(1)).toBeCloseTo(1.4)
  })

  it('grows monotonically with confidence', () => {
    expect(edgeSize(0.9)).toBeGreaterThan(edgeSize(0.1))
  })
})

describe('LABEL_RENDERED_SIZE_THRESHOLD', () => {
  // This is the pure-arithmetic half of the label-collision fix: it does not
  // exercise Sigma's LabelGrid or renderLabels (jsdom has no WebGL, so
  // neither ever runs in this suite), but it does pin down the exact
  // boundary condition the settings comment in atlas.tsx argues for, so a
  // future change to either the threshold or the size bands that breaks the
  // "person and entity unlabelled, arc and realm labelled, at the default
  // ratio-1 view" guarantee fails here instead of silently reintroducing the
  // Priya/Arjun-style collision.
  it('sits strictly between the person band ceiling and the arc band floor', () => {
    expect(LABEL_RENDERED_SIZE_THRESHOLD).toBeGreaterThan(TYPE_SIZE_BAND.person.max)
    expect(LABEL_RENDERED_SIZE_THRESHOLD).toBeLessThanOrEqual(TYPE_SIZE_BAND.arc.min)
  })

  it('also sits above the entity band ceiling, so entities are unlabelled at rest too', () => {
    expect(LABEL_RENDERED_SIZE_THRESHOLD).toBeGreaterThan(TYPE_SIZE_BAND.entity.max)
  })

  it('sits below the realm band floor, so realms are always labelled at rest', () => {
    expect(LABEL_RENDERED_SIZE_THRESHOLD).toBeLessThan(TYPE_SIZE_BAND.realm.min)
  })
})

describe('Atlas', () => {
  it('starts with item nodes filtered off, leaving 27 of the 116 nodes selectable', () => {
    render(<Atlas snapshot={realisticSnapshot} />)
    const list = screen.getByRole('list', { name: 'Atlas nodes' })
    expect(within(list).getAllByRole('button')).toHaveLength(27)
  })

  it('keeps every person and entity node reachable in the default list', () => {
    render(<Atlas snapshot={realisticSnapshot} />)
    const list = screen.getByRole('list', { name: 'Atlas nodes' })
    for (const node of realisticSnapshot.nodes) {
      if (node.type === 'person' || node.type === 'entity') {
        expect(within(list).getByRole('button', { name: node.label })).toBeVisible()
      }
    }
  })

  it('narrows the node list by a case-insensitive label search', async () => {
    render(<Atlas snapshot={realisticSnapshot} />)
    const list = screen.getByRole('list', { name: 'Atlas nodes' })
    expect(within(list).getAllByRole('button')).toHaveLength(27)

    await userEvent.type(screen.getByLabelText('Search nodes'), 'person 3')

    const narrowed = within(list).getAllByRole('button')
    expect(narrowed).toHaveLength(1)
    expect(narrowed[0]).toHaveTextContent('Person 3')
  })

  it('shows live per-type counts in the filter, and toggling a type changes the list', async () => {
    render(<Atlas snapshot={realisticSnapshot} />)
    const filterGroup = screen.getByRole('group', { name: 'Node types' })
    expect(filterGroup).toHaveTextContent('items')
    expect(filterGroup).toHaveTextContent('89')

    await userEvent.click(screen.getByRole('checkbox', { name: /items 89/ }))
    const list = screen.getByRole('list', { name: 'Atlas nodes' })
    expect(within(list).getAllByRole('button')).toHaveLength(27 + 89)
  })

  it('selects a node by keyboard and shows its detail panel with graph provenance', async () => {
    render(<Atlas snapshot={atlasSnapshot} />)
    const button = screen.getByRole('button', { name: 'Mina' })
    button.focus()
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByRole('heading', { name: 'Mina' })).toBeVisible()
    expect(screen.getByText('Confidence: 0.82')).toBeVisible()
    expect(screen.getByText('Unconfirmed')).toBeVisible()
    expect(screen.getByText('doc_mina')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: 'Noor' }))
    expect(screen.getByRole('heading', { name: 'Noor' })).toBeVisible()
  })

  it('fetches and renders a selected node document inline through the optional api prop', async () => {
    const document: Document = {
      docId: 'doc_mina',
      kind: 'person',
      title: 'Mina',
      updatedAt: '2026-08-15T12:00:05.000Z',
      readOnly: true,
      body: 'Mina moved to the new house in July.',
    }
    const api: Pick<AppApi, 'getDocument'> = { getDocument: vi.fn().mockResolvedValue(document) }
    render(<Atlas snapshot={atlasSnapshot} api={api} />)
    await userEvent.click(screen.getByRole('button', { name: 'Mina' }))
    expect(await screen.findByText('Mina moved to the new house in July.')).toBeVisible()
    expect(api.getDocument).toHaveBeenCalledWith('doc_mina')
  })

  it('shows an inline error when the document fetch fails', async () => {
    const api: Pick<AppApi, 'getDocument'> = {
      getDocument: vi.fn().mockRejectedValue(new Error('boom')),
    }
    render(<Atlas snapshot={atlasSnapshot} api={api} />)
    await userEvent.click(screen.getByRole('button', { name: 'Mina' }))
    expect(await screen.findByText('The document could not load.')).toBeVisible()
  })

  it('renders an empty graph without attempting to add edges', () => {
    const addEdgeSpy = vi.spyOn(Graph.prototype, 'addEdgeWithKey')
    render(<Atlas snapshot={emptySnapshot} />)
    expect(screen.getByText('No graph records yet.')).toBeVisible()
    expect(addEdgeSpy).not.toHaveBeenCalled()
  })

  it('degrades to the list and detail panel without throwing when WebGL is unavailable', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(() => render(<Atlas snapshot={atlasSnapshot} />)).not.toThrow()
    expect(screen.getByRole('list', { name: 'Atlas nodes' })).toBeVisible()
    expect(screen.getByText('Select a node to see its details.')).toBeVisible()
  })

  it('exposes all seven node types in the filter, each with a checkbox', () => {
    render(<Atlas snapshot={realisticSnapshot} />)
    const filterGroup = screen.getByRole('group', { name: 'Node types' })
    for (const label of [
      'realms',
      'arcs',
      'items',
      'sessions',
      'people',
      'entities',
      'commitments',
    ]) {
      expect(within(filterGroup).getByText(label, { exact: false })).toBeVisible()
    }
    expect(within(filterGroup).getAllByRole('checkbox')).toHaveLength(7)
  })

  it('gives every filter legend swatch the exact colour colorForType returns for that type', () => {
    render(<Atlas snapshot={realisticSnapshot} />)
    const filterGroup = screen.getByRole('group', { name: 'Node types' })
    const cases: Array<[NodeType, RegExp]> = [
      ['realm', /^realms/],
      ['arc', /^arcs/],
      ['item', /^items/],
      ['session', /^sessions/],
      ['person', /^people/],
      ['entity', /^entities/],
    ]
    for (const [type, name] of cases) {
      const checkbox = within(filterGroup).getByRole('checkbox', { name })
      const swatch = checkbox.closest('label')?.querySelector('.atlas-filter-swatch')
      expect(swatch).not.toBeNull()
      expect((swatch as HTMLElement).style.background).toBe(hexToRgb(colorForType(type)))
    }
  })

  it('gives every filter legend swatch a border colour derived from borderColorForType, distinct from its own fill', () => {
    render(<Atlas snapshot={realisticSnapshot} />)
    const filterGroup = screen.getByRole('group', { name: 'Node types' })
    const cases: Array<[NodeType, RegExp]> = [
      ['realm', /^realms/],
      ['arc', /^arcs/],
      ['item', /^items/],
      ['session', /^sessions/],
      ['person', /^people/],
      ['entity', /^entities/],
    ]
    for (const [type, name] of cases) {
      const checkbox = within(filterGroup).getByRole('checkbox', { name })
      const swatch = checkbox.closest('label')?.querySelector('.atlas-filter-swatch') as HTMLElement
      expect(swatch.style.borderColor).toBe(hexToRgb(borderColorForType(type)))
      expect(swatch.style.borderColor).not.toBe(swatch.style.background)
      expect(Number.parseFloat(swatch.style.borderWidth)).toBeGreaterThan(0)
    }
  })

  it('sizes the legend swatches by the same visual-weight priority as the canvas ramp', () => {
    render(<Atlas snapshot={realisticSnapshot} />)
    const filterGroup = screen.getByRole('group', { name: 'Node types' })
    const priorityOrder: Array<[NodeType, RegExp]> = [
      ['realm', /^realms/],
      ['arc', /^arcs/],
      ['person', /^people/],
      ['entity', /^entities/],
      ['session', /^sessions/],
      ['item', /^items/],
    ]
    const sizes = priorityOrder.map(([, name]) => {
      const checkbox = within(filterGroup).getByRole('checkbox', { name })
      const swatch = checkbox.closest('label')?.querySelector('.atlas-filter-swatch') as HTMLElement
      return Number.parseFloat(swatch.style.width)
    })
    for (let index = 1; index < sizes.length; index++) {
      const current = sizes[index]
      const previous = sizes[index - 1]
      if (current === undefined || previous === undefined) throw new Error('missing swatch size')
      expect(current).toBeLessThan(previous)
    }
  })

  it('keeps the full label as a title attribute on each node list button', () => {
    render(<Atlas snapshot={atlasSnapshot} />)
    const button = screen.getByRole('button', { name: 'Mina' })
    expect(button).toHaveAttribute('title', 'Mina')
  })

  it('exposes zoom in, zoom out, and reset view as labelled buttons that can each take keyboard focus', () => {
    render(<Atlas snapshot={atlasSnapshot} />)
    for (const name of ['Zoom in', 'Zoom out', 'Reset view']) {
      const button = screen.getByRole('button', { name })
      expect(button).toBeVisible()
      expect(button.tagName).toBe('BUTTON')
      button.focus()
      expect(button).toHaveFocus()
    }
  })

  it('does not throw when the map controls are used with no renderer (WebGL unavailable)', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    render(<Atlas snapshot={atlasSnapshot} />)
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    await userEvent.click(screen.getByRole('button', { name: 'Reset view' }))
  })
})

describe('AtlasView', () => {
  it('shows a loading line, then mounts the atlas once the snapshot resolves', async () => {
    const api = { getGraphSnapshot: vi.fn().mockResolvedValue(snapshot) } as unknown as AppApi
    render(<AtlasView api={api} />)
    expect(screen.getByText('Loading the atlas.')).toBeVisible()
    expect(await screen.findByRole('region', { name: 'Atlas' })).toBeVisible()
  })

  it('shows an error line when the snapshot fetch fails', async () => {
    const api = {
      getGraphSnapshot: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as AppApi
    render(<AtlasView api={api} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('The atlas could not load.')
  })
})
