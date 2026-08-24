// The commitment record: the one place identity replaces the append-only
// item log for things with a lifecycle (errands, plans). An item is a fact
// and can only ever be appended. A commitment is a thing, and a thing can
// be revised. That distinction is the entire argument for this feature: the
// dogfooding memory folder currently holds four contradictory item records
// of one cinema booking, and nothing marks three of them dead.
//
// "Revised" does not mean the log is edited. graph.jsonl stays append-only,
// exactly as it always has: appendGraph only ever appends. Revision here
// means reasserting the SAME node id. foldGraph (graph.ts) already treats a
// later assert of an id as replacing the earlier one in current state,
// while every prior version stays on disk, readable, forever. That is the
// whole mechanism: one live row per commitment, and history never
// destroyed. readCommitments below does nothing more than fold the log and
// read off that current state.

import { newId } from './documents.js'
import {
  appendGraph,
  type CommitmentFlavor,
  type CommitmentPayload,
  type CommitmentState,
  type CommitmentTiming,
  commitmentPayloadSchema,
  readGraph,
} from './graph.js'
import type { MemoryPaths } from './paths.js'

export type { CommitmentFlavor, CommitmentState, CommitmentTiming }

export interface Commitment {
  id: string
  label: string
  flavor: CommitmentFlavor
  state: CommitmentState
  timing?: CommitmentTiming
  waitsOn?: string
  askedAt?: string
  sessionId: string
}

export interface RecordCommitmentInput {
  label: string
  flavor: CommitmentFlavor
  sessionId: string
  timing?: CommitmentTiming
  waitsOn?: string
  askedAt?: string
}

export interface ReviseCommitmentInput {
  label?: string
  flavor?: CommitmentFlavor
  timing?: CommitmentTiming
  waitsOn?: string
  askedAt?: string
}

function toCommitment(id: string, label: string, payload: CommitmentPayload): Commitment {
  return { id, label, ...payload }
}

// Validates before anything reaches the log, and with a message that names
// the actual problem (see commitmentPayloadSchema in graph.ts) rather than
// leaving appendGraph's own re-validation as the only guard. appendGraph
// still re-checks independently, which is deliberate: every writer of
// graph.jsonl goes through that same gate, not only this one.
async function appendCommitmentNode(
  paths: MemoryPaths,
  id: string,
  label: string,
  payload: CommitmentPayload,
): Promise<void> {
  commitmentPayloadSchema.parse(payload)
  await appendGraph(paths, [
    {
      ts: new Date().toISOString(),
      op: 'assert',
      node: id,
      type: 'commitment',
      label,
      commitment: payload,
    },
  ])
}

async function liveCommitment(paths: MemoryPaths, id: string): Promise<Commitment> {
  const commitments = await readCommitments(paths)
  const found = commitments.find((commitment) => commitment.id === id)
  if (!found) {
    throw new Error(`No live commitment with id ${id} in ${paths.graphLog}.`)
  }
  return found
}

export async function recordCommitment(
  paths: MemoryPaths,
  input: RecordCommitmentInput,
): Promise<Commitment> {
  const id = newId('commitment')
  const payload: CommitmentPayload = {
    flavor: input.flavor,
    state: 'open',
    sessionId: input.sessionId,
    ...(input.timing !== undefined ? { timing: input.timing } : {}),
    ...(input.waitsOn !== undefined ? { waitsOn: input.waitsOn } : {}),
    ...(input.askedAt !== undefined ? { askedAt: input.askedAt } : {}),
  }

  await appendCommitmentNode(paths, id, input.label, payload)
  return toCommitment(id, input.label, payload)
}

// Reasserts the same node id with the updated fields. Any field left out of
// changes carries forward from the current live version rather than being
// dropped, so a revision that only touches timing does not silently erase
// waitsOn or askedAt.
export async function reviseCommitment(
  paths: MemoryPaths,
  id: string,
  changes: ReviseCommitmentInput,
): Promise<Commitment> {
  const current = await liveCommitment(paths, id)
  const label = changes.label ?? current.label
  const payload: CommitmentPayload = {
    flavor: changes.flavor ?? current.flavor,
    state: current.state,
    sessionId: current.sessionId,
    ...resolveField(changes.timing, current.timing, 'timing'),
    ...resolveField(changes.waitsOn, current.waitsOn, 'waitsOn'),
    ...resolveField(changes.askedAt, current.askedAt, 'askedAt'),
  }

  await appendCommitmentNode(paths, id, label, payload)
  return toCommitment(id, label, payload)
}

function resolveField<K extends string, V>(
  incoming: V | undefined,
  existing: V | undefined,
  key: K,
): Partial<Record<K, V>> {
  const value = incoming !== undefined ? incoming : existing
  return value !== undefined ? ({ [key]: value } as Partial<Record<K, V>>) : {}
}

// Records an outcome the caller already knows, nothing more: this function
// invents no state on its own, it only appends the one the caller passed.
export async function resolveCommitment(
  paths: MemoryPaths,
  id: string,
  state: CommitmentState,
): Promise<Commitment> {
  const current = await liveCommitment(paths, id)
  const payload: CommitmentPayload = {
    flavor: current.flavor,
    state,
    sessionId: current.sessionId,
    ...(current.timing !== undefined ? { timing: current.timing } : {}),
    ...(current.waitsOn !== undefined ? { waitsOn: current.waitsOn } : {}),
    ...(current.askedAt !== undefined ? { askedAt: current.askedAt } : {}),
  }

  await appendCommitmentNode(paths, id, current.label, payload)
  return toCommitment(id, current.label, payload)
}

// Folds the graph log and reads off current state: the latest version of
// every commitment node, with retracted ones already gone because
// foldGraph's node retract deletes them from the map it builds.
export async function readCommitments(paths: MemoryPaths): Promise<Commitment[]> {
  const state = await readGraph(paths)
  const commitments: Commitment[] = []
  for (const node of state.nodes.values()) {
    if (node.type !== 'commitment' || node.commitment === undefined) {
      continue
    }
    commitments.push(toCommitment(node.id, node.label, node.commitment))
  }
  return commitments
}

// The precision the person actually spoke at. Both timing branches carry a
// statedPrecision field (see the CommitmentTiming comment in graph.ts and
// the controller ruling in Task 3): 'day' and 'range' on a resolved window,
// 'period' and 'vague' on an interpretation. Selection reads off this one
// field regardless of which branch produced it, never off
// interpretationConfidence, which answers a different question (how sure
// OUR reading is, not how precisely THEY spoke).
type StatedPrecision = 'day' | 'range' | 'period' | 'vague'

// Days of lead time before a window opens that a commitment becomes
// eligible to enter the prompt. Spec Section 4: lead time scales with
// vagueness, so something mentioned loosely gets an early, low-pressure
// mention rather than a punctual one. Named constants, not inline numbers,
// so a future reader can see these were chosen and why, and can change one
// without hunting for every place a magic number might be hiding.
//
// DAY: the person named a day. Surfacing it a week early is exactly the
// taskmaster behavior Section 6 rules out ("did you end up going" asked the
// day before a dated commitment). Zero lead, by definition.
const LEAD_DAYS_DAY = 0
// RANGE: a stated window whose far edge is soft ("by Friday", "before
// month end"). A few days' notice reads as natural, not punctual.
const LEAD_DAYS_RANGE = 3
// PERIOD: a named span the person spoke with enough shape to gloss
// confidently, the spec's own "come summer" example. Kept at the brief's
// suggested 30 days, deliberately: a period's bracket is still a guess
// (Section 3, "our bracket for it may be quite good", not certain), and 30
// days is enough room for one natural, unhurried mention before the
// bracket opens without assuming more confidence in that guess than is
// warranted. Revisit downward only if real use shows this reads as too
// early for a commitment whose span is well understood.
const LEAD_DAYS_PERIOD = 30
// VAGUE: looser stated speech than a named span ("sometime this year",
// "someday"). bracketFrom/bracketTo are optional on the schema regardless
// of statedPrecision, so this branch is reachable, not theoretical: a gloss
// for "sometime this year" can still carry a coarse, low-confidence bracket
// even though the person's own words gave it nothing as shaped as a
// season. Given a weaker anchor than PERIOD, it gets more lead rather than
// the same number: 45 days, so the one natural mention lands early and
// gently rather than close to a range that is itself a rough guess. When
// there is no bracket at all ("someday" with nothing to bound even
// loosely), windowStart returns undefined and this constant is never
// consulted; see isTimeEligible below.
const LEAD_DAYS_VAGUE = 45

const LEAD_DAYS_BY_STATED_PRECISION: Record<StatedPrecision, number> = {
  day: LEAD_DAYS_DAY,
  range: LEAD_DAYS_RANGE,
  period: LEAD_DAYS_PERIOD,
  vague: LEAD_DAYS_VAGUE,
}

// Plain calendar arithmetic on YYYY-MM-DD strings. No timezone parameter:
// every date this function ever sees (today, and every window edge stored
// on a commitment) is already a local calendar day, not an instant, so
// there is nothing to convert.
function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days))
  const y = String(shifted.getUTCFullYear()).padStart(4, '0')
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// The window start and its statedPrecision, read off whichever timing
// branch is present. Returns undefined when there is no bracket to read at
// all: an interpretation whose gloss carries no bracketFrom (the honest
// representation of speech too vague to bound even loosely).
function windowStart(
  timing: CommitmentTiming,
): { from: string; statedPrecision: StatedPrecision } | undefined {
  if (timing.resolved !== undefined) {
    return { from: timing.resolved.from, statedPrecision: timing.resolved.statedPrecision }
  }
  if (timing.interpretation?.bracketFrom !== undefined) {
    return {
      from: timing.interpretation.bracketFrom,
      statedPrecision: timing.interpretation.statedPrecision,
    }
  }
  return undefined
}

// Whether a commitment's own timing puts it in the eligible window, given
// its lead time. A commitment with no computable window (timing absent
// entirely, or an interpretation with no bracket at all) has nothing for
// the calendar to gate on, so this returns true rather than false: spec
// Section 3's "never by the calendar" for open-ended commitments is
// honored by never inventing a bracket for them, not by hiding them here.
// The event-anchored case (waitsOn set, no timing at all, per spec Section
// 5) is excluded by the dedicated waitsOn check in selectCommitments, not
// by this function.
//
// Deliberately no upper bound: once eligible, a commitment stays eligible
// past its window closing. Spec Section 6 requires exactly this ("did you
// end up going" is a valid one-time follow-up after the date has passed
// with no outcome recorded). No computed state marks the commitment as late,
// so there is nothing to bind an upper bound to.
function isTimeEligible(timing: CommitmentTiming | undefined, today: string): boolean {
  if (timing === undefined) return true
  const start = windowStart(timing)
  if (start === undefined) return true
  const lead = LEAD_DAYS_BY_STATED_PRECISION[start.statedPrecision]
  const eligibleFrom = shiftDate(start.from, -lead)
  return today >= eligibleFrom
}

// Selects which commitments are worth surfacing today, capped like every
// other prompt section in this codebase (spec Section 4). Three checks
// here are not implementation detail, they are the anti-taskmaster
// guarantees from spec Section 6 and each is load-bearing on its own:
// askedAt (one ask, then permanent silence), quiet (honored permanently,
// no exceptions for timing), and waitsOn (never surfaced by time at all,
// only once the awaited thing is recorded as having happened).
export function selectCommitments(all: Commitment[], today: string, cap: number): Commitment[] {
  const eligible = all.filter((commitment) => {
    if (commitment.state === 'quiet') return false
    if (commitment.askedAt !== undefined) return false
    if (commitment.waitsOn !== undefined) return false
    return isTimeEligible(commitment.timing, today)
  })

  // Soonest window first, so a cap that trims the list keeps the
  // commitments closest to needing a mention. Commitments with no
  // computable window sort last: there is no date to rank them by.
  const sorted = [...eligible].sort((a, b) => {
    const aStart = a.timing !== undefined ? windowStart(a.timing)?.from : undefined
    const bStart = b.timing !== undefined ? windowStart(b.timing)?.from : undefined
    if (aStart === undefined && bStart === undefined) return 0
    if (aStart === undefined) return 1
    if (bStart === undefined) return -1
    return aStart < bStart ? -1 : aStart > bStart ? 1 : 0
  })

  return sorted.slice(0, cap)
}
