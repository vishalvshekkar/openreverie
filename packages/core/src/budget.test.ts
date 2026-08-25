import { describe, expect, it } from 'vitest'
import { CONSTITUTION_CAP, capBody, capRows, PROMPT_BUDGET_TOTAL, SECTION_CAPS } from './budget.js'

describe('the budget arithmetic', () => {
  it('keeps the sum of every per-section character cap inside the stated total', () => {
    const sum = SECTION_CAPS.reduce((total, cap) => total + cap, 0)
    // 27800 plus COMMITMENTS_SECTION_CAP (800), added when the commitments
    // section landed, plus DREAM_INSIGHTS_SECTION_CAP (1800), added when
    // dreaming landed. Each arrived with a deliberate PROMPT_BUDGET_TOTAL
    // raise in the same change, 28000 to 28800 and then 28800 to 30600.
    expect(sum).toBe(30400)
    expect(sum).toBeLessThanOrEqual(PROMPT_BUDGET_TOTAL)
  })
})

describe('capBody', () => {
  it('leaves a body under the limit exactly as it is, with no marker', () => {
    const body = 'A short constitution.\n\nTwo paragraphs, nothing more.'
    const result = capBody(body, CONSTITUTION_CAP, 'doc_1')
    expect(result.truncated).toBe(false)
    expect(result.text).toBe(body)
    expect(result.text).not.toContain('truncated')
  })

  it('cuts at the last paragraph boundary before the limit and names the docId', () => {
    const head = `${'a'.repeat(40)}\n\n${'b'.repeat(40)}`
    const tail = 'THE SENTINEL PARAGRAPH'
    const body = `${head}\n\n${tail}`
    const result = capBody(body, 90, 'doc_01JAB7QK3M9XZ2R4T6V8W0YCDE')

    expect(result.truncated).toBe(true)
    expect(result.text).not.toContain(tail)
    expect(result.text).toContain('a'.repeat(40))
    expect(result.text).toContain('b'.repeat(40))
    expect(result.text).toContain(
      'Call read_document with docId doc_01JAB7QK3M9XZ2R4T6V8W0YCDE for the full text.',
    )
    expect(result.text).toContain('(truncated: showing the first 82 of 106 characters.')
  })

  it('cuts at the limit when there is no paragraph boundary before it', () => {
    const body = 'x'.repeat(500)
    const result = capBody(body, 100, 'doc_2')
    expect(result.truncated).toBe(true)
    expect(result.text.startsWith('x'.repeat(100))).toBe(true)
    expect(result.text).toContain('(truncated: showing the first 100 of 500 characters.')
  })

  it('formats large character counts with thousands separators', () => {
    const result = capBody('y'.repeat(18432), 6000, 'doc_3')
    expect(result.text).toContain('(truncated: showing the first 6,000 of 18,432 characters.')
  })
})

describe('capRows', () => {
  it('keeps every row when they all fit', () => {
    const rows = ['- one', '- two', '- three']
    expect(capRows(rows, 1000)).toEqual({ rows, shown: 3 })
  })

  it('stops at the last row that fits, counting the newline between rows', () => {
    // '- one' is 5 characters, '- two' another 5 plus one newline: 11 to
    // hold both. A limit of 10 holds only the first.
    const result = capRows(['- one', '- two', '- three'], 10)
    expect(result).toEqual({ rows: ['- one'], shown: 1 })
  })

  it('returns nothing when even the first row does not fit', () => {
    expect(capRows(['- a very long single row'], 5)).toEqual({ rows: [], shown: 0 })
  })
})
