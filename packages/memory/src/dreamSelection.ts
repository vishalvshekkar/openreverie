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

function weightedPick(
  pool: DreamCandidate[],
  weightOf: (c: DreamCandidate) => number,
  rng: () => number,
): DreamCandidate | undefined {
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

// Picks two or three seeds by weight, pushed apart so a dream connects
// distant things rather than rehashing this week (dreaming design spec,
// Selection). Constraints relax progressively when the pool is too small
// to satisfy them: the date-gap rule drops after 20 failed draws, the
// adjacency rule after 40. The first slot is reserved for a candidate no
// newer than the median candidate date, so every dream reaches back.
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
    const pick = weightedPick(pool, weightOf, rng)
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
  return chosen
}

// A bounded random walk over folded graph state, no revisits (dreaming
// design spec, Selection, step 4). The spec describes this walk as
// degree-weighted; the task brief this module follows specifies a uniform
// draw among unvisited neighbors instead, and that is what is implemented
// here. Recorded as a spec-vs-brief divergence for review, not resolved
// silently (see task-5-report.md).
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
  const path = [start]
  const visited = new Set([start])
  let current = start
  for (let hop = 0; hop < hops; hop += 1) {
    const next = (adjacency.get(current) ?? []).filter(
      (id) => !visited.has(id) && graph.nodes.has(id),
    )
    if (next.length === 0) break
    const step = next[Math.floor(rng() * next.length)] as string
    path.push(step)
    visited.add(step)
    current = step
  }
  return path
}
