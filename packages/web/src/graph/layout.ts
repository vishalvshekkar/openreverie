import Graphology from 'graphology'
import { circular } from 'graphology-layout'
import forceAtlas2Import from 'graphology-layout-forceatlas2'
import noverlapImport from 'graphology-layout-noverlap'

// These three packages ship CommonJS declaration files written with ESM
// `export default` syntax rather than `export =`. Under this project's
// NodeNext module resolution that combination makes a plain default import
// resolve to the whole CJS module namespace instead of the declared default
// export, losing methods like `.assign`. The runtime value is correct either
// way (Node's CJS/ESM interop already hands back `module.exports`); only the
// static type needs the explicit `typeof import(...).default` unwrap.
// `atlas.tsx` documents the same quirk for `graphology` itself.
type GraphClass = typeof import('graphology').default
export type Graph = InstanceType<GraphClass>
const GraphConstructor = Graphology as unknown as GraphClass

type ForceAtlas2Api = typeof import('graphology-layout-forceatlas2').default
type NoverlapApi = typeof import('graphology-layout-noverlap').default
const forceAtlas2 = forceAtlas2Import as unknown as ForceAtlas2Api
const noverlap = noverlapImport as unknown as NoverlapApi

export interface Point {
  x: number
  y: number
}

export type Positions = Record<string, Point>

export interface LayoutResult {
  positions: Positions
  /** How many ForceAtlas2 iterations were actually run. */
  iterations: number
}

// ForceAtlas2 iteration count scales with graph size so a hub-heavy graph has
// enough steps to settle, but a hard ceiling keeps a very large graph from
// hanging the tab: 60 base iterations plus 3 per node, capped at 800. A
// realistic fixture (roughly 116 nodes) lands at 60 + 3*116 = 408, well under
// the ceiling; the ceiling only bites above roughly 250 nodes.
const FA2_BASE_ITERATIONS = 60
const FA2_ITERATIONS_PER_NODE = 3
const FA2_ITERATIONS_CEILING = 800

// Collision removal runs a fixed number of iterations (not a convergence
// threshold, to keep the pipeline deterministic and bounded) with a margin
// wide enough to leave visible daylight between two default-sized (size: 1)
// node discs. graphology-layout-noverlap's actual collision test is
// `dist < size1*ratio + margin + size2*ratio + margin`; with the default
// ratio of 1 and every node's default size of 1, the true minimum centre
// separation it enforces is 2 + 2*NOVERLAP_MARGIN, not size1 + size2 +
// margin. Measured directly against the realistic fixture below (all-new,
// no known positions): 26.02, matching 2 + 2*12 exactly.
const NOVERLAP_MAX_ITERATIONS = 400
export const NOVERLAP_MARGIN = 12

// ForceAtlas2's own converged scale can leave dense local pockets only a
// little tighter than NOVERLAP_MARGIN. noverlap resolves an overlap by
// nudging one node a fixed distance per iteration, not by an amount
// proportional to the remaining overlap, so when several nodes in one
// pocket all need to move past each other the fixed-size nudges compete and
// the pocket does not reliably spread out within a bounded iteration count
// (measured directly against the realistic fixture: 400, 1000, and 8000
// noverlap iterations all left the tightest pair under half of
// NOVERLAP_MARGIN apart). Scaling the whole settled layout up before
// noverlap runs gives every pocket proportionally more room, which measured
// reliably clears the margin on the realistic fixture. This does not affect
// determinism: it is a fixed multiply, not a threshold-based decision.
const NOVERLAP_PRESCALE = 2

// The mixed known/new pipeline (computeMixedLayout) cannot run known
// positions through graphology-layout-noverlap at all, since noverlap has
// no way to pin a node: every node it is given is a candidate for movement.
// Its own collision-resolution pass therefore targets the same true
// separation real noverlap enforces on the fresh-layout pipeline
// (2 + 2*NOVERLAP_MARGIN, see the comment on NOVERLAP_MARGIN above) so a
// graph that mixes known and new nodes is not held to a looser guarantee
// than one laid out from scratch.
const MIN_SEPARATION = 2 + 2 * NOVERLAP_MARGIN

// Deterministic fallback search: how many outward rings, and how many
// angle samples per ring, to try when sequential pairwise separation
// (resolveOverlaps below) leaves a movable node still colliding after its
// iteration budget. Growing the radius without bound while the obstacle set
// stays finite guarantees a clear spot is eventually found; this cap is
// only a defensive ceiling; it is generous enough that no realistic graph
// should ever reach it.
const CLEAR_SPOT_MAX_RINGS = 2000
const CLEAR_SPOT_SAMPLES_PER_RING = 24

// A small, deterministic per-id offset so two new sibling nodes seeded from
// the same neighbour centroid do not land on the exact same point. Derived
// from an FNV-1a style hash of the node id, never from Math.random or
// Date.now.
const OFFSET_MAGNITUDE = 6

function angleForId(id: string): number {
  let hash = 2166136261
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return ((hash >>> 0) % 360) * (Math.PI / 180)
}

function offsetForId(id: string, magnitude: number): Point {
  const angle = angleForId(id)
  return { x: magnitude * Math.cos(angle), y: magnitude * Math.sin(angle) }
}

function isFinitePoint(value: unknown): value is Point {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Point>
  return (
    typeof candidate.x === 'number' &&
    typeof candidate.y === 'number' &&
    Number.isFinite(candidate.x) &&
    Number.isFinite(candidate.y)
  )
}

// Deterministic circular seed for nodes with no already-placed neighbour to
// derive a position from. Built with a fresh, sorted-insertion temporary
// graph rather than the real one so the result never depends on the real
// graph's own node insertion order.
function circularFallback(ids: readonly string[]): Positions {
  const sortedIds = [...ids].sort()
  const temp = new GraphConstructor()
  for (const id of sortedIds) temp.addNode(id)
  const raw = circular(temp)
  const result: Positions = {}
  for (const id of sortedIds) {
    const point = raw[id]
    result[id] = { x: point?.x ?? 0, y: point?.y ?? 0 }
  }
  return result
}

// Seeds every node with an x/y before ForceAtlas2 runs (it throws otherwise).
// Nodes in `known` take their stored position. New nodes are placed at the
// centroid of their already-placed neighbours plus a deterministic per-id
// offset; this cascades in rounds so a chain of new nodes still resolves
// from whichever known nodes anchor it. Nodes with no path to a placed
// neighbour fall back to a deterministic circular seed.
function seedPositions(graph: Graph, known: Positions): void {
  const nodeIds = [...graph.nodes()].sort()
  const settled = new Map<string, Point>()

  for (const id of nodeIds) {
    const point = known[id]
    if (isFinitePoint(point)) settled.set(id, point)
  }

  let unresolved = nodeIds.filter((id) => !settled.has(id))
  let progressed = true
  while (progressed && unresolved.length > 0) {
    progressed = false
    const roundBaseline = new Map(settled)
    const stillUnresolved: string[] = []

    for (const id of unresolved) {
      const neighbourPoints = graph
        .neighbors(id)
        .filter((neighbourId) => roundBaseline.has(neighbourId))
        .map((neighbourId) => roundBaseline.get(neighbourId))
        .filter((point): point is Point => point !== undefined)

      if (neighbourPoints.length > 0) {
        const centroid = {
          x: neighbourPoints.reduce((sum, point) => sum + point.x, 0) / neighbourPoints.length,
          y: neighbourPoints.reduce((sum, point) => sum + point.y, 0) / neighbourPoints.length,
        }
        const offset = offsetForId(id, OFFSET_MAGNITUDE)
        settled.set(id, { x: centroid.x + offset.x, y: centroid.y + offset.y })
        progressed = true
      } else {
        stillUnresolved.push(id)
      }
    }

    unresolved = stillUnresolved
  }

  if (unresolved.length > 0) {
    const fallback = circularFallback(unresolved)
    for (const id of unresolved) {
      const point = fallback[id]
      if (point !== undefined) settled.set(id, point)
    }
  }

  for (const id of nodeIds) {
    const point = settled.get(id)
    if (point === undefined) continue
    graph.setNodeAttribute(id, 'x', point.x)
    graph.setNodeAttribute(id, 'y', point.y)
  }
}

function fa2IterationsFor(order: number): number {
  return Math.min(FA2_ITERATIONS_CEILING, FA2_BASE_ITERATIONS + FA2_ITERATIONS_PER_NODE * order)
}

// graphology-layout-noverlap breaks an exact-overlap tie (two nodes at the
// identical float coordinate) with Math.random, which would make the whole
// pipeline non-deterministic on the rare graph shape where symmetric forces
// converge two nodes to the same point. ForceAtlas2 itself has no
// randomness, so any exact overlap is resolved deterministically here, by a
// tiny id-derived nudge, before noverlap ever runs: the nudge is far smaller
// than NOVERLAP_MARGIN so it does not affect the collision-removal outcome,
// it only ensures noverlap never takes its random branch.
const EXACT_OVERLAP_NUDGE = 0.001

function deconflictExactOverlaps(graph: Graph): void {
  const seen = new Set<string>()
  for (const id of [...graph.nodes()].sort()) {
    const x = graph.getNodeAttribute(id, 'x')
    const y = graph.getNodeAttribute(id, 'y')
    const key = `${x},${y}`
    if (!seen.has(key)) {
      seen.add(key)
      continue
    }
    const offset = offsetForId(id, EXACT_OVERLAP_NUDGE)
    graph.setNodeAttribute(id, 'x', x + offset.x)
    graph.setNodeAttribute(id, 'y', y + offset.y)
    seen.add(`${x + offset.x},${y + offset.y}`)
  }
}

function scalePositions(graph: Graph, factor: number): void {
  for (const id of graph.nodes()) {
    graph.setNodeAttribute(id, 'x', graph.getNodeAttribute(id, 'x') * factor)
    graph.setNodeAttribute(id, 'y', graph.getNodeAttribute(id, 'y') * factor)
  }
}

// A hand-chosen position (the user dragged a node, or a prior computeLayout
// call already settled it) is testimony a human gave the layout, not a
// seed physics gets a vote on. This lays out a graph with no known
// positions at all through the original, unchanged, well-tested pipeline:
// ForceAtlas2 over the whole graph, deconflict exact ties, prescale, real
// noverlap. It exists purely so that path never has to change shape to
// accommodate the known/new split below.
function computeFreshLayout(graph: Graph): LayoutResult {
  seedPositions(graph, {})

  const iterations = fa2IterationsFor(graph.order)
  const settings = forceAtlas2.inferSettings(graph)
  forceAtlas2.assign(graph, { iterations, settings })
  deconflictExactOverlaps(graph)
  scalePositions(graph, NOVERLAP_PRESCALE)

  noverlap.assign(graph, {
    maxIterations: NOVERLAP_MAX_ITERATIONS,
    settings: { margin: NOVERLAP_MARGIN },
  })

  const positions: Positions = {}
  for (const id of graph.nodes()) {
    positions[id] = { x: graph.getNodeAttribute(id, 'x'), y: graph.getNodeAttribute(id, 'y') }
  }

  return { positions, iterations }
}

function hasCollisionAt(graph: Graph, id: string, point: Point, minSeparation: number): boolean {
  for (const otherId of graph.nodes()) {
    if (otherId === id) continue
    const ox = graph.getNodeAttribute(otherId, 'x')
    const oy = graph.getNodeAttribute(otherId, 'y')
    if (Math.hypot(point.x - ox, point.y - oy) < minSeparation) return true
  }
  return false
}

// Deterministic last resort for a movable node that sequential pairwise
// separation could not settle within its iteration budget (for example, one
// new node boxed in on several sides by fixed obstacles, each pairwise
// correction undoing another). Walks outward ring by ring from the node's
// current position, sampling a fixed, id-derived set of angles per ring,
// until it finds a point that clears every other node in the graph. The
// search radius grows without bound while the obstacle set is finite, so a
// clear spot is always eventually found; CLEAR_SPOT_MAX_RINGS is only a
// defensive ceiling.
function findClearSpot(graph: Graph, id: string, minSeparation: number): Point {
  const originX = graph.getNodeAttribute(id, 'x')
  const originY = graph.getNodeAttribute(id, 'y')
  const phase = angleForId(id)

  let candidate: Point = { x: originX, y: originY }
  for (let ring = 1; ring <= CLEAR_SPOT_MAX_RINGS; ring += 1) {
    const radius = minSeparation * ring
    for (let sample = 0; sample < CLEAR_SPOT_SAMPLES_PER_RING; sample += 1) {
      const angle = phase + (2 * Math.PI * sample) / CLEAR_SPOT_SAMPLES_PER_RING
      candidate = { x: originX + radius * Math.cos(angle), y: originY + radius * Math.sin(angle) }
      if (!hasCollisionAt(graph, id, candidate, minSeparation)) return candidate
    }
  }

  // Unreachable in practice; see the function comment. Best-effort return
  // rather than throwing.
  return candidate
}

// Pushes only `movableIds` apart from each other and from every fixed
// (known) node until every pair is at least `minSeparation` apart, or the
// iteration budget runs out. Fixed nodes are read as obstacles (they take
// part in every distance check) but are never written to: two fixed nodes
// that already sit closer than minSeparation are left exactly as given,
// since a hand-chosen position is never physics's to adjust. Ties at an
// identical coordinate are broken with an id-derived direction, never
// Math.random, matching the determinism and no-randomness guarantees this
// module gives the fresh-layout pipeline.
function resolveOverlaps(
  graph: Graph,
  movableIds: readonly string[],
  minSeparation: number,
  maxIterations: number,
): void {
  const allIds = [...graph.nodes()].sort()
  const movable = new Set(movableIds)

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let anyCollision = false

    for (let i = 0; i < allIds.length; i += 1) {
      const idA = allIds[i]
      if (idA === undefined) continue
      const aMovable = movable.has(idA)

      for (let j = i + 1; j < allIds.length; j += 1) {
        const idB = allIds[j]
        if (idB === undefined) continue
        const bMovable = movable.has(idB)
        if (!aMovable && !bMovable) continue

        const ax = graph.getNodeAttribute(idA, 'x')
        const ay = graph.getNodeAttribute(idA, 'y')
        const bx = graph.getNodeAttribute(idB, 'x')
        const by = graph.getNodeAttribute(idB, 'y')

        let dx = bx - ax
        let dy = by - ay
        let dist = Math.hypot(dx, dy)
        if (dist >= minSeparation) continue

        anyCollision = true

        if (dist === 0) {
          const nudge = offsetForId(`${idA}::${idB}`, minSeparation)
          dx = nudge.x
          dy = nudge.y
          dist = minSeparation
        }

        const unitX = dx / dist
        const unitY = dy / dist
        const overlap = minSeparation - dist

        if (aMovable && bMovable) {
          const half = overlap / 2
          graph.setNodeAttribute(idA, 'x', ax - unitX * half)
          graph.setNodeAttribute(idA, 'y', ay - unitY * half)
          graph.setNodeAttribute(idB, 'x', bx + unitX * half)
          graph.setNodeAttribute(idB, 'y', by + unitY * half)
        } else if (aMovable) {
          graph.setNodeAttribute(idA, 'x', ax - unitX * overlap)
          graph.setNodeAttribute(idA, 'y', ay - unitY * overlap)
        } else {
          graph.setNodeAttribute(idB, 'x', bx + unitX * overlap)
          graph.setNodeAttribute(idB, 'y', by + unitY * overlap)
        }
      }
    }

    if (!anyCollision) break
  }

  for (const id of [...movableIds].sort()) {
    const point = { x: graph.getNodeAttribute(id, 'x'), y: graph.getNodeAttribute(id, 'y') }
    if (!hasCollisionAt(graph, id, point, minSeparation)) continue
    const settled = findClearSpot(graph, id, minSeparation)
    graph.setNodeAttribute(id, 'x', settled.x)
    graph.setNodeAttribute(id, 'y', settled.y)
  }
}

// Lays out a graph where some, but not all, nodes already have a
// hand-chosen position. Known nodes must come back byte-identical to what
// was stored (requirement this whole module exists to guarantee), so
// physics only ever gets a vote on the new nodes.
//
// Neither graphology-layout-forceatlas2 nor graphology-layout-noverlap can
// natively pin a node's position for certain across their whole run:
// ForceAtlas2 does honour an undocumented `fixed` node attribute in the
// version this package currently depends on (verified by reading
// iterate.js: the position-apply step is skipped for fixed nodes, but they
// still take part in every repulsion/attraction calculation, which is
// exactly "fixed obstacle" behaviour), but that is not part of its
// documented or typed API and could change without notice. So it is used
// here only to improve where new nodes settle, never as the source of
// exactness. noverlap has no such attribute at all: every node given to it
// is a candidate for movement, which is precisely how the original bug
// happened. So this function never calls noverlap; it resolves collisions
// itself with resolveOverlaps, which is built to leave fixed nodes alone by
// construction. Exactness for known nodes ultimately comes from the
// unconditional write-back at the end of this function, independent of
// whether ForceAtlas2's fixed attribute did anything at all.
function computeMixedLayout(graph: Graph, known: ReadonlyMap<string, Point>): LayoutResult {
  const knownPositions: Positions = {}
  for (const [id, point] of known) knownPositions[id] = point
  seedPositions(graph, knownPositions)

  for (const id of known.keys()) graph.setNodeAttribute(id, 'fixed', true)

  const iterations = fa2IterationsFor(graph.order)
  const settings = forceAtlas2.inferSettings(graph)
  forceAtlas2.assign(graph, { iterations, settings })

  for (const id of known.keys()) graph.removeNodeAttribute(id, 'fixed')

  // Belt and braces: restore known nodes to their exact stored value before
  // resolving overlaps, so the obstacles resolveOverlaps sees are always
  // the true positions, regardless of whether ForceAtlas2's fixed attribute
  // actually held them still.
  for (const [id, point] of known) {
    graph.setNodeAttribute(id, 'x', point.x)
    graph.setNodeAttribute(id, 'y', point.y)
  }

  const movableIds = graph.nodes().filter((id) => !known.has(id))
  resolveOverlaps(graph, movableIds, MIN_SEPARATION, NOVERLAP_MAX_ITERATIONS)

  // Final, unconditional write-back: this is the actual source of
  // requirement 2's exactness, not a byproduct of the steps above.
  for (const [id, point] of known) {
    graph.setNodeAttribute(id, 'x', point.x)
    graph.setNodeAttribute(id, 'y', point.y)
  }

  const positions: Positions = {}
  for (const id of graph.nodes()) {
    positions[id] = { x: graph.getNodeAttribute(id, 'x'), y: graph.getNodeAttribute(id, 'y') }
  }

  return { positions, iterations }
}

export function computeLayout(graph: Graph, known: Positions = {}): LayoutResult {
  if (graph.order === 0) {
    return { positions: {}, iterations: 0 }
  }

  // Requirements 5 and 6: a known entry only counts if its id is still in
  // the graph and its coordinate is a real, finite point. Anything else is
  // treated as if the node were unknown.
  const validKnown = new Map<string, Point>()
  for (const id of graph.nodes()) {
    const point = known[id]
    if (isFinitePoint(point)) validKnown.set(id, point)
  }

  // Requirement 1: every node already has a hand-chosen position. Physics
  // gets no vote at all: return exactly what was stored.
  if (validKnown.size === graph.order) {
    const positions: Positions = {}
    for (const id of graph.nodes()) {
      const point = validKnown.get(id)
      if (point !== undefined) positions[id] = { x: point.x, y: point.y }
    }
    return { positions, iterations: 0 }
  }

  if (validKnown.size === 0) {
    return computeFreshLayout(graph)
  }

  return computeMixedLayout(graph, validKnown)
}
