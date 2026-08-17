import { describe, expect, it } from 'vitest'
import {
  addDaysLocal,
  formatLocalDate,
  formatUtcOffset,
  isValidIanaTimeZone,
  localDateFromStored,
  renderLiveStamp,
  renderLocalTime,
  renderStoredStamp,
  systemTimeZone,
  utcOffsetMinutesFor,
} from './time.js'

describe('isValidIanaTimeZone', () => {
  it('accepts a real IANA zone', () => {
    expect(isValidIanaTimeZone('Asia/Kolkata')).toBe(true)
    expect(isValidIanaTimeZone('America/New_York')).toBe(true)
    expect(isValidIanaTimeZone('UTC')).toBe(true)
  })

  it('rejects a name Intl does not recognize', () => {
    expect(isValidIanaTimeZone('Nowhere/Fake')).toBe(false)
    expect(isValidIanaTimeZone('')).toBe(false)
  })
})

describe('systemTimeZone', () => {
  it('always returns a non-empty zone that validates', () => {
    const zone = systemTimeZone()
    expect(zone.length).toBeGreaterThan(0)
    expect(isValidIanaTimeZone(zone)).toBe(true)
  })
})

describe('formatLocalDate', () => {
  it('reports the local calendar day, not the UTC one, east of UTC', () => {
    expect(formatLocalDate(new Date('2026-08-16T20:12:00Z'), 'Asia/Kolkata')).toBe('2026-08-17')
  })

  it('reports the local calendar day, not the UTC one, west of UTC', () => {
    expect(formatLocalDate(new Date('2026-08-17T02:30:00Z'), 'America/New_York')).toBe('2026-08-16')
  })

  it('matches the UTC day when the zone is UTC', () => {
    expect(formatLocalDate(new Date('2026-08-16T20:12:00Z'), 'UTC')).toBe('2026-08-16')
  })
})

describe('addDaysLocal', () => {
  it('subtracts days from the local calendar day', () => {
    expect(addDaysLocal(new Date('2026-08-16T20:12:00Z'), -7, 'Asia/Kolkata')).toBe('2026-08-10')
  })

  it('adds days across a month boundary', () => {
    expect(addDaysLocal(new Date('2026-08-30T20:12:00Z'), 3, 'Asia/Kolkata')).toBe('2026-09-03')
  })

  it('adds zero days and returns the local day itself', () => {
    expect(addDaysLocal(new Date('2026-08-16T20:12:00Z'), 0, 'Asia/Kolkata')).toBe('2026-08-17')
  })
})

describe('utcOffsetMinutesFor', () => {
  it('reports a positive offset east of UTC', () => {
    expect(utcOffsetMinutesFor(new Date('2026-08-16T20:12:00Z'), 'Asia/Kolkata')).toBe(330)
  })

  it('reports a negative offset west of UTC', () => {
    expect(utcOffsetMinutesFor(new Date('2026-08-16T20:12:00Z'), 'America/New_York')).toBe(-240)
  })

  it('reports zero for UTC', () => {
    expect(utcOffsetMinutesFor(new Date('2026-08-16T20:12:00Z'), 'UTC')).toBe(0)
  })
})

describe('formatUtcOffset', () => {
  it('formats a positive half-hour offset', () => {
    expect(formatUtcOffset(330)).toBe('UTC+05:30')
  })

  it('formats a negative whole-hour offset', () => {
    expect(formatUtcOffset(-300)).toBe('UTC-05:00')
  })

  it('formats zero as a positive offset', () => {
    expect(formatUtcOffset(0)).toBe('UTC+00:00')
  })
})

describe('renderLocalTime and renderLiveStamp', () => {
  it('renders weekday, local date, 24-hour local time, and the zone name', () => {
    const at = new Date('2026-08-16T20:00:00Z')
    expect(renderLocalTime(at, 'Asia/Kolkata')).toBe('Mon 2026-08-17 01:30 Asia/Kolkata')
    expect(renderLiveStamp(at, 'Asia/Kolkata')).toBe('[Mon 2026-08-17 01:30 Asia/Kolkata]')
  })

  it('renders local midnight as 00:00, never as 24:00', () => {
    expect(renderLocalTime(new Date('2026-08-16T18:30:00Z'), 'Asia/Kolkata')).toBe(
      'Mon 2026-08-17 00:00 Asia/Kolkata',
    )
  })
})

describe('renderStoredStamp', () => {
  it('renders the wall clock that was in effect, using the stored offset', () => {
    expect(renderStoredStamp('2026-08-16T16:12:00.000Z', 330)).toBe(
      '[Sun 2026-08-16 21:42 UTC+05:30]',
    )
  })

  it('renders a labeled UTC instant when the offset is absent, and never guesses a local time', () => {
    expect(renderStoredStamp('2026-08-14T09:03:11Z')).toBe(
      '[2026-08-14T09:03:11Z (UTC; local time unknown)]',
    )
  })

  it('falls back to the labeled UTC form when ts is not a parseable instant', () => {
    expect(renderStoredStamp('not-a-date', 330)).toBe('[not-a-date (UTC; local time unknown)]')
  })
})

describe('localDateFromStored', () => {
  it('derives the local calendar day from a UTC instant and its stored offset', () => {
    expect(localDateFromStored('2026-08-16T20:12:00.000Z', 330)).toBe('2026-08-17')
    expect(localDateFromStored('2026-08-17T02:30:00.000Z', -300)).toBe('2026-08-16')
  })
})
