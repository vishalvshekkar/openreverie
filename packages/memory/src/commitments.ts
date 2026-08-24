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
