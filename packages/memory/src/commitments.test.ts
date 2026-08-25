import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readCommitments,
  recordCommitment,
  resolveCommitment,
  reviseCommitment,
  selectCommitments,
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

describe('selectCommitments', () => {
  const base = {
    id: 'c1',
    label: 'x',
    flavor: 'plan' as const,
    state: 'open' as const,
    sessionId: 's1',
  }

  it('surfaces a day-precision commitment on its day, not a week early', () => {
    const c = {
      ...base,
      timing: {
        words: 'sunday',
        anchor: '2026-08-22T00:00:00.000Z',
        resolved: { from: '2026-08-30', to: '2026-08-30', statedPrecision: 'day' as const },
      },
    }
    expect(selectCommitments([c], '2026-08-23', 5)).toHaveLength(0)
    expect(selectCommitments([c], '2026-08-30', 5)).toHaveLength(1)
  })

  // The brief's draft of this test carried an interpretation shaped before
  // Task 3's ruling that split statedPrecision from interpretationConfidence
  // (see commitments.ts / graph.ts CommitmentInterpretation). Corrected here
  // to the real shape, title kept verbatim from the brief: 'come summer'
  // names a season, which is the 'period' example in
  // CommitmentInterpretation's own doc comment ('period' for a named span
  // such as a season, 'vague' for anything looser), and the confidence
  // field is interpretationConfidence, not confidence.
  it('surfaces a vague seasonal commitment weeks ahead of its bracket', () => {
    const c = {
      ...base,
      timing: {
        words: 'come summer',
        anchor: '2026-08-24T00:00:00.000Z',
        interpretation: {
          statedPrecision: 'period' as const,
          gloss: 'Summer in Bangalore runs roughly February to May.',
          bracketFrom: '2027-02-01',
          bracketTo: '2027-05-31',
          interpretationConfidence: 'medium' as const,
        },
      },
    }
    expect(selectCommitments([c], '2027-01-10', 5)).toHaveLength(1)
  })

  it('never surfaces a commitment that has already been asked about once', () => {
    const c = {
      ...base,
      askedAt: '2026-08-31',
      timing: {
        words: 'sunday',
        anchor: '2026-08-22T00:00:00.000Z',
        resolved: { from: '2026-08-30', to: '2026-08-30', statedPrecision: 'day' as const },
      },
    }
    expect(selectCommitments([c], '2026-08-30', 5)).toHaveLength(0)
  })

  it('never surfaces a quiet commitment, whatever its timing', () => {
    const c = {
      ...base,
      state: 'quiet' as const,
      timing: {
        words: 'sunday',
        anchor: '2026-08-22T00:00:00.000Z',
        resolved: { from: '2026-08-30', to: '2026-08-30', statedPrecision: 'day' as const },
      },
    }
    expect(selectCommitments([c], '2026-08-30', 5)).toHaveLength(0)
  })

  it('never surfaces a commitment waiting on something, whatever its timing', () => {
    // Carries an otherwise-eligible timing so this test actually exercises
    // the waitsOn check: with no timing at all the commitment would be
    // excluded anyway (untimed commitments are never time-eligible, see
    // the untimed tests below), which would make this pass for the wrong
    // reason.
    const c = {
      ...base,
      waitsOn: 'entity_01WEDDING',
      timing: {
        words: 'sunday',
        anchor: '2026-08-22T00:00:00.000Z',
        resolved: { from: '2026-08-30', to: '2026-08-30', statedPrecision: 'day' as const },
      },
    }
    expect(selectCommitments([c], '2026-08-30', 5)).toHaveLength(0)
  })

  it('never surfaces a resolved commitment, done or dropped, whatever its timing', () => {
    // Critical 1: selectCommitments must allow-list 'open' rather than
    // deny-list a fixed set of excluded states, so a commitment the model
    // has already resolved does not keep loading into the prompt forever.
    const timing = {
      words: 'sunday',
      anchor: '2026-08-22T00:00:00.000Z',
      resolved: { from: '2026-08-23', to: '2026-08-23', statedPrecision: 'day' as const },
    }
    const done = { ...base, state: 'done' as const, timing }
    const dropped = { ...base, state: 'dropped' as const, timing }
    const unknown = { ...base, state: 'unknown' as const, timing }
    expect(selectCommitments([done], '2026-08-23', 5)).toHaveLength(0)
    expect(selectCommitments([dropped], '2026-08-23', 5)).toHaveLength(0)
    expect(selectCommitments([unknown], '2026-08-23', 5)).toHaveLength(0)
  })

  it('never surfaces a commitment with no timing at all, or an interpretation with no bracket', () => {
    // Important 8 / spec Section 4: eligibility is defined positively as
    // "today falls within its bracket, or within a lead time before it".
    // An untimed commitment has no bracket and can never satisfy that, so
    // it never reaches this always-on standing section. It still reaches
    // the model through search, which is unaffected by selectCommitments.
    const untimed = { ...base }
    const noBracket = {
      ...base,
      timing: {
        words: 'someday',
        anchor: '2026-08-22T00:00:00.000Z',
        interpretation: {
          statedPrecision: 'vague' as const,
          gloss: 'No particular time given.',
          interpretationConfidence: 'low' as const,
        },
      },
    }
    expect(selectCommitments([untimed], '2026-08-30', 5)).toHaveLength(0)
    expect(selectCommitments([noBracket], '2026-08-30', 5)).toHaveLength(0)
  })

  it('goes quiet on its own after the grace period, and stays eligible up to its last day', () => {
    // Ruling 10: the interim bound standing in for askedAt/unknown. The
    // window closes 2026-08-23; ASK_GRACE_DAYS (14) makes 2026-09-06 the
    // last eligible day and 2026-09-07 the first day it is no longer
    // surfaced through this section, with no outcome ever recorded.
    const c = {
      ...base,
      timing: {
        words: 'sunday',
        anchor: '2026-08-22T00:00:00.000Z',
        resolved: { from: '2026-08-23', to: '2026-08-23', statedPrecision: 'day' as const },
      },
    }
    expect(selectCommitments([c], '2026-09-06', 5)).toHaveLength(1)
    expect(selectCommitments([c], '2026-09-07', 5)).toHaveLength(0)
  })
})

// Strips line and block comments out of a TypeScript source string while
// leaving string and template literals alone, so a comment that happens to
// use one of the scanned words (to explain that the state deliberately does
// not exist) never trips the scan below. Matches a double-quoted string, a
// single-quoted string, a template literal, a line comment, or a block
// comment, in that preference order, and drops only the two comment forms.
function stripComments(source: string): string {
  const pattern =
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g
  return source.replace(pattern, (match) =>
    match.startsWith('//') || match.startsWith('/*') ? '' : match,
  )
}

// Important 7: the original scan opened only commitments.ts, which does
// not hold the schema it was meant to guard. CommitmentState,
// CommitmentPayload and the two commitment zod schemas all live in
// graph.ts, so an `overdue` field added there sailed through with the
// whole suite green. Add it here.
//
// engine.ts and reflection.ts were considered too (the review names both
// as places that could render a lateness phrase) and deliberately left
// out: both contain the plain English word "failed" in code strings that
// have nothing to do with commitment lateness (a materialization-failed
// proposal message, a reflection retry-validation message), so scanning
// them whole turns this tripwire into permanent noise rather than a
// sharper guard. Narrowing the scan to only the commitment-touching
// regions of those two large, shared files would be more surgical but
// also more fragile than a file-level scan is meant to be; this is a
// crude tripwire by design (see the comment on the test below), and
// crude tools should stay scoped to files that are actually about the
// thing they guard.
const COMMITMENT_OWNING_FILES = ['./commitments.ts', './graph.ts']

describe('no-overdue-state guarantee', () => {
  it('has no state, field or helper expressing lateness, across every file that owns or renders the commitment shape', () => {
    // Spec section 6: if the data cannot express "you failed to do this",
    // nothing downstream can render it. This test is a crude string scan
    // of the code with comments stripped out, not a type system, and that
    // is deliberate: it is a tripwire. Comments are stripped first so the
    // file can still document, in plain words, that this state does not
    // exist, without tripping the scan itself. If the scan ever fires on
    // an innocent usage, the right fix is to rename that usage, not to
    // weaken the scan. The correct state for a passed window with no
    // recorded outcome is simply open (unknown).
    for (const relativePath of COMMITMENT_OWNING_FILES) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
      const code = stripComments(source)
      for (const forbidden of ['overdue', 'isLate', 'missed', 'pastDue', 'failed']) {
        expect(
          code.toLowerCase(),
          `${relativePath} contains forbidden word "${forbidden}"`,
        ).not.toContain(forbidden.toLowerCase())
      }
    }
  })

  it('leaves a passed window open rather than marking it anything, until the interim grace bound (Ruling 10) closes it', () => {
    const c = {
      id: 'c1',
      label: 'x',
      flavor: 'plan' as const,
      state: 'open' as const,
      sessionId: 's1',
      timing: {
        words: 'sunday',
        anchor: '2026-08-22T00:00:00.000Z',
        resolved: { from: '2026-08-23', to: '2026-08-23', statedPrecision: 'day' as const },
      },
    }
    // Unresolved is an ordinary, unjudged condition: state stays 'open'.
    // What changes is standing-prompt eligibility, which is bounded by
    // the interim grace period (see ASK_GRACE_DAYS in commitments.ts)
    // rather than left open forever.
    expect(selectCommitments([c], '2026-08-24', 5)).toHaveLength(1)
    expect(selectCommitments([c], '2026-09-23', 5)).toHaveLength(0)
  })
})
