import { describe, expect, it } from 'vitest'
import { isoWeekOf, pendingDailyRollups, pendingWeeklyRollups } from './rollups.js'

describe('isoWeekOf', () => {
  const boundaryCases: Array<[string, string]> = [
    ['2021-01-01', '2020-W53'],
    ['2022-12-31', '2022-W52'],
    ['2023-01-01', '2022-W52'],
    ['2024-12-30', '2025-W01'],
    ['2025-01-01', '2025-W01'],
    ['2026-01-01', '2026-W01'],
    ['2026-08-13', '2026-W33'],
    ['2027-01-01', '2026-W53'],
    ['2016-01-03', '2015-W53'],
  ]

  it.each(boundaryCases)('maps %s to %s', (date, expected) => {
    expect(isoWeekOf(date)).toBe(expected)
  })

  it('only changes label on Mondays across 2022 through 2024', () => {
    const start = Date.UTC(2022, 0, 1)
    const end = Date.UTC(2024, 11, 31)
    let previousLabel: string | null = null
    for (let t = start; t <= end; t += 86400000) {
      const d = new Date(t)
      const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
      const label = isoWeekOf(dateStr)
      if (previousLabel !== null && label !== previousLabel) {
        expect(d.getUTCDay()).toBe(1)
      }
      previousLabel = label
    }
  })

  it('places December 28th in that same year final ISO week for every year 2015 through 2030', () => {
    for (let year = 2015; year <= 2030; year++) {
      const dateStr = `${year}-12-28`
      const label = isoWeekOf(dateStr)
      const match = label.match(/^(\d{4})-W(\d{2})$/)
      expect(match).not.toBeNull()
      const [, isoYearStr, weekStr] = match as RegExpMatchArray
      expect(Number(isoYearStr)).toBe(year)
      const week = Number(weekStr)
      expect(week === 52 || week === 53).toBe(true)
    }
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
