// Pending-rollup date logic (pure) and LLM rollup builders.
//
// The pure functions below decide which daily and weekly rollups are due.
// They never touch the filesystem or a provider; callers supply the raw
// date lists (from session dirs, existing rollup files) and get back the
// dates or ISO weeks that still need a rollup written.

// --- Pure functions ---

/**
 * Convert a date string (YYYY-MM-DD) to its ISO 8601 week identifier
 * (YYYY-Www). Week 1 is the week containing the year's first Thursday;
 * weeks run Monday to Sunday. A date near a year boundary can belong to
 * the ISO week of the adjacent calendar year.
 */
export function isoWeekOf(date: string): string {
  const parts = date.split('-').map(Number)
  const year = parts[0]
  const month = parts[1]
  const day = parts[2]
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`isoWeekOf: expected a YYYY-MM-DD date, got "${date}"`)
  }
  const target = new Date(Date.UTC(year, month - 1, day))

  // ISO day number: Monday = 1 .. Sunday = 7 (getUTCDay() gives 0 for Sunday).
  const isoDayNum = target.getUTCDay() || 7
  // Move to the Thursday of this ISO week; the Thursday's calendar year
  // is always the ISO week-numbering year.
  target.setUTCDate(target.getUTCDate() + (4 - isoDayNum))

  const isoYear = target.getUTCFullYear()
  const weekNumber = Math.ceil(((target.getTime() - Date.UTC(isoYear, 0, 1)) / 86400000 + 1) / 7)

  return `${isoYear}-W${String(weekNumber).padStart(2, '0')}`
}

/**
 * Dates strictly before `today` that have at least one session and no
 * daily rollup yet, sorted ascending. `today` itself is never pending,
 * regardless of how many sessions it has.
 */
export function pendingDailyRollups(
  sessionDates: string[],
  existingDailies: string[],
  today: string,
): string[] {
  const covered = new Set(existingDailies)
  const pending = new Set(sessionDates.filter((date) => date < today && !covered.has(date)))
  return [...pending].sort()
}

/**
 * ISO weeks strictly before the ISO week of `today` that have at least
 * one daily rollup and no weekly rollup yet, sorted ascending. Comparison
 * is done on the ISO week identifier, not the raw date, so a daily in the
 * same week as `today` is never pending even if its date is earlier.
 */
export function pendingWeeklyRollups(
  dailyDates: string[],
  existingWeeklies: string[],
  today: string,
): string[] {
  const todayWeek = isoWeekOf(today)
  const covered = new Set(existingWeeklies)
  const pending = new Set<string>()
  for (const date of dailyDates) {
    const week = isoWeekOf(date)
    if (week < todayWeek && !covered.has(week)) {
      pending.add(week)
    }
  }
  return [...pending].sort()
}
