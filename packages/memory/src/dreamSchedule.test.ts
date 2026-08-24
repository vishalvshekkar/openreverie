import { describe, expect, it } from 'vitest'
import { dreamIsDue, MIN_REFLECTED_SESSIONS, periodCovered, periodFor } from './dreamSchedule.js'

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
