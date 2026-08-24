import { describe, expect, it } from 'vitest'
import { documentDateSpan } from './dateSpan.js'

describe('documentDateSpan', () => {
  it('gives a session summary and a daily rollup a single-day span', () => {
    expect(documentDateSpan('summary', { id: 'doc_1', date: '2026-08-12' })).toEqual({
      start: '2026-08-12',
      end: '2026-08-12',
    })
    expect(documentDateSpan('rollup_daily', { id: 'doc_2', date: '2026-05-01' })).toEqual({
      start: '2026-05-01',
      end: '2026-05-01',
    })
  })

  it('gives a weekly rollup the Monday-through-Sunday span of its week', () => {
    expect(documentDateSpan('rollup_weekly', { id: 'doc_3', week: '2026-W33' })).toEqual({
      start: '2026-08-10',
      end: '2026-08-16',
    })
    // A week whose Monday is in the previous calendar year.
    expect(documentDateSpan('rollup_weekly', { id: 'doc_4', week: '2026-W01' })).toEqual({
      start: '2025-12-29',
      end: '2026-01-04',
    })
  })

  it('returns null for every living document kind', () => {
    // An arc carries opened and updated in its frontmatter and neither one
    // is "when this content is about", so it gets no span at all.
    expect(
      documentDateSpan('arc', { id: 'doc_5', opened: '2026-01-04', updated: '2026-08-12' }),
    ).toBeNull()
    expect(documentDateSpan('realm', { id: 'doc_6', name: 'Fitness' })).toBeNull()
    expect(documentDateSpan('person', { id: 'doc_7', name: 'Priya' })).toBeNull()
    expect(documentDateSpan('constitution', { id: 'doc_8' })).toBeNull()
  })

  it('returns null rather than guessing when a dated kind has no usable date', () => {
    expect(documentDateSpan('rollup_daily', { id: 'doc_9' })).toBeNull()
    expect(documentDateSpan('summary', { id: 'doc_10', date: 'yesterday' })).toBeNull()
    expect(documentDateSpan('rollup_weekly', { id: 'doc_11', week: '2026-33' })).toBeNull()
  })

  it('returns the dream date for dream and dream_insight kinds', () => {
    expect(documentDateSpan('dream', { id: 'doc_1', date: '2026-08-24' })).toEqual({
      start: '2026-08-24',
      end: '2026-08-24',
    })
    expect(documentDateSpan('dream_insight', { id: 'doc_2', date: '2026-08-24' })).toEqual({
      start: '2026-08-24',
      end: '2026-08-24',
    })
    expect(documentDateSpan('dream', { id: 'doc_3' })).toBeNull()
  })

  it('never returns undefined for any kind that exists today', () => {
    const kinds = [
      'constitution',
      'realm',
      'arc',
      'summary',
      'rollup_daily',
      'rollup_weekly',
      'person',
    ] as const
    for (const kind of kinds) {
      expect(documentDateSpan(kind, { id: 'doc_x' })).not.toBeUndefined()
    }
  })
})
