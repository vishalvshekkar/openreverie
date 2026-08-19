// The persistent status strip: mode, tone, local place and time, session
// elapsed. Four segments and nothing else.
//
// This is a different component from the spinner in status.ts. The spinner
// is transient, animated, repaints in place, and is gated entirely on
// colorEnabled. The strip is printed once on its own line before each
// prompt, is never animated, and is gated on whether the terminal is
// interactive. They never write in the same frame: the spinner only runs
// while a reply is streaming, the strip only prints while nothing is.
//
// The strip exists so the user can see the two things the model's
// behaviour depends on that are otherwise invisible, mode and tone, plus
// enough orientation to know how long they have been at it. Token counts,
// memory statistics and a hint of the day are deliberately not here.

export interface StatusStripInput {
  mode: string
  tone: string
  location?: string
  localTime?: string
  zoneAbbrev?: string
  elapsedMs: number
}

const SEPARATOR = ' · '

export function renderStatusStrip(input: StatusStripInput): string {
  const segments: string[] = [input.mode, input.tone]

  // A guessed zone is still shown, because it is almost always right and
  // the user can see at a glance if it is not. It is never dressed up with
  // a place name the user never gave, and it never falls back to the host
  // zone when the profile could not supply one: a silent substitution is
  // how a wrong local time becomes invisible.
  if (input.localTime !== undefined && input.zoneAbbrev !== undefined) {
    const place = input.location === undefined ? '' : `${input.location} `
    segments.push(`${place}${input.localTime} ${input.zoneAbbrev}`)
  }

  segments.push(`${Math.floor(input.elapsedMs / 60_000)}m`)
  return segments.join(SEPARATOR)
}

// Returns undefined rather than guessing when there is no zone, or when
// Intl rejects the one there is. The caller omits the segment entirely in
// that case.
export function formatStripTime(
  timezone: string | undefined,
  now: Date,
): { localTime: string; zoneAbbrev: string } | undefined {
  if (timezone === undefined) return undefined
  try {
    const timeParts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).formatToParts(now)

    const hour = timeParts.find((part) => part.type === 'hour')?.value ?? ''
    const minute = timeParts.find((part) => part.type === 'minute')?.value ?? ''
    const dayPeriod = (timeParts.find((part) => part.type === 'dayPeriod')?.value ?? '')
      .toLowerCase()
      .replace(/[^a-z]/g, '')

    const zoneAbbrev = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'short',
    })
      .formatToParts(now)
      .find((part) => part.type === 'timeZoneName')?.value

    if (hour === '' || minute === '' || zoneAbbrev === undefined) return undefined
    return { localTime: `${hour}:${minute}${dayPeriod}`, zoneAbbrev }
  } catch {
    return undefined
  }
}
