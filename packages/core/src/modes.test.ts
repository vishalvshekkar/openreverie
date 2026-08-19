import { describe, expect, it } from 'vitest'
import { JOURNAL_MODE_ENGAGEMENT_CLAUSE, JOURNAL_MODE_ORIENTATION_CLAUSE } from './journaling.js'
import { isModeName, MODE_NAMES, MODES, modeOverrides, modeParagraph } from './modes.js'

// The override table from spec section 6.2, transcribed. This test is what
// keeps the spec and the catalogue from drifting apart: flip any cell here
// or in the catalogue and this row fails.
const SPEC_OVERRIDES: Record<string, string[]> = {
  general: [],
  listen: ['engagement', 'orientation'],
  solve: ['orientation'],
  real: ['engagement'],
  deep: ['engagement', 'orientation'],
  brainstorm: ['orientation'],
  boost: ['engagement'],
  decompress: ['orientation'],
  process: ['orientation'],
  journal: ['engagement', 'orientation'],
}

describe('mode catalogue', () => {
  it('holds exactly the ten modes from the spec', () => {
    expect([...MODE_NAMES]).toEqual([
      'general',
      'listen',
      'solve',
      'real',
      'deep',
      'brainstorm',
      'boost',
      'decompress',
      'process',
      'journal',
    ])
    expect(Object.keys(MODES).sort()).toEqual([...MODE_NAMES].sort())
  })

  it('gives every mode a non-empty one-line summary', () => {
    for (const name of MODE_NAMES) {
      expect(MODES[name].summary.length).toBeGreaterThan(10)
      expect(MODES[name].summary).not.toContain('\n')
    }
  })

  it('overrides only engagement and orientation, never tone', () => {
    for (const name of MODE_NAMES) {
      for (const axis of modeOverrides(name)) {
        expect(['engagement', 'orientation']).toContain(axis)
      }
      expect(Object.keys(MODES[name].clauses)).not.toContain('tone')
    }
  })

  // A mode that suppresses an axis and then says nothing about it has
  // deleted the user's setting and put nothing in its place. This fails
  // where a prompt-content test would not, because the resulting prompt is
  // still perfectly well-formed and just quietly says nothing about who
  // leads.
  it('gives every suppressed axis a non-empty clause', () => {
    for (const name of MODE_NAMES) {
      for (const axis of modeOverrides(name)) {
        const clause = MODES[name].clauses[axis]
        expect(clause, `${name}.${axis}`).toBeDefined()
        expect((clause ?? '').trim().length, `${name}.${axis}`).toBeGreaterThan(20)
      }
    }
  })

  // The generic length-only check above already passed against journal's
  // old placeholder clauses, so it cannot catch a regression where the
  // catalogue entry stops pointing at journaling.ts's real content. This
  // identity check is what actually falsifies that wiring.
  it("journal's catalogue clauses are the real exports from journaling.ts, not placeholder text", () => {
    expect(MODES.journal.clauses.orientation).toBe(JOURNAL_MODE_ORIENTATION_CLAUSE)
    expect(MODES.journal.clauses.engagement).toBe(JOURNAL_MODE_ENGAGEMENT_CLAUSE)
  })

  it('matches the override table in spec section 6.2, mode by mode', () => {
    for (const name of MODE_NAMES) {
      expect(modeOverrides(name).sort(), name).toEqual(SPEC_OVERRIDES[name]?.sort())
    }
  })

  it('gives general no paragraph at all', () => {
    expect(modeParagraph('general')).toBeUndefined()
    expect(modeOverrides('general')).toEqual([])
  })

  it('renders the orientation clause before the engagement clause', () => {
    const paragraph = modeParagraph('listen') ?? ''
    const orientation = MODES.listen.clauses.orientation ?? ''
    const engagement = MODES.listen.clauses.engagement ?? ''
    expect(paragraph.indexOf(orientation)).toBeGreaterThanOrEqual(0)
    expect(paragraph.indexOf(engagement)).toBeGreaterThan(paragraph.indexOf(orientation))
  })

  it('carries the boost constraints the spec makes hard requirements', () => {
    const paragraph = modeParagraph('boost') ?? ''
    expect(paragraph).toContain('search memory')
    expect(paragraph).toContain('not enough')
    expect(paragraph).toMatch(/do not (make|manufactur|invent)/i)
  })

  it('recognizes mode names and refuses anything else', () => {
    expect(isModeName('listen')).toBe(true)
    expect(isModeName('Listen')).toBe(false)
    expect(isModeName('moed')).toBe(false)
  })
})
