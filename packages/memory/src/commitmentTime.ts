// Resolves only the time phrasings that can be resolved without judgment.
// Everything else returns undefined, which is not a gap: the time spec
// (2026-08-16-time-as-first-class-design.md, lines 107 to 115) deliberately
// refuses to reduce "tonight", "next week" or "sometime in the fall" to one
// instant, and a commitment whose timing this function refuses is carried
// instead as the person's own words plus a model-written gloss.
//
// "next friday" is refused on purpose. English speakers do not agree on
// whether it means the coming Friday or the one after, so resolving it
// would be inventing a fact the person did not state.

import { addDaysLocal, localParts } from './time.js'

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

// Matches the order of WEEKDAYS: index 0 is Sunday. This is the "short"
// weekday abbreviation Intl's en-US formatter produces, which is what
// localParts already renders.
const WEEKDAY_ABBREVIATIONS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export interface ResolvedWindow {
  from: string // YYYY-MM-DD, local to the person's timezone
  to: string // YYYY-MM-DD, inclusive
  // Every phrasing this resolver handles names a single day, so this only
  // ever comes out as 'day'. 'range' is for a later task that resolves
  // stated spans (for example "this weekend"); it is not dead code here.
  statedPrecision: 'day' | 'range'
}

export function resolveStatedTime(
  words: string,
  anchor: Date,
  timezone: string,
): ResolvedWindow | undefined {
  const text = words.trim().toLowerCase()
  if (text.length === 0) return undefined

  const offset = dayOffsetFor(text, anchor, timezone)
  if (offset === undefined) return undefined

  const day = localDayPlus(anchor, timezone, offset)
  return { from: day, to: day, statedPrecision: 'day' }
}

function dayOffsetFor(text: string, anchor: Date, timezone: string): number | undefined {
  if (text === 'today' || text === 'tonight' || text === 'this evening') return 0
  if (text === 'tomorrow' || text === 'tomorrow night') return 1

  const inDays = text.match(/^in (\d+) days?$/)
  if (inDays?.[1]) return Number(inDays[1])

  const weekday = text.match(/^(on |this |next )?([a-z]+)$/)
  const qualifier = weekday?.[1]
  const named = weekday?.[2]
  if (named && WEEKDAYS.includes(named)) {
    // "next <weekday>" is ambiguous: English speakers do not agree on
    // whether it names the coming occurrence of that weekday or the one
    // after, so refuse rather than invent a fact the person did not state.
    if (qualifier === 'next ') return undefined

    const todayIndex = weekdayIndex(anchor, timezone)
    const targetIndex = WEEKDAYS.indexOf(named)
    // The next occurrence, and today counts as zero days away only when the
    // person names today's own weekday.
    return (targetIndex - todayIndex + 7) % 7
  }

  return undefined
}

// The local calendar day, offsetDays after the anchor's own local day.
// Delegates to addDaysLocal, which already does this arithmetic on local
// digits rather than by shifting a UTC instant.
function localDayPlus(anchor: Date, timezone: string, offsetDays: number): string {
  return addDaysLocal(anchor, offsetDays, timezone)
}

// 0 for Sunday through 6 for Saturday, read from the anchor's local weekday
// name rather than any UTC-derived getDay().
function weekdayIndex(anchor: Date, timezone: string): number {
  const { weekday } = localParts(anchor, timezone)
  return WEEKDAY_ABBREVIATIONS.indexOf(weekday)
}
