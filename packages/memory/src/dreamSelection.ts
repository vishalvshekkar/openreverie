// Deterministic selection for a dream run. All randomness flows from a
// recorded seed through mulberry32, so any dream's selection is
// reproducible from its rngSeed (dreaming design spec, Selection).
import type { GraphState, NodeType } from './graph.js'
import type { DocKind } from './sqlite.js'

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface DreamCandidate {
  id: string
  label: string
  kind: DocKind | 'node'
  nodeType?: NodeType
  date?: string
  degree: number
}

const MS_PER_DAY = 86_400_000
const STALENESS_CAP_DAYS = 365
const MIN_SEED_GAP_DAYS = 60
const RELAX_DATE_AFTER = 20
const RELAX_ADJACENCY_AFTER = 40
const JITTER = 0.35

// Per-kind base weight for the significance term. Constitution and open
// arcs sit above rollups, matching the spec's example ordering. Graph
// nodes use their degree instead (see candidateWeight below).
const KIND_BASE_WEIGHT: Partial<Record<DocKind, number>> = {
  constitution: 3,
  arc: 2.5,
  person: 2,
  realm: 2,
  summary: 1.5,
  journal: 1.5,
  rollup_daily: 1,
  rollup_weekly: 1,
}

// Deterministic half of the selection weight: staleness times significance,
// no jitter. pickSeeds adds the seeded jitter term on top of this.
export function candidateWeight(
  c: DreamCandidate,
  lastDreamt: Map<string, string>,
  now: Date,
): number {
  const last = lastDreamt.get(c.id) ?? c.date
  const parsed = last === undefined ? Number.NaN : Date.parse(last)
  const days = Number.isNaN(parsed)
    ? STALENESS_CAP_DAYS
    : Math.max(0, (now.getTime() - parsed) / MS_PER_DAY)
  const staleness = Math.min(days, STALENESS_CAP_DAYS) / STALENESS_CAP_DAYS
  const significance =
    c.kind === 'node' ? 1 + Math.log2(1 + c.degree) : (KIND_BASE_WEIGHT[c.kind] ?? 1)
  return staleness * significance
}

function daysApart(a?: string, b?: string): number | undefined {
  if (a === undefined || b === undefined) return undefined
  const parsedA = Date.parse(a)
  const parsedB = Date.parse(b)
  if (Number.isNaN(parsedA) || Number.isNaN(parsedB)) return undefined
  return Math.abs(parsedA - parsedB) / MS_PER_DAY
}

// Draws one item from pool with probability proportional to weightOf(item).
// Falls back to a uniform draw when every weight is zero (or the weights
// sum to a non-positive total), so a degenerate all-zero-weight pool never
// divides by zero. Shared by pickSeeds's weighted draw and randomWalk's
// degree-weighted neighbor draw.
function weightedChoice<T>(
  pool: T[],
  weightOf: (item: T) => number,
  rng: () => number,
): T | undefined {
  if (pool.length === 0) return undefined
  const weights = pool.map(weightOf)
  const total = weights.reduce((sum, w) => sum + w, 0)
  if (total <= 0) return pool[Math.floor(rng() * pool.length)]
  let target = rng() * total
  for (let i = 0; i < pool.length; i += 1) {
    target -= weights[i] ?? 0
    if (target <= 0) return pool[i]
  }
  return pool[pool.length - 1]
}

// Fills any seed slots the constrained draw in pickSeeds did not fill,
// using the highest remaining weight with no further constraints. This is
// the spec's "constraints relaxed progressively if the pool is too small
// to satisfy it" guarantee's final backstop: pickSeeds must always return
// count seeds for a caller with count < candidates.length. Exported so it
// is directly testable on its own: pickSeeds's own attempt budget is sized
// so the constrained loop above always fills every slot itself for a
// well-formed call (attempts > RELAX_ADJACENCY_AFTER unconditionally
// admits every remaining candidate, and there are always more such
// attempts available than slots left to fill), so this path is a
// defensive net rather than something pickSeeds's own end-to-end tests can
// trigger. See task-5-report.md for the reasoning and for why it is kept
// rather than removed.
export function fillRemainingSeeds(
  candidates: DreamCandidate[],
  chosen: DreamCandidate[],
  weightOf: (c: DreamCandidate) => number,
  count: number,
): DreamCandidate[] {
  if (chosen.length >= count) return chosen
  const leftovers = candidates
    .filter((c) => !chosen.some((s) => s.id === c.id))
    .sort((a, b) => weightOf(b) - weightOf(a))
  return [...chosen, ...leftovers.slice(0, count - chosen.length)]
}

// Picks two or three seeds by weight, pushed apart so a dream connects
// distant things rather than rehashing this week (dreaming design spec,
// Selection). Constraints relax progressively when the pool is too small
// to satisfy them: the date-gap rule drops after 20 failed draws, the
// adjacency rule after 40. The first slot is reserved for a candidate no
// newer than the median candidate date, so every dream reaches back.
// fillRemainingSeeds backstops the whole thing: whatever the constrained
// loop below does not fill, it fills from the remaining highest weight.
export function pickSeeds(args: {
  candidates: DreamCandidate[]
  lastDreamt: Map<string, string>
  now: Date
  rng: () => number
  adjacent: (a: string, b: string) => boolean
  count: number
}): DreamCandidate[] {
  const { candidates, lastDreamt, now, rng, adjacent, count } = args
  if (candidates.length <= count) return [...candidates]

  const weightById = new Map(
    candidates.map((c) => [c.id, candidateWeight(c, lastDreamt, now) + JITTER * rng()]),
  )
  const weightOf = (c: DreamCandidate) => weightById.get(c.id) ?? 0

  const datedSorted = candidates
    .filter((c) => c.date !== undefined)
    .map((c) => c.date as string)
    .sort()
  const median =
    datedSorted.length > 0 ? datedSorted[Math.floor(datedSorted.length / 2)] : undefined

  const chosen: DreamCandidate[] = []
  const maxAttempts = RELAX_ADJACENCY_AFTER + candidates.length * 20
  let attempts = 0
  while (chosen.length < count && attempts < maxAttempts) {
    attempts += 1
    const pool =
      chosen.length === 0 && median !== undefined
        ? candidates.filter((c) => c.date !== undefined && c.date <= median)
        : candidates.filter((c) => !chosen.some((s) => s.id === c.id))
    const pick = weightedChoice(pool, weightOf, rng)
    if (pick === undefined) continue
    const dateOk =
      attempts > RELAX_DATE_AFTER ||
      chosen.every((s) => {
        const gap = daysApart(s.date, pick.date)
        return gap === undefined || gap >= MIN_SEED_GAP_DAYS
      })
    const adjacencyOk =
      attempts > RELAX_ADJACENCY_AFTER || chosen.every((s) => !adjacent(s.id, pick.id))
    if (dateOk && adjacencyOk) chosen.push(pick)
  }
  return fillRemainingSeeds(candidates, chosen, weightOf, count)
}

// A bounded, degree-weighted random walk over folded graph state, no
// revisits (dreaming design spec, Selection, step 4: "a bounded random
// walk over folded graph state (default 3 hops, degree-weighted, no
// revisits)"). Among the eligible neighbors at each hop (unvisited,
// present in the graph), a neighbor's odds of being drawn are proportional
// to its own degree in the folded graph, not to how many eligible
// neighbors happen to be unvisited. A reachable neighbor always has degree
// at least 1 (it has the edge that made it reachable), so the all-zero
// fallback in weightedChoice is only ever exercised defensively here.
export function randomWalk(
  graph: GraphState,
  start: string,
  hops: number,
  rng: () => number,
): string[] {
  const adjacency = new Map<string, string[]>()
  for (const edge of graph.edges.values()) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to])
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.from])
  }
  const degreeOf = (id: string) => adjacency.get(id)?.length ?? 0
  const path = [start]
  const visited = new Set([start])
  let current = start
  for (let hop = 0; hop < hops; hop += 1) {
    const next = (adjacency.get(current) ?? []).filter(
      (id) => !visited.has(id) && graph.nodes.has(id),
    )
    if (next.length === 0) break
    const step = weightedChoice(next, degreeOf, rng) as string
    path.push(step)
    visited.add(step)
    current = step
  }
  return path
}
