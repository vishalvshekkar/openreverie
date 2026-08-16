import Graphology from 'graphology'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeLayout, type Graph, NOVERLAP_MARGIN, type Positions } from './layout.js'

// Same CJS/ESM default-export unwrap as layout.ts and atlas.tsx.
type GraphClass = typeof import('graphology').default
const GraphConstructor = Graphology as unknown as GraphClass

function newGraph(): Graph {
  return new GraphConstructor()
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * Builds the graph shape described for real atlas data: 3 realm-like hubs,
 * 6 mid nodes, 89 leaves, 18 entirely loose (edgeless) nodes, and 172 edges
 * total: 3 hub-hub edges, 6 mid-to-hub edges, 89 leaf-to-mid primary edges,
 * and 74 leaf-to-leaf secondary edges (3 + 6 + 89 + 74 = 172).
 *
 * The secondary edges deliberately connect each of the first 74 leaves to
 * another leaf 17 apart (mod 89, which is prime, so this stride visits a
 * distinct pair for every leaf without ever looping back on itself). Real
 * memory-graph leaves are rarely exact topological twins; round-robin
 * leaf-to-hub secondary edges would make every leaf sharing one mid and one
 * hub structurally identical (up to 14 of them, since 89 leaves over 6 mids
 * and 3 hubs forces large ties), which is an unrealistically adversarial
 * shape for a force-directed layout to pull apart. This scheme keeps the
 * exact node and edge counts while giving every leaf a distinct pair of
 * neighbours.
 */
function buildRealisticFixtureGraph(): Graph {
  const graph = newGraph()
  const hubs = Array.from({ length: 3 }, (_unused, index) => `hub:${index}`)
  const mids = Array.from({ length: 6 }, (_unused, index) => `mid:${index}`)
  const leaves = Array.from({ length: 89 }, (_unused, index) => `leaf:${index}`)
  const loose = Array.from({ length: 18 }, (_unused, index) => `loose:${index}`)

  for (const id of [...hubs, ...mids, ...leaves, ...loose]) graph.addNode(id)

  for (let i = 0; i < hubs.length; i += 1) {
    const from = hubs[i] as string
    const to = hubs[(i + 1) % hubs.length] as string
    graph.mergeEdge(from, to)
  }

  mids.forEach((mid, index) => {
    graph.mergeEdge(mid, hubs[index % hubs.length] as string)
  })

  leaves.forEach((leaf, index) => {
    graph.mergeEdge(leaf, mids[index % mids.length] as string)
  })

  for (let index = 0; index < 74; index += 1) {
    graph.mergeEdge(leaves[index] as string, leaves[(index + 17) % leaves.length] as string)
  }

  return graph
}

/**
 * A deliberately adversarial round-robin fixture: every leaf sharing a mid
 * also shares the same hub, so groups of structurally identical leaves
 * exist (unlike buildRealisticFixtureGraph, which decorrelates leaf
 * neighbours on purpose). This makes ForceAtlas2 converge some leaf pairs
 * to the exact same floating-point coordinate, which is precisely the
 * condition graphology-layout-noverlap resolves with an unseeded
 * `Math.random()` tie-break. Used only to prove computeLayout neutralizes
 * that before noverlap ever sees it.
 */
function buildSymmetricClusterGraph(): Graph {
  const graph = newGraph()
  const hubs = Array.from({ length: 3 }, (_unused, index) => `hub:${index}`)
  const mids = Array.from({ length: 6 }, (_unused, index) => `mid:${index}`)
  const leaves = Array.from({ length: 89 }, (_unused, index) => `leaf:${index}`)

  for (const id of [...hubs, ...mids, ...leaves]) graph.addNode(id)
  for (let i = 0; i < hubs.length; i += 1) {
    graph.mergeEdge(hubs[i] as string, hubs[(i + 1) % hubs.length] as string)
  }
  mids.forEach((mid, index) => {
    graph.mergeEdge(mid, hubs[index % hubs.length] as string)
  })
  leaves.forEach((leaf, index) => {
    graph.mergeEdge(leaf, mids[index % mids.length] as string)
  })
  for (let index = 0; index < 74; index += 1) {
    graph.mergeEdge(leaves[index] as string, hubs[index % hubs.length] as string)
  }
  return graph
}

describe('computeLayout Math.random isolation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // No known positions at all: every node is new, so this exercises the
  // untouched fresh-layout pipeline (real ForceAtlas2 + real noverlap),
  // which is exactly the path deconflictExactOverlaps guards.
  it('never calls Math.random on a fresh layout, even when ForceAtlas2 converges two nodes to the exact same point', () => {
    const randomSpy = vi.spyOn(Math, 'random')

    computeLayout(buildSymmetricClusterGraph())

    expect(randomSpy).not.toHaveBeenCalled()
  })

  // Some known positions: this routes through the mixed known/new pipeline,
  // which never touches graphology-layout-noverlap at all, so it must be
  // random-free by construction rather than by deconfliction.
  it('never calls Math.random on a mixed layout, even when new nodes would otherwise converge to the same point', () => {
    const randomSpy = vi.spyOn(Math, 'random')
    const known: Positions = { 'hub:0': { x: 40, y: -15 }, 'leaf:3': { x: 5, y: 5 } }

    computeLayout(buildSymmetricClusterGraph(), known)

    expect(randomSpy).not.toHaveBeenCalled()
  })
})

describe('computeLayout', () => {
  it('builds the realistic fixture with exactly the stated node and edge counts', () => {
    const graph = buildRealisticFixtureGraph()
    expect(graph.order).toBe(3 + 6 + 89 + 18)
    expect(graph.size).toBe(172)
  })

  it('is deterministic: two separately-built identical graphs produce byte-identical positions', () => {
    const resultA = computeLayout(buildRealisticFixtureGraph())
    const resultB = computeLayout(buildRealisticFixtureGraph())

    expect(resultB).toEqual(resultA)
  })

  it('is deterministic given the same known positions too', () => {
    const known: Positions = { 'hub:0': { x: 40, y: -15 }, 'leaf:3': { x: 5, y: 5 } }
    const resultA = computeLayout(buildRealisticFixtureGraph(), known)
    const resultB = computeLayout(buildRealisticFixtureGraph(), known)

    expect(resultB).toEqual(resultA)
  })

  it('gives every node a finite position, including loose nodes with no edges', () => {
    const graph = buildRealisticFixtureGraph()
    const { positions } = computeLayout(graph)

    for (const id of graph.nodes()) {
      const point = positions[id]
      expect(point).toBeDefined()
      expect(Number.isFinite(point?.x)).toBe(true)
      expect(Number.isFinite(point?.y)).toBe(true)
    }
    expect(Object.keys(positions)).toHaveLength(graph.order)
  })

  it('keeps every pair of nodes at least the noverlap margin apart on the realistic fixture', () => {
    const graph = buildRealisticFixtureGraph()
    const { positions } = computeLayout(graph)
    const points = Object.values(positions)

    let minSeparation = Number.POSITIVE_INFINITY
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const a = points[i]
        const b = points[j]
        if (a === undefined || b === undefined) continue
        minSeparation = Math.min(minSeparation, distance(a, b))
      }
    }

    // Default node size is 1 (unset), so the true guaranteed centre
    // separation is size1 + size2 + margin = 2 + margin. Assert against the
    // slightly looser NOVERLAP_MARGIN bound to avoid coupling the test to
    // that extra detail while still proving real, visible daylight.
    expect(minSeparation).toBeGreaterThanOrEqual(NOVERLAP_MARGIN)
  })

  it('returns an empty result without throwing for an empty graph', () => {
    const graph = newGraph()
    expect(() => computeLayout(graph)).not.toThrow()
    expect(computeLayout(graph)).toEqual({ positions: {}, iterations: 0 })
  })

  it('returns a finite position without throwing for a single-node graph', () => {
    const graph = newGraph()
    graph.addNode('only:node')

    const result = computeLayout(graph)
    expect(result.iterations).toBeGreaterThan(0)
    expect(Number.isFinite(result.positions['only:node']?.x)).toBe(true)
    expect(Number.isFinite(result.positions['only:node']?.y)).toBe(true)
  })

  it('returns known positions completely unchanged, with iterations: 0, when every node is known', () => {
    const graph = buildRealisticFixtureGraph()
    const base = computeLayout(graph)

    const result = computeLayout(buildRealisticFixtureGraph(), base.positions)

    expect(result.iterations).toBe(0)
    expect(result.positions).toEqual(base.positions)
  })

  it('returns exact known positions with iterations: 0 for a hand-built graph too', () => {
    const graph = newGraph()
    graph.addNode('a')
    graph.addNode('b')
    graph.addEdge('a', 'b')
    const known: Positions = { a: { x: 123.456, y: -78.9 }, b: { x: -1, y: 2 } }

    const result = computeLayout(graph, known)

    expect(result).toEqual({ positions: known, iterations: 0 })
  })

  it('keeps a known node at exactly its saved position on an unchanged revisit', () => {
    const buildGraph = (): Graph => {
      const graph = newGraph()
      graph.addNode('hub:a')
      graph.addNode('hub:b')
      graph.addNode('mid:1')
      graph.addNode('mid:2')
      graph.addNode('leaf:1')
      graph.addNode('leaf:2')
      graph.addEdge('hub:a', 'hub:b')
      graph.addEdge('mid:1', 'hub:a')
      graph.addEdge('mid:2', 'hub:b')
      graph.addEdge('leaf:1', 'mid:1')
      graph.addEdge('leaf:2', 'mid:2')
      return graph
    }

    const first = computeLayout(buildGraph())
    // Every node in this graph is present in first.positions, so this
    // revisit has nothing new to place: it must hit the all-known exact
    // return path, not merely land close by continued simulation.
    const second = computeLayout(buildGraph(), first.positions)

    expect(second).toEqual({ positions: first.positions, iterations: 0 })
  })

  it('keeps every previously-known node exactly in place when a new node joins, and places the new node sensibly', () => {
    const buildBaseGraph = (): Graph => {
      const graph = newGraph()
      graph.addNode('hub:a')
      graph.addNode('hub:b')
      graph.addNode('mid:1')
      graph.addEdge('hub:a', 'hub:b')
      graph.addEdge('mid:1', 'hub:a')
      return graph
    }

    const base = computeLayout(buildBaseGraph())

    const grown = buildBaseGraph()
    grown.addNode('leaf:new')
    grown.addEdge('leaf:new', 'mid:1')

    const grownResult = computeLayout(grown, base.positions)

    // Requirement 2: every previously-known node comes back byte-identical.
    for (const id of Object.keys(base.positions)) {
      expect(grownResult.positions[id]).toEqual(base.positions[id])
    }

    // Requirement 3: the new node lands near its one neighbour, not at the
    // origin, and does not overlap any existing node.
    const neighbour = base.positions['mid:1']
    const newNode = grownResult.positions['leaf:new']
    expect(neighbour).toBeDefined()
    expect(newNode).toBeDefined()
    if (neighbour === undefined || newNode === undefined) return

    const distanceFromNeighbour = distance(newNode, neighbour)
    const distanceFromOrigin = distance(newNode, { x: 0, y: 0 })
    expect(distanceFromNeighbour).toBeLessThan(distanceFromOrigin)
    expect(distanceFromNeighbour).toBeLessThan(60)

    for (const id of Object.keys(base.positions)) {
      const other = grownResult.positions[id]
      if (other === undefined) continue
      expect(distance(newNode, other)).toBeGreaterThanOrEqual(NOVERLAP_MARGIN)
    }
  })

  it('ignores known entries for node ids no longer in the graph', () => {
    const graph = newGraph()
    graph.addNode('a')
    graph.addNode('b')
    graph.addEdge('a', 'b')
    const known: Positions = {
      a: { x: 10, y: 20 },
      'ghost:gone': { x: 999, y: 999 },
    }

    const result = computeLayout(graph, known)

    expect(result.positions.a).toEqual({ x: 10, y: 20 })
    expect(result.positions['ghost:gone']).toBeUndefined()
    expect(Object.keys(result.positions)).toHaveLength(2)
  })

  it('treats a known entry with a non-finite or malformed coordinate as unknown rather than letting it poison the layout', () => {
    const graph = newGraph()
    graph.addNode('a')
    graph.addNode('b')
    graph.addNode('c')
    graph.addEdge('a', 'b')
    graph.addEdge('b', 'c')
    const known = {
      a: { x: 10, y: 20 },
      b: { x: Number.NaN, y: 5 },
      c: { x: Number.POSITIVE_INFINITY, y: 0 },
    } as unknown as Positions

    const result = computeLayout(graph, known)

    expect(result.positions.a).toEqual({ x: 10, y: 20 })
    expect(Number.isFinite(result.positions.b?.x)).toBe(true)
    expect(Number.isFinite(result.positions.b?.y)).toBe(true)
    expect(Number.isFinite(result.positions.c?.x)).toBe(true)
    expect(Number.isFinite(result.positions.c?.y)).toBe(true)
    // b and c must not have been assigned their malformed input verbatim.
    expect(result.positions.b).not.toEqual({ x: Number.NaN, y: 5 })
    expect(result.positions.c).not.toEqual({ x: Number.POSITIVE_INFINITY, y: 0 })
  })

  it('keeps every known position exact and every pair at least the noverlap margin apart when new nodes join a large existing layout', () => {
    const graph = buildRealisticFixtureGraph()
    const base = computeLayout(graph)

    // Simulate the real-world shape of the bug: almost everything is
    // already placed by hand or by a prior layout, and a small number of
    // genuinely new nodes join.
    const known: Positions = { ...base.positions }
    delete known['leaf:5']
    delete known['leaf:42']
    delete known['loose:3']

    const result = computeLayout(buildRealisticFixtureGraph(), known)

    for (const id of Object.keys(known)) {
      expect(result.positions[id]).toEqual(known[id])
    }

    const points = Object.values(result.positions)
    let minSeparation = Number.POSITIVE_INFINITY
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const a = points[i]
        const b = points[j]
        if (a === undefined || b === undefined) continue
        minSeparation = Math.min(minSeparation, distance(a, b))
      }
    }
    expect(minSeparation).toBeGreaterThanOrEqual(NOVERLAP_MARGIN)
  })
})
