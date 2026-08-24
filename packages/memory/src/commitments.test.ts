import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readCommitments,
  recordCommitment,
  resolveCommitment,
  reviseCommitment,
} from './commitments.js'
import { appendGraph } from './graph.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'

const tempDirs: string[] = []

async function tempPaths(): Promise<MemoryPaths> {
  const dir = await mkdtemp(join(tmpdir(), 'openreverie-commitments-'))
  tempDirs.push(dir)
  const paths = memoryPaths(dir)
  await ensureMemoryTree(paths)
  return paths
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('commitments', () => {
  it('revises a commitment in place while every version survives in the log', async () => {
    const paths = await tempPaths()
    const created = await recordCommitment(paths, {
      label: 'See Nightfall with Arjun',
      flavor: 'plan',
      sessionId: 'session_01A',
      timing: {
        words: 'friday',
        anchor: '2026-08-18T10:00:00.000Z',
        resolved: { from: '2026-08-21', to: '2026-08-21', statedPrecision: 'day' },
      },
    })

    await reviseCommitment(paths, created.id, {
      timing: {
        words: 'sunday the 23rd',
        anchor: '2026-08-20T10:00:00.000Z',
        resolved: { from: '2026-08-23', to: '2026-08-23', statedPrecision: 'day' },
      },
    })

    const live = await readCommitments(paths)
    expect(live).toHaveLength(1)
    expect(live[0]?.id).toBe(created.id)
    expect(live[0]?.timing?.resolved?.from).toBe('2026-08-23')

    // The superseded version is still in the log, which is the property the
    // four contradictory Nightfall records were missing.
    const raw = await readFile(paths.graphLog, 'utf8')
    expect(raw).toContain('2026-08-21')
    expect(raw).toContain('2026-08-23')
  })

  it('records an outcome without inventing one', async () => {
    const paths = await tempPaths()
    const c = await recordCommitment(paths, {
      label: 'File the tax paperwork',
      flavor: 'errand',
      sessionId: 's1',
    })
    await resolveCommitment(paths, c.id, 'done')
    expect((await readCommitments(paths))[0]?.state).toBe('done')
  })

  it('appends a later interpretation without rewriting the first', async () => {
    const paths = await tempPaths()
    const c = await recordCommitment(paths, {
      label: 'Start swimming',
      flavor: 'plan',
      sessionId: 's1',
      timing: {
        words: 'come summer',
        anchor: '2026-08-24T10:00:00.000Z',
        interpretation: {
          statedPrecision: 'vague',
          gloss: 'Said in August 2026. Summer where they live runs roughly February to May.',
          bracketFrom: '2027-02-01',
          bracketTo: '2027-05-31',
          interpretationConfidence: 'medium',
        },
      },
    })

    await reviseCommitment(paths, c.id, {
      timing: {
        words: 'come summer',
        anchor: '2027-01-15T10:00:00.000Z',
        interpretation: {
          statedPrecision: 'vague',
          gloss: 'Re-read in January 2027, with that summer now weeks away.',
          bracketFrom: '2027-02-01',
          bracketTo: '2027-05-31',
          interpretationConfidence: 'high',
        },
      },
    })

    // Spec section 3: the original gloss is testimony and is never
    // rewritten. What was understood, and when, stays legible in the log.
    const raw = await readFile(paths.graphLog, 'utf8')
    expect(raw).toContain('Said in August 2026')
    expect(raw).toContain('Re-read in January 2027')

    const live = await readCommitments(paths)
    expect(live[0]?.timing?.interpretation?.interpretationConfidence).toBe('high')
  })

  it('never carries both a stated window and an interpreted one', async () => {
    const paths = await tempPaths()
    await expect(
      recordCommitment(paths, {
        label: 'Start swimming',
        flavor: 'plan',
        sessionId: 's1',
        timing: {
          words: 'come summer',
          anchor: '2026-08-24T10:00:00.000Z',
          resolved: { from: '2027-02-01', to: '2027-05-31', statedPrecision: 'range' },
          interpretation: {
            statedPrecision: 'vague',
            gloss: 'anything',
            interpretationConfidence: 'low',
          },
        },
      }),
    ).rejects.toThrow()
  })

  it('readCommitments skips a commitment node once it has been retracted', async () => {
    const paths = await tempPaths()
    const c = await recordCommitment(paths, {
      label: 'Buy a birthday gift',
      flavor: 'errand',
      sessionId: 's1',
    })
    expect(await readCommitments(paths)).toHaveLength(1)

    // No public retract op exists on commitments.ts (none is in scope for
    // this task), so this drives the same foldGraph mechanism readCommitments
    // relies on directly, the way any future retraction call would.
    await appendGraph(paths, [
      {
        ts: new Date().toISOString(),
        op: 'retract',
        node: c.id,
        type: 'commitment',
        label: c.label,
      },
    ])

    expect(await readCommitments(paths)).toHaveLength(0)
  })
})
