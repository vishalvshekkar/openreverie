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
  // Important 6: omitting `timing` here means "carry the current one
  // forward" (see resolveField below), so there was previously no way to
  // clear a stale stated time with nothing to replace it. Setting this
  // instead of `timing` drops it. Ignored if `timing` is also set: a
  // fresh timing is a replacement, not a clearing.
  clearTiming?: boolean
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
  // Important 6: clearTiming is the one explicit way to drop timing
  // instead of carrying the current one forward. It only takes effect
  // when no fresh timing was given on the same call; a fresh timing is a
  // replacement, and wins.
  const dropTiming = changes.clearTiming === true && changes.timing === undefined
  const payload: CommitmentPayload = {
    flavor: changes.flavor ?? current.flavor,
    state: current.state,
    sessionId: current.sessionId,
    ...(dropTiming ? {} : resolveField(changes.timing, current.timing, 'timing')),
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

// The window's far edge, read off whichever timing branch is present.
// resolved.to is always there alongside resolved.from. On the
// interpretation branch bracketTo is optional even when bracketFrom is
// present (a model can gloss a start without a stop), so a bracket with
// no end falls back to treating its start as a single-day point window
// rather than leaving the window open-ended, which is exactly the
// unbounded shape the grace period below exists to close off. Returns
// undefined only when windowStart itself would: nothing to bound at all.
function windowEnd(timing: CommitmentTiming): string | undefined {
  if (timing.resolved !== undefined) {
    return timing.resolved.to
  }
  if (timing.interpretation?.bracketFrom !== undefined) {
    return timing.interpretation.bracketTo ?? timing.interpretation.bracketFrom
  }
  return undefined
}

// Days a commitment stays eligible after its window closes with no
// recorded outcome, before it goes quiet on its own. This is an interim
// anti-nag guard standing in for spec Section 6's own mechanism ("Asking
// it sets askedAt. It is never raised again and resolves to unknown."):
// nothing in this codebase yet lets a live session signal that the
// companion actually raised a commitment, so there is no honest way to
// set askedAt today (see BACKLOG.md for the real mechanism, deferred).
// Bounding time eligibility is not the spec's design, it is a stand-in
// that gets most of the same anti-taskmaster effect (a passed-window
// commitment stops surfacing on its own) without inventing a fake
// askedAt. Chosen to cover roughly one to two sessions of calendar time
// for someone who talks weekly, no more: long enough that a person who
// checks in every week or two still gets the one natural follow-up, short
// enough that it cannot read as nagging months later.
const ASK_GRACE_DAYS = 14

// Whether a commitment's own timing puts it in the eligible window, given
// its lead time before the window opens and its grace period after the
// window closes. A commitment with no computable window at all (timing
// absent entirely, or an interpretation with no bracket at all) has
// nothing for the calendar to gate on, so it is never eligible through
// this standing, always-rendered section: spec Section 4 defines
// eligibility positively ("today falls within its bracket, or within a
// lead time before it"), which an unbounded commitment can never satisfy.
// Spec Section 3 says that case should be "surfaced only when the
// conversation touches the subject, never by the calendar", but no such
// channel exists yet: nothing indexes commitments for search or tool
// lookup (see BACKLOG.md). An untimed commitment stays invisible to the
// live companion; reflection still sees it, uncapped, at session end, so
// it remains revisable and resolvable there. A live-tool commitment
// with an unresolvable stated time and no gloss yet (buildCommitmentTiming
// in engine.ts, the refused branch) is therefore not eligible until
// reflection glosses it at session end; that is correct, not a gap, since
// reflection is what attaches the bracket this function reads.
// The event-anchored case (waitsOn set, no timing at all, per spec Section
// 5) is excluded by the dedicated waitsOn check in selectCommitments, not
// by this function.
function isTimeEligible(timing: CommitmentTiming | undefined, today: string): boolean {
  if (timing === undefined) return false
  const start = windowStart(timing)
  if (start === undefined) return false
  const lead = LEAD_DAYS_BY_STATED_PRECISION[start.statedPrecision]
  const eligibleFrom = shiftDate(start.from, -lead)
  const end = windowEnd(timing) ?? start.from
  const eligibleUntil = shiftDate(end, ASK_GRACE_DAYS)
  return today >= eligibleFrom && today <= eligibleUntil
}

// Selects which commitments are worth surfacing today, capped like every
// other prompt section in this codebase (spec Section 4). The state check
// is an ALLOW-LIST, not a deny-list, and that is deliberate, not
// stylistic: a deny-list here (excluding only 'quiet') is exactly the bug
// that shipped. It excluded the one state someone thought to name at the
// time and silently admitted every state added since, including 'done'
// and 'dropped', so a commitment the model had already resolved kept
// loading into the prompt forever, under a header saying it is never
// evidence the person did it. Only 'open' is ever eligible. Do not
// convert this back to a deny-list: a sixth state added later must
// default to not-surfaced, not surfaced.
//
// The other two checks are also not implementation detail: they are the
// remaining anti-taskmaster guarantees from spec Section 6, each
// load-bearing on its own: askedAt (one ask, then permanent silence,
// though nothing yet writes askedAt in production, see BACKLOG.md) and
// waitsOn (never surfaced by time at all, only once the awaited thing is
// recorded as having happened).
export function selectCommitments(all: Commitment[], today: string, cap: number): Commitment[] {
  const eligible = all.filter((commitment) => {
    if (commitment.state !== 'open') return false
    if (commitment.askedAt !== undefined) return false
    if (commitment.waitsOn !== undefined) return false
    return isTimeEligible(commitment.timing, today)
  })

  // Soonest window first, so a cap that trims the list keeps the
  // commitments closest to needing a mention. The undefined-handling
  // branches below are defensive, not reachable through this function
  // today: isTimeEligible (Important 8) already requires a computable
  // windowStart to pass the filter above, so every commitment reaching
  // this comparator has one. Left in rather than removed, both because a
  // sort comparator that silently assumes its input shape is exactly the
  // kind of implicit invariant this codebase avoids, and because a future
  // change to the filter above should not have to remember to restore
  // this handling.
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
