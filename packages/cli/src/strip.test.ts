import { describe, expect, it } from 'vitest'
import { formatStripTime, renderStatusStrip } from './strip.js'

describe('renderStatusStrip', () => {
  it('renders all four segments when everything is known', () => {
    expect(
      renderStatusStrip({
        mode: 'general',
        tone: 'warm',
        location: 'Bengaluru',
        localTime: '4:19pm',
        zoneAbbrev: 'IST',
        elapsedMs: 12 * 60 * 1000,
      }),
    ).toBe('general · warm · Bengaluru 4:19pm IST · 12m')
  })

  it('drops the place name when the location is unknown', () => {
    expect(
      renderStatusStrip({
        mode: 'listen',
        tone: 'direct',
        localTime: '4:19pm',
        zoneAbbrev: 'IST',
        elapsedMs: 0,
      }),
    ).toBe('listen · direct · 4:19pm IST · 0m')
  })

  it('omits the whole time segment when the zone could not be rendered', () => {
    const line = renderStatusStrip({
      mode: 'general',
      tone: 'warm',
      location: 'Bengaluru',
      elapsedMs: 60_000,
    })
    expect(line).toBe('general · warm · 1m')
    expect(line).not.toContain('UTC')
    expect(line).not.toContain('Bengaluru')
  })

  it('renders 0m for anything under a minute', () => {
    expect(renderStatusStrip({ mode: 'general', tone: 'warm', elapsedMs: 59_000 })).toBe(
      'general · warm · 0m',
    )
  })

  it('rounds elapsed down to whole minutes', () => {
    expect(renderStatusStrip({ mode: 'general', tone: 'warm', elapsedMs: 121_000 })).toBe(
      'general · warm · 2m',
    )
  })
})

describe('formatStripTime', () => {
  it('renders a local time and zone abbreviation for a real zone', () => {
    const formatted = formatStripTime('Asia/Kolkata', new Date('2026-08-17T10:49:00.000Z'))
    expect(formatted?.localTime).toBe('4:19pm')
    expect(formatted?.zoneAbbrev).toBe('GMT+5:30')
  })

  it('returns undefined for a zone Intl rejects', () => {
    expect(formatStripTime('Mars/Olympus', new Date())).toBeUndefined()
  })

  it('returns undefined when no zone is set, rather than falling back to the host', () => {
    expect(formatStripTime(undefined, new Date())).toBeUndefined()
  })
})
