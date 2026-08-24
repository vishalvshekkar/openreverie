import { describe, expect, it } from 'vitest'
import {
  candidateWeight,
  type DreamCandidate,
  fillRemainingSeeds,
  mulberry32,
  pickSeeds,
  randomWalk,
} from './dreamSelection.js'
import type { GraphState } from './graph.js'

const NOW = new Date('2026-08-24T12:00:00.000Z')

function candidate(id: string, date?: string, degree = 0): DreamCandidate {
  return { id, label: id, kind: 'node', ...(date ? { date } : {}), degree }
}

describe('mulberry32', () => {
  it('is deterministic per seed and in [0, 1)', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const runA = [a(), a(), a()]
    expect(runA).toEqual([b(), b(), b()])
    for (const v of runA) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
    expect(mulberry32(43)()).not.toBe(mulberry32(42)())
  })
})

describe('candidateWeight', () => {
  it('an undreamt old entity outweighs a freshly dreamt recent one', () => {
    const old = candidate('arc_old', '2024-01-01', 3)
    const fresh = candidate('arc_fresh', '2026-08-20', 3)
    const lastDreamt = new Map([['arc_fresh', '2026-08-23T00:00:00.000Z']])
    expect(candidateWeight(old, lastDreamt, NOW)).toBeGreaterThan(
      candidateWeight(fresh, lastDreamt, NOW),
    )
  })
  it('last-dreamt time supersedes the entity date for staleness', () => {
    const c = candidate('arc_x', '2024-01-01', 1)
    const undreamt = candidateWeight(c, new Map(), NOW)
    const justDreamt = candidateWeight(c, new Map([['arc_x', '2026-08-23T00:00:00.000Z']]), NOW)
    expect(undreamt).toBeGreaterThan(justDreamt)
  })
})

describe('pickSeeds', () => {
  const pool = [
    candidate('a', '2024-01-10', 5),
    candidate('b', '2024-02-10', 4),
    candidate('c', '2026-07-01', 3),
    candidate('d', '2026-08-01', 2),
    candidate('e', '2026-08-10', 1),
    candidate('f', '2025-05-05', 2),
  ]
  const never = () => false

  it('is reproducible for a fixed rng seed and returns distinct, date-distant seeds', () => {
    const args = {
      candidates: pool,
      lastDreamt: new Map<string, string>(),
      now: NOW,
      adjacent: never,
      count: 3,
    }
    const firstRun = pickSeeds({ ...args, rng: mulberry32(7) })
    const secondRun = pickSeeds({ ...args, rng: mulberry32(7) })
    const first = firstRun.map((s) => s.id)
    const second = secondRun.map((s) => s.id)
    expect(first).toEqual(second)
    expect(new Set(first).size).toBe(3)
    for (let i = 0; i < firstRun.length; i += 1) {
      for (let j = i + 1; j < firstRun.length; j += 1) {
        const a = firstRun[i]?.date
        const b = firstRun[j]?.date
        const gapDays = Math.abs(Date.parse(a as string) - Date.parse(b as string)) / 86_400_000
        expect(gapDays).toBeGreaterThanOrEqual(60)
      }
    }
  })

  // Ruling C3: the pool sorts to a, b, f, c, d, e by date, so the median
  // (index floor(6/2) = 3) is c's date, 2026-07-01. The reserved pool for
  // the first slot is every candidate with date <= that median: a, b, f,
  // and c itself, not the a/b/f the original brief asserted. pickSeeds
  // restricts the pool for the *first* pick to that reserved set and only
  // that pick, so the invariant that actually holds is "the first seed
  // returned comes from the reserved older-half pool," checked directly
  // against seeds[0] rather than "some seed is in a subset of it."
  it('reserves the first slot for a candidate from the older-half pool (median-inclusive)', () => {
    // Degree is pumped up on the newer candidates so their significance
    // term can outweigh the older candidates' staleness term. Without the
    // explicit reservation, this rng seed draws a newer candidate (d) for
    // the first slot purely on weight, which is exactly what the
    // reservation must prevent: the first slot is restricted to the pool
    // no newer than the median date, {a, b, f, c}, before any weighted
    // draw happens.
    const heavy = [
      candidate('a', '2024-01-10', 0),
      candidate('b', '2024-02-10', 0),
      candidate('c', '2026-07-01', 0),
      candidate('d', '2026-08-01', 1_000_000),
      candidate('e', '2026-08-10', 1_000_000),
      candidate('f', '2025-05-05', 0),
    ]
    const seeds = pickSeeds({
      candidates: heavy,
      lastDreamt: new Map(),
      now: NOW,
      rng: mulberry32(1),
      adjacent: never,
      count: 3,
    })
    const reservedOldHalf = new Set(['a', 'b', 'f', 'c'])
    expect(reservedOldHalf.has(seeds[0]?.id as string)).toBe(true)
  })

  // Ruling C4, reshaped per coordinator ruling: pickSeeds carries two
  // routes to the same guarantee, a constrained loop that relaxes the
  // adjacency and date rules progressively, and a final backstop
  // (fillRemainingSeeds) that fills any slot the loop did not. Tasks 7 and
  // 9 depend on the observable outcome, not on which route produced it:
  // given a pool larger than count where every candidate is mutually
  // adjacent, pickSeeds still returns count distinct seeds. That is what
  // this test holds. Known limitation, accepted and recorded rather than
  // solved here: because both routes exist, this test alone cannot
  // distinguish "the loop relaxed adjacency" from "the backstop filled the
  // gap"; falsifying the loop's relaxation in isolation requires also
  // disabling the backstop, and fillRemainingSeeds is falsified directly,
  // on its own, in the describe block below.
  it('returns count distinct seeds even when every candidate in a larger pool is mutually adjacent', () => {
    const trio = [
      candidate('p', '2024-01-01', 1),
      candidate('q', '2024-08-01', 1),
      candidate('r', '2025-06-01', 1),
    ]
    const always = () => true
    const seeds = pickSeeds({
      candidates: trio,
      lastDreamt: new Map(),
      now: NOW,
      rng: mulberry32(3),
      adjacent: always,
      count: 2,
    })
    expect(seeds.length).toBe(2)
    expect(new Set(seeds.map((s) => s.id)).size).toBe(2)
  })
})

// fillRemainingSeeds is pickSeeds's post-loop backstop, restored per
// coordinator ruling as the spec's "constraints relaxed progressively if
// the pool is too small to satisfy it" guarantee. Tested directly here,
// not only through pickSeeds end to end, since pickSeeds's own attempt
// budget is sized so the constrained loop always fills every slot itself
// for a well-formed call (count < candidates.length): once
// attempts > RELAX_ADJACENCY_AFTER, every remaining attempt succeeds
// unconditionally, and there are always more such attempts available than
// slots left to fill. That makes the backstop unreachable through
// pickSeeds's public behavior for any valid input, so it is exercised as
// a unit instead.
describe('fillRemainingSeeds', () => {
  it('fills remaining slots with the highest-weight leftovers not already chosen', () => {
    const candidates = [candidate('a'), candidate('b'), candidate('c'), candidate('d')]
    const chosen = [candidates[0] as DreamCandidate]
    const weightById: Record<string, number> = { a: 0, b: 3, c: 1, d: 2 }
    const weightOf = (c: DreamCandidate) => weightById[c.id] ?? 0
    const result = fillRemainingSeeds(candidates, chosen, weightOf, 3)
    expect(result.map((s) => s.id)).toEqual(['a', 'b', 'd'])
  })

  it('is a no-op once chosen already has count seeds', () => {
    const candidates = [candidate('a'), candidate('b')]
    const chosen = [candidates[0] as DreamCandidate, candidates[1] as DreamCandidate]
    const result = fillRemainingSeeds(candidates, chosen, () => 0, 2)
    expect(result).toBe(chosen)
  })
})

describe('randomWalk', () => {
  it('stays within hop bound and never revisits', () => {
    const graph: GraphState = {
      nodes: new Map(
        ['n1', 'n2', 'n3', 'n4'].map((id) => [
          id,
          { id, type: 'entity' as const, label: id, ts: '2026-01-01T00:00:00.000Z' },
        ]),
      ),
      edges: new Map([
        [
          'relates_to:n1:n2',
          {
            edge: 'relates_to' as const,
            from: 'n1',
            to: 'n2',
            confidence: 1,
            confirmed: true,
            ts: '2026-01-01T00:00:00.000Z',
          },
        ],
        [
          'relates_to:n2:n3',
          {
            edge: 'relates_to' as const,
            from: 'n2',
            to: 'n3',
            confidence: 1,
            confirmed: true,
            ts: '2026-01-01T00:00:00.000Z',
          },
        ],
        [
          'relates_to:n3:n1',
          {
            edge: 'relates_to' as const,
            from: 'n3',
            to: 'n1',
            confidence: 1,
            confirmed: true,
            ts: '2026-01-01T00:00:00.000Z',
          },
        ],
      ]),
    }
    const path = randomWalk(graph, 'n1', 3, mulberry32(5))
    expect(path[0]).toBe('n1')
    expect(path.length).toBeLessThanOrEqual(4)
    expect(new Set(path).size).toBe(path.length)
    expect(path).not.toContain('n4')
  })

  // Fix 1 (coordinator ruling): the spec calls this walk degree-weighted
  // (Selection, step 4). hub has two eligible neighbors at the first hop:
  // busy, whose own degree is 5 (one edge back to hub plus four more to
  // its own neighbors), and quiet, whose degree is 1 (only the edge back
  // to hub). A degree-weighted draw favors busy roughly 5-to-1 over many
  // seeds; a uniform draw would land close to 50/50. The assertion sets
  // its threshold well inside that gap so it holds under weighting and
  // fails under uniform, rather than merely leaning the right direction.
  it('favors higher-degree neighbors over many seeded draws', () => {
    const nodeIds = ['hub', 'busy', 'quiet', 'busy2', 'busy3', 'busy4', 'busy5']
    const graph: GraphState = {
      nodes: new Map(
        nodeIds.map((id) => [
          id,
          { id, type: 'entity' as const, label: id, ts: '2026-01-01T00:00:00.000Z' },
        ]),
      ),
      edges: new Map(
        [
          ['hub', 'busy'],
          ['hub', 'quiet'],
          ['busy', 'busy2'],
          ['busy', 'busy3'],
          ['busy', 'busy4'],
          ['busy', 'busy5'],
        ].map(([from, to]) => [
          `relates_to:${from}:${to}`,
          {
            edge: 'relates_to' as const,
            from: from as string,
            to: to as string,
            confidence: 1,
            confirmed: true,
            ts: '2026-01-01T00:00:00.000Z',
          },
        ]),
      ),
    }
    const runs = 100
    let busyCount = 0
    let quietCount = 0
    for (let seed = 1; seed <= runs; seed += 1) {
      const step = randomWalk(graph, 'hub', 1, mulberry32(seed))[1]
      if (step === 'busy') busyCount += 1
      if (step === 'quiet') quietCount += 1
    }
    expect(busyCount + quietCount).toBe(runs)
    expect(busyCount).toBeGreaterThan(runs * 0.65)
    expect(busyCount).toBeGreaterThan(quietCount)
  })
})
