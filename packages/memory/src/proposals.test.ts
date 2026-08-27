import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newId } from './documents.js'
import { nodeStores } from './nodeStore.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'
import { appendProposals, type Proposal, pendingProposals, resolveProposal } from './proposals.js'

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: newId('prop'),
    ts: new Date().toISOString(),
    kind: 'new_arc',
    summary: 'The user seems to be starting a new project.',
    payload: { name: 'A new arc' },
    source: 'session_test',
    ...overrides,
  }
}

describe('proposals', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-memory-'))
    paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('appends two proposals, both pending in order', async () => {
    const first = makeProposal({ summary: 'First proposal.' })
    const second = makeProposal({ summary: 'Second proposal.' })

    await appendProposals(paths, [first, second], 'UTC')

    const pending = await pendingProposals(paths)
    expect(pending).toHaveLength(2)
    expect(pending[0]?.id).toBe(first.id)
    expect(pending[1]?.id).toBe(second.id)
    expect(pending[0]).toEqual(first)
    expect(pending[1]).toEqual(second)
  })

  it('resolving one leaves only the other pending', async () => {
    const first = makeProposal({ summary: 'First proposal.' })
    const second = makeProposal({ summary: 'Second proposal.' })
    await appendProposals(paths, [first, second], 'UTC')

    await resolveProposal(paths, first.id, 'accepted', new Date())

    const pending = await pendingProposals(paths)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.id).toBe(second.id)
  })

  it('resolving twice is a no-op at the storage level, and the proposal line is never rewritten', async () => {
    const only = makeProposal()
    await appendProposals(paths, [only], 'UTC')

    await resolveProposal(paths, only.id, 'rejected', new Date())
    const pendingAfterFirst = await pendingProposals(paths)
    expect(pendingAfterFirst).toHaveLength(0)

    await resolveProposal(paths, only.id, 'rejected', new Date())
    const pendingAfterSecond = await pendingProposals(paths)
    expect(pendingAfterSecond).toHaveLength(0)

    const raw = await readFile(paths.proposals, 'utf8')
    const lines = raw.split('\n').filter((line) => line.trim().length > 0)
    expect(lines).toHaveLength(2)

    const proposalLine = JSON.parse(lines[0] ?? '')
    expect(proposalLine).toEqual(only)

    const resolutionLine = JSON.parse(lines[1] ?? '')
    expect(resolutionLine.op).toBe('resolve')
    expect(resolutionLine.id).toBe(only.id)
    expect(resolutionLine.resolution).toBe('rejected')
    expect(typeof resolutionLine.ts).toBe('string')
  })

  it('resolving an unknown id throws', async () => {
    await expect(
      resolveProposal(paths, 'prop_does_not_exist', 'accepted', new Date()),
    ).rejects.toThrow()
  })

  it('pendingProposals returns an empty array when no proposals were ever appended', async () => {
    const pending = await pendingProposals(paths)
    expect(pending).toEqual([])
  })

  it('appendProposals with an empty array does not add a line', async () => {
    const before = await pendingProposals(paths)
    await appendProposals(paths, [], 'UTC')
    const after = await pendingProposals(paths)
    expect(after).toEqual(before)
  })
})
