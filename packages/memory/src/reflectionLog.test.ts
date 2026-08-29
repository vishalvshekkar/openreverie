import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeStores } from './nodeStore.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'
import {
  appendReflectionLog,
  emptyReflectionLogState,
  foldReflectionLog,
  type ReflectionLogRecord,
  readReflectionLog,
  reflectionStateFromLog,
} from './reflectionLog.js'

describe('reflection log', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-reflectionlog-'))
    paths = memoryPaths(dir, nodeStores())
    await ensureMemoryTree(paths, 'UTC')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const attempt: ReflectionLogRecord = {
    ts: '2026-08-29T02:00:00.000Z',
    type: 'attempt',
    session: 'session_01A',
    trigger: 'endSession',
  }
  const reflectedOutcome: ReflectionLogRecord = {
    ts: '2026-08-29T02:00:05.000Z',
    type: 'outcome',
    session: 'session_01A',
    outcome: 'reflected',
  }

  it('round-trips records through append and read', async () => {
    await appendReflectionLog(paths, [attempt, reflectedOutcome])
    expect(await readReflectionLog(paths)).toEqual([attempt, reflectedOutcome])
  })

  it('returns an empty array when the log does not exist', async () => {
    expect(await readReflectionLog(paths)).toEqual([])
  })

  it('rejects an invalid record at append time and writes nothing', async () => {
    const bad = { ...attempt, trigger: 'not-a-trigger' } as unknown as ReflectionLogRecord
    await expect(appendReflectionLog(paths, [bad])).rejects.toThrow()
    expect(await readReflectionLog(paths)).toEqual([])
  })

  it('rejects an outcome record with an outcome value outside the closed set', async () => {
    const bad = {
      ts: '2026-08-29T02:00:05.000Z',
      type: 'outcome',
      session: 'session_01A',
      outcome: 'succeeded',
    } as unknown as ReflectionLogRecord
    await expect(appendReflectionLog(paths, [bad])).rejects.toThrow()
  })

  describe('foldReflectionLog', () => {
    it('has no entry at all for a session the log never mentions', () => {
      const state = foldReflectionLog([attempt])
      expect(state.get('session_never_seen')).toBeUndefined()
    })

    it('a single attempt with no outcome yields attempts: 1, pending: true', () => {
      const state = foldReflectionLog([attempt])
      expect(state.get('session_01A')).toEqual({
        attempts: 1,
        lastAttemptAt: attempt.ts,
        pending: true,
      })
    })

    it('attempt followed by outcome clears pending and records the outcome', () => {
      const state = foldReflectionLog([attempt, reflectedOutcome])
      expect(state.get('session_01A')).toEqual({
        attempts: 1,
        lastAttemptAt: attempt.ts,
        pending: false,
        lastOutcome: 'reflected',
        lastFailureReason: undefined,
      })
    })

    it('attempts accumulate across retries', () => {
      const retryAttempt: ReflectionLogRecord = {
        ts: '2026-08-29T03:00:00.000Z',
        type: 'attempt',
        session: 'session_01A',
        trigger: 'runMaintenance',
      }
      const state = foldReflectionLog([attempt, reflectedOutcome, retryAttempt])
      const entry = state.get('session_01A')
      expect(entry?.attempts).toBe(2)
      expect(entry?.lastAttemptAt).toBe(retryAttempt.ts)
      expect(entry?.pending).toBe(true)
    })

    it('a failed outcome carries its reason, and a later non-failed outcome clears it', () => {
      const failedOutcome: ReflectionLogRecord = {
        ts: '2026-08-29T02:00:05.000Z',
        type: 'outcome',
        session: 'session_01A',
        outcome: 'failed',
        reason: 'reflectSession: provider timed out',
      }
      const failedOnly = foldReflectionLog([attempt, failedOutcome])
      expect(failedOnly.get('session_01A')?.lastOutcome).toBe('failed')
      expect(failedOnly.get('session_01A')?.lastFailureReason).toBe(
        'reflectSession: provider timed out',
      )

      const retryAttempt: ReflectionLogRecord = {
        ts: '2026-08-29T03:00:00.000Z',
        type: 'attempt',
        session: 'session_01A',
        trigger: 'runMaintenance',
      }
      const thenReflected = foldReflectionLog([
        attempt,
        failedOutcome,
        retryAttempt,
        { ...reflectedOutcome, ts: '2026-08-29T03:00:05.000Z' },
      ])
      expect(thenReflected.get('session_01A')?.lastOutcome).toBe('reflected')
      expect(thenReflected.get('session_01A')?.lastFailureReason).toBeUndefined()
    })

    it('folds multiple sessions independently', () => {
      const otherAttempt: ReflectionLogRecord = {
        ts: '2026-08-29T04:00:00.000Z',
        type: 'attempt',
        session: 'session_02B',
        trigger: 'endSession',
      }
      const state = foldReflectionLog([attempt, reflectedOutcome, otherAttempt])
      expect(state.get('session_01A')?.lastOutcome).toBe('reflected')
      expect(state.get('session_02B')?.pending).toBe(true)
      expect(state.get('session_02B')?.attempts).toBe(1)
    })
  })

  describe('reflectionStateFromLog', () => {
    it('reports not_started for an empty fold state', () => {
      expect(reflectionStateFromLog(emptyReflectionLogState())).toBe('not_started')
    })

    it('reports in_progress for a pending attempt with no prior failure', () => {
      const state = foldReflectionLog([attempt]).get('session_01A')
      if (!state) throw new Error('expected a folded state')
      expect(reflectionStateFromLog(state)).toBe('in_progress')
    })

    it('reports reflected or skipped straight from the log when no disk info is given', () => {
      const reflectedState = foldReflectionLog([attempt, reflectedOutcome]).get('session_01A')
      if (!reflectedState) throw new Error('expected a folded state')
      expect(reflectionStateFromLog(reflectedState)).toBe('reflected')

      const skippedOutcome: ReflectionLogRecord = {
        ts: '2026-08-29T02:00:05.000Z',
        type: 'outcome',
        session: 'session_01A',
        outcome: 'skipped',
      }
      const skippedState = foldReflectionLog([attempt, skippedOutcome]).get('session_01A')
      if (!skippedState) throw new Error('expected a folded state')
      expect(reflectionStateFromLog(skippedState)).toBe('skipped')
    })

    it('reports failed when the last outcome failed and nothing has retried since', () => {
      const failedOutcome: ReflectionLogRecord = {
        ts: '2026-08-29T02:00:05.000Z',
        type: 'outcome',
        session: 'session_01A',
        outcome: 'failed',
        reason: 'boom',
      }
      const state = foldReflectionLog([attempt, failedOutcome]).get('session_01A')
      if (!state) throw new Error('expected a folded state')
      expect(reflectionStateFromLog(state)).toBe('failed')
    })

    // The case the advisor's correction targeted: attempt, failed, attempt,
    // then a crash before any further outcome lands. A dangling pending
    // attempt must never mask the last real resolution, or a session that
    // failed and was retried would read as stuck in_progress forever
    // instead of reporting the failure it actually last recorded.
    it('reports failed, not in_progress, for a dangling retry attempt after an earlier failure', () => {
      const failedOutcome: ReflectionLogRecord = {
        ts: '2026-08-29T02:00:05.000Z',
        type: 'outcome',
        session: 'session_01A',
        outcome: 'failed',
        reason: 'boom',
      }
      const retryAttempt: ReflectionLogRecord = {
        ts: '2026-08-29T03:00:00.000Z',
        type: 'attempt',
        session: 'session_01A',
        trigger: 'runMaintenance',
      }
      const state = foldReflectionLog([attempt, failedOutcome, retryAttempt]).get('session_01A')
      if (!state) throw new Error('expected a folded state')
      expect(reflectionStateFromLog(state)).toBe('failed')
    })

    it('disk reflected always wins over a log that disagrees or knows nothing', () => {
      expect(
        reflectionStateFromLog(emptyReflectionLogState(), { reflected: true, skipped: false }),
      ).toBe('reflected')
      expect(
        reflectionStateFromLog(emptyReflectionLogState(), { reflected: true, skipped: true }),
      ).toBe('skipped')
    })

    it('disk not-reflected falls through to the log', () => {
      const state = foldReflectionLog([attempt]).get('session_01A')
      if (!state) throw new Error('expected a folded state')
      expect(reflectionStateFromLog(state, { reflected: false, skipped: false })).toBe(
        'in_progress',
      )
    })
  })
})
