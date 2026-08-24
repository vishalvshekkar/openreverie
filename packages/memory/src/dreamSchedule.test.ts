import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireDreamLock,
  DREAM_LOCK_STALE_MS,
  dreamIsDue,
  MIN_REFLECTED_SESSIONS,
  periodCovered,
  periodFor,
  releaseDreamLock,
} from './dreamSchedule.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'

// 2026-08-24 is a Monday. 18:30 UTC on the 24th is already the 25th in Tokyo.
const NOW = new Date('2026-08-24T18:30:00.000Z')

describe('periodFor', () => {
  it('uses the local day in the given timezone', () => {
    expect(periodFor(NOW, 'daily', 'UTC')).toBe('2026-08-24')
    expect(periodFor(NOW, 'daily', 'Asia/Tokyo')).toBe('2026-08-25')
  })
  it('uses the ISO week of the local day', () => {
    expect(periodFor(NOW, 'weekly', 'UTC')).toBe('2026-W35')
  })
})

describe('periodCovered', () => {
  it('daily: covered only by a dream dated the current local day', () => {
    expect(periodCovered(['2026-08-23'], NOW, 'daily', 'UTC')).toBe(false)
    expect(periodCovered(['2026-08-24'], NOW, 'daily', 'UTC')).toBe(true)
  })
  it('weekly: any dream date inside the current ISO week covers it', () => {
    expect(periodCovered(['2026-08-23'], NOW, 'weekly', 'UTC')).toBe(false) // Sunday, W34
    expect(periodCovered(['2026-08-24'], NOW, 'weekly', 'UTC')).toBe(true) // Monday, W35
  })
})

describe('dreamIsDue', () => {
  const base = {
    enabled: true,
    cadence: 'daily' as const,
    timezone: 'UTC',
    reflectedSessionCount: MIN_REFLECTED_SESSIONS,
    existingDreamDates: [] as string[],
    now: NOW,
  }
  it('due when enabled, enough sessions, period uncovered', () => {
    expect(dreamIsDue(base)).toBe(true)
  })
  it('not due when disabled, or below the session floor, or covered', () => {
    expect(dreamIsDue({ ...base, enabled: false })).toBe(false)
    expect(dreamIsDue({ ...base, reflectedSessionCount: MIN_REFLECTED_SESSIONS - 1 })).toBe(false)
    expect(dreamIsDue({ ...base, existingDreamDates: ['2026-08-24'] })).toBe(false)
  })
  it('a long gap leaves exactly the current period due, never the missed ones', () => {
    expect(dreamIsDue({ ...base, existingDreamDates: ['2026-06-01'] })).toBe(true)
  })
})

describe('dream lock', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-dreamschedule-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('first acquire wins, second loses, release frees it', async () => {
    expect(await acquireDreamLock(paths, NOW)).toBe(true)
    expect(await acquireDreamLock(paths, NOW)).toBe(false)
    await releaseDreamLock(paths)
    expect(await acquireDreamLock(paths, NOW)).toBe(true)
  })
  it('a stale lock is taken over', async () => {
    expect(await acquireDreamLock(paths, NOW)).toBe(true)
    const later = new Date(NOW.getTime() + DREAM_LOCK_STALE_MS + 1)
    expect(await acquireDreamLock(paths, later)).toBe(true)
  })
  it('release is a no-op when no lock exists', async () => {
    await expect(releaseDreamLock(paths)).resolves.toBeUndefined()
  })
  it('takes over a lock file whose contents cannot be parsed', async () => {
    await writeFile(join(paths.dreamsDir, '.lock'), 'not json at all', 'utf8')
    expect(await acquireDreamLock(paths, NOW)).toBe(true)
  })
  it('does not take over a lock file that is valid and fresh', async () => {
    await writeFile(
      join(paths.dreamsDir, '.lock'),
      JSON.stringify({ ts: NOW.toISOString(), pid: 999999 }),
      'utf8',
    )
    expect(await acquireDreamLock(paths, NOW)).toBe(false)
  })
})
