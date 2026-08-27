// The proposal queue: reflection surfaces candidate graph edges and new
// documents, but nothing enters memory as fact until the human accepts it.
// Proposals and their resolutions are both single-line JSON records in
// proposals.jsonl. Nothing is ever rewritten in place: accepting or
// rejecting a proposal appends a resolution line rather than editing the
// proposal line it refers to.

// This module only ever touches paths.logs, never a FileStore directly: the
// proposal queue is a pure append-only log, and staying off FileStore here
// is what lets that property be checked at this file's imports instead of
// by auditing every call site (see store.ts). ensureMemoryTree, imported
// below, does its own FileStore work internally; this module never sees it.
import { ensureMemoryTree, type MemoryPaths } from './paths.js'

export type ProposalKind = 'new_arc' | 'new_person' | 'link'

export interface Proposal {
  id: string // 'prop_<ulid>'
  ts: string
  kind: ProposalKind
  summary: string // one human sentence the agent can say out loud
  payload: Record<string, unknown> // kind-specific, e.g. {name, realm} or an EdgeRecord-shaped link
  source: string // session id
}

export type ProposalResolution = 'accepted' | 'rejected'

interface ResolutionLine {
  op: 'resolve'
  id: string
  resolution: ProposalResolution
  ts: string
}

type ProposalLine = Proposal | ResolutionLine

function isResolutionLine(line: ProposalLine): line is ResolutionLine {
  return 'op' in line && line.op === 'resolve'
}

async function readLines(paths: MemoryPaths): Promise<ProposalLine[]> {
  const rawLines = await paths.logs.readAll(paths.proposals)
  const lines: ProposalLine[] = []
  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i]
    if (rawLine === undefined || rawLine.trim() === '') {
      continue
    }
    try {
      lines.push(JSON.parse(rawLine) as ProposalLine)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Proposal queue ${paths.proposals} line ${i + 1} is not valid JSON: ${message}`,
      )
    }
  }
  return lines
}

export async function appendProposals(
  paths: MemoryPaths,
  proposals: Proposal[],
  timezone: string,
): Promise<void> {
  if (proposals.length === 0) {
    return
  }
  await ensureMemoryTree(paths, timezone)
  const lines = proposals.map((proposal) => JSON.stringify(proposal))
  await paths.logs.appendLines(paths.proposals, lines)
}

export async function pendingProposals(paths: MemoryPaths): Promise<Proposal[]> {
  const lines = await readLines(paths)
  const proposalsInOrder: Proposal[] = []
  const resolvedIds = new Set<string>()

  for (const line of lines) {
    if (isResolutionLine(line)) {
      resolvedIds.add(line.id)
    } else {
      proposalsInOrder.push(line)
    }
  }

  return proposalsInOrder.filter((proposal) => !resolvedIds.has(proposal.id))
}

export async function resolveProposal(
  paths: MemoryPaths,
  id: string,
  resolution: ProposalResolution,
  now: Date,
): Promise<void> {
  const lines = await readLines(paths)
  const proposalExists = lines.some((line) => !isResolutionLine(line) && line.id === id)
  if (!proposalExists) {
    throw new Error(`No proposal with id ${id} found in ${paths.proposals}.`)
  }

  const alreadyResolved = lines.some((line) => isResolutionLine(line) && line.id === id)
  if (alreadyResolved) {
    return
  }

  // No ensureMemoryTree call here: readLines above already succeeded, which
  // means the proposal queue file (and therefore the memory tree) exists.
  const resolutionLine: ResolutionLine = {
    op: 'resolve',
    id,
    resolution,
    ts: now.toISOString(),
  }
  await paths.logs.appendLines(paths.proposals, [JSON.stringify(resolutionLine)])
}
