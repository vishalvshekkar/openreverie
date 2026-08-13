import { describe, expect, it } from 'vitest'
import { isoWeekOf, pendingDailyRollups, pendingWeeklyRollups } from './rollups.js'

describe('isoWeekOf', () => {
  it('computes a mid-year week', () => {
    expect(isoWeekOf('2026-08-13')).toBe('2026-W33')
  })

  it('assigns January 1st to the prior ISO year when it falls before that year first Thursday', () => {
    expect(isoWeekOf('2027-01-01')).toBe('2026-W53')
  })

  it('assigns January 1st to week 1 when it falls on or after the ISO year first Thursday', () => {
    expect(isoWeekOf('2026-01-01')).toBe('2026-W01')
  })

  it('assigns a late December date to the next ISO year week 1 when applicable', () => {
    expect(isoWeekOf('2025-12-31')).toBe('2026-W01')
  })

  it('assigns the last day of a 53-week ISO year correctly', () => {
    expect(isoWeekOf('2026-12-31')).toBe('2026-W53')
  })
})

describe('pendingDailyRollups', () => {
  it('flags a date strictly before today with a session and no daily rollup', () => {
    const result = pendingDailyRollups(['2026-08-10'], [], '2026-08-13')
    expect(result).toEqual(['2026-08-10'])
  })

  it('never flags today, even with sessions', () => {
    const result = pendingDailyRollups(['2026-08-13'], [], '2026-08-13')
    expect(result).toEqual([])
  })

  it('skips a date that already has a daily rollup', () => {
    const result = pendingDailyRollups(['2026-08-10'], ['2026-08-10'], '2026-08-13')
    expect(result).toEqual([])
  })

  it('skips a date with no sessions at all', () => {
    const result = pendingDailyRollups([], [], '2026-08-13')
    expect(result).toEqual([])
  })

  it('deduplicates multiple sessions on the same date', () => {
    const result = pendingDailyRollups(['2026-08-10', '2026-08-10', '2026-08-10'], [], '2026-08-13')
    expect(result).toEqual(['2026-08-10'])
  })

  it('sorts results ascending', () => {
    const result = pendingDailyRollups(['2026-08-11', '2026-08-09', '2026-08-10'], [], '2026-08-13')
    expect(result).toEqual(['2026-08-09', '2026-08-10', '2026-08-11'])
  })

  it('never flags a date after today', () => {
    const result = pendingDailyRollups(['2026-08-14'], [], '2026-08-13')
    expect(result).toEqual([])
  })
})

describe('pendingWeeklyRollups', () => {
  it('flags an ISO week strictly before the week of today with a daily rollup and no weekly rollup', () => {
    // 2026-08-03 is in ISO week 2026-W32, today 2026-08-13 is in 2026-W33.
    const result = pendingWeeklyRollups(['2026-08-03'], [], '2026-08-13')
    expect(result).toEqual(['2026-W32'])
  })

  it('never flags the ISO week of today, even with a daily rollup dated before today', () => {
    // 2026-08-10 is in the same ISO week as today (2026-08-13), which is 2026-W33.
    const result = pendingWeeklyRollups(['2026-08-10'], [], '2026-08-13')
    expect(result).toEqual([])
  })

  it('skips a week that already has a weekly rollup', () => {
    const result = pendingWeeklyRollups(['2026-08-03'], ['2026-W32'], '2026-08-13')
    expect(result).toEqual([])
  })

  it('deduplicates multiple dailies in the same ISO week', () => {
    const result = pendingWeeklyRollups(
      ['2026-08-03', '2026-08-04', '2026-08-05'],
      [],
      '2026-08-13',
    )
    expect(result).toEqual(['2026-W32'])
  })

  it('sorts results ascending across a year boundary', () => {
    // 2025-12-31 -> 2026-W01, 2026-08-03 -> 2026-W32.
    const result = pendingWeeklyRollups(['2026-08-03', '2025-12-31'], [], '2026-08-13')
    expect(result).toEqual(['2026-W01', '2026-W32'])
  })

  it('handles a week spanning a year boundary correctly against today in the new year', () => {
    // 2025-12-31 is ISO week 2026-W01. If today is early in 2026-W02, that week is strictly before.
    const result = pendingWeeklyRollups(['2025-12-31'], [], '2026-01-08')
    expect(result).toEqual(['2026-W01'])
  })
})
