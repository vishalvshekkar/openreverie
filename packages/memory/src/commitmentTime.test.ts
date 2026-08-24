import { describe, expect, it } from 'vitest'
import { resolveStatedTime } from './commitmentTime.js'

// Saturday 2026-08-22, 16:29 local in Asia/Kolkata.
const ANCHOR = new Date('2026-08-22T10:59:00.000Z')
const TZ = 'Asia/Kolkata'

describe('resolveStatedTime, phrases it resolves', () => {
  const cases: [string, string, string][] = [
    ['tomorrow', '2026-08-23', '2026-08-23'],
    ['today', '2026-08-22', '2026-08-22'],
    ['tonight', '2026-08-22', '2026-08-22'],
    ['in 3 days', '2026-08-25', '2026-08-25'],
    ['sunday', '2026-08-23', '2026-08-23'],
    ['on Wednesday', '2026-08-26', '2026-08-26'],
  ]

  for (const [words, from, to] of cases) {
    it(`resolves "${words}"`, () => {
      expect(resolveStatedTime(words, ANCHOR, TZ)).toEqual({
        from,
        to,
        statedPrecision: 'day',
      })
    })
  }
})

describe('resolveStatedTime, phrases it must refuse', () => {
  const refused = [
    'next friday', // genuinely ambiguous in English
    'come summer', // geographic and seasonal, needs a gloss
    'next fall',
    'over the holidays',
    'sometime in the coming week',
    'someday',
    'at some point',
    'after the wedding', // event anchored, Task 5 handles it
    '',
  ]

  for (const words of refused) {
    it(`refuses "${words}" rather than guessing`, () => {
      expect(resolveStatedTime(words, ANCHOR, TZ)).toBeUndefined()
    })
  }
})

it('resolves the same weekday differently depending on the anchor', () => {
  // Said on Saturday, "sunday" is tomorrow.
  expect(resolveStatedTime('sunday', new Date('2026-08-22T10:59:00.000Z'), TZ)?.from).toBe(
    '2026-08-23',
  )
  // Said on Monday, "sunday" is six days out.
  expect(resolveStatedTime('sunday', new Date('2026-08-24T10:59:00.000Z'), TZ)?.from).toBe(
    '2026-08-30',
  )
})

it('respects the timezone, not the machine, when the local day differs from UTC', () => {
  // 2026-08-22T19:30Z is already Sunday 2026-08-23 in Asia/Kolkata.
  expect(resolveStatedTime('today', new Date('2026-08-22T19:30:00.000Z'), TZ)?.from).toBe(
    '2026-08-23',
  )
})

it('reads the anchor weekday in the timezone, not UTC', () => {
  // 2026-08-22T19:30Z is Saturday in UTC but already Sunday in Asia/Kolkata,
  // so "sunday" is today, not six days out.
  expect(resolveStatedTime('sunday', new Date('2026-08-22T19:30:00.000Z'), TZ)?.from).toBe(
    '2026-08-23',
  )
})
