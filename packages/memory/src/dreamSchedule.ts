// Cadence names a period (a local day or ISO week), not a time. Every
// trigger asks one question: is the current period due? Missed periods are
// never backfilled (dreaming design spec, Scheduling).
import { isoWeekOf } from './rollups.js'
import { formatLocalDate } from './time.js'

export type DreamCadence = 'daily' | 'weekly'

export const MIN_REFLECTED_SESSIONS = 5

export function periodFor(now: Date, cadence: DreamCadence, timezone: string): string {
  const day = formatLocalDate(now, timezone)
  return cadence === 'daily' ? day : isoWeekOf(day)
}

export function periodCovered(
  existingDreamDates: string[],
  now: Date,
  cadence: DreamCadence,
  timezone: string,
): boolean {
  const current = periodFor(now, cadence, timezone)
  return existingDreamDates.some((date) =>
    cadence === 'daily' ? date === current : isoWeekOf(date) === current,
  )
}

export function dreamIsDue(check: {
  enabled: boolean
  cadence: DreamCadence
  timezone: string
  reflectedSessionCount: number
  existingDreamDates: string[]
  now: Date
}): boolean {
  if (!check.enabled) return false
  if (check.reflectedSessionCount < MIN_REFLECTED_SESSIONS) return false
  return !periodCovered(check.existingDreamDates, check.now, check.cadence, check.timezone)
}
