// Local wall-clock time: the calendar helpers every day boundary in the
// memory folder is computed from, and the one stamp renderer both the live
// chat path and the stored transcript path use.
//
// Nothing in this file reads a clock. Every function takes the instant it
// works from, and the IANA timezone it renders that instant in, as plain
// arguments. That is what lets a test pin both without touching the TZ
// environment variable, which is process-wide and would race any other test
// running in the same process.
//
// Node's built-in Intl carries the IANA database, so no external timezone
// dependency is needed for any of this.

export function isValidIanaTimeZone(value: string): boolean {
  if (value.length === 0) return false
  try {
    // Constructing a formatter with an unrecognized zone throws RangeError.
    // That throw is the validation; there is nothing to read off the result.
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

// The zone of the machine reverie is running on. Always returns something,
// worst case 'UTC' on a misconfigured machine. This is a guess about where
// the person is, never a fact they confirmed.
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

// en-CA formats a date as YYYY-MM-DD directly, which is the form every
// session date, rollup date, and summary frontmatter date in this codebase
// already uses.
export function formatLocalDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

// Pure calendar arithmetic on local digits. Date.UTC is used as the
// arithmetic engine, not as an instant: the value it produces is a scratch
// calculation whose year/month/day are read straight back out, so no
// timezone conversion happens between writing and reading it.
export function addDaysLocal(date: Date, days: number, timezone: string): string {
  const parts = formatLocalDate(date, timezone).split('-')
  const year = Number(parts[0])
  const month = Number(parts[1])
  const day = Number(parts[2])
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  const shiftedYear = shifted.getUTCFullYear()
  const shiftedMonth = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const shiftedDay = String(shifted.getUTCDate()).padStart(2, '0')
  return `${shiftedYear}-${shiftedMonth}-${shiftedDay}`
}

interface LocalParts {
  weekday: string
  year: string
  month: string
  day: string
  hour: string
  minute: string
}

// hourCycle: 'h23' rather than hour12: false. The latter renders local
// midnight as 24:00 in some locales, which would put a stamp on the wrong
// calendar day at exactly the boundary this spec exists to get right.
function localParts(date: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  return {
    weekday: pick('weekday'),
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour'),
    minute: pick('minute'),
  }
}

export function utcOffsetMinutesFor(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const pick = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0')
  const asIfUtc = Date.UTC(
    pick('year'),
    pick('month') - 1,
    pick('day'),
    pick('hour'),
    pick('minute'),
    pick('second'),
  )
  // The formatted parts carry no milliseconds, so drop them from the real
  // instant too before differencing; otherwise the result is off by a
  // fraction of a minute and rounds unpredictably at the boundary.
  const actual = Math.floor(date.getTime() / 1000) * 1000
  return Math.round((asIfUtc - actual) / 60000)
}

export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0')
  const rest = String(absolute % 60).padStart(2, '0')
  return `UTC${sign}${hours}:${rest}`
}

// The live path knows the person's IANA zone, so it renders the zone name.
export function renderLocalTime(date: Date, timezone: string): string {
  const parts = localParts(date, timezone)
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${timezone}`
}

export function renderLiveStamp(date: Date, timezone: string): string {
  return `[${renderLocalTime(date, timezone)}]`
}

const UNKNOWN_LOCAL_SUFFIX = '(UTC; local time unknown)'

// The stored path knows only the instant and the offset that was in effect
// when the line was written, so it renders the offset rather than a zone
// name. A missing offset means genuinely unknown: this renders the plain
// UTC instant and never computes a local time from a timezone the line does
// not actually carry.
export function renderStoredStamp(ts: string, utcOffsetMinutes?: number): string {
  if (utcOffsetMinutes === undefined) {
    return `[${ts} ${UNKNOWN_LOCAL_SUFFIX}]`
  }
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) {
    return `[${ts} ${UNKNOWN_LOCAL_SUFFIX}]`
  }
  // A fixed offset is not an IANA zone name, and the Etc/GMT zones only
  // cover whole hours, so half-hour offsets like +05:30 have no zone to
  // format against. Shifting the instant by the offset and formatting the
  // result in UTC produces exactly the wall-clock digits that were in
  // effect when the line was written.
  const shifted = new Date(date.getTime() + utcOffsetMinutes * 60000)
  const parts = localParts(shifted, 'UTC')
  return `[${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${formatUtcOffset(utcOffsetMinutes)}]`
}

// The local calendar day a stored line belongs to, from its own instant and
// its own recorded offset. Same shifting trick as renderStoredStamp, and
// the same reason.
export function localDateFromStored(ts: string, utcOffsetMinutes: number): string {
  const date = new Date(ts)
  const shifted = new Date(date.getTime() + utcOffsetMinutes * 60000)
  return formatLocalDate(shifted, 'UTC')
}
