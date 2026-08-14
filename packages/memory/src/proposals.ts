// The proposal queue: reflection surfaces candidate graph edges and new
// documents, but nothing enters memory as fact until the human accepts it.
// Proposals and their resolutions are both single-line JSON records in
// proposals.jsonl. Nothing is ever rewritten in place: accepting or
// rejecting a proposal appends a resolution line rather than editing the
// proposal line it refers to.

import { appendFile, readFile } from 'node:fs/promises'
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
  let raw: string
  try {
    raw = await readFile(paths.proposals, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }

  const lines: ProposalLine[] = []
  const rawLines = raw.split('\n')
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

export async function appendProposals(paths: MemoryPaths, proposals: Proposal[]): Promise<void> {
  if (proposals.length === 0) {
    return
  }
  await ensureMemoryTree(paths)
  const text = proposals.map((proposal) => `${JSON.stringify(proposal)}\n`).join('')
  await appendFile(paths.proposals, text, 'utf8')
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
    ts: new Date().toISOString(),
  }
  await appendFile(paths.proposals, `${JSON.stringify(resolutionLine)}\n`, 'utf8')
}
