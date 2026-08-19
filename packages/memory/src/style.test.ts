import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STYLE,
  ENGAGEMENT_VALUES,
  ORIENTATION_VALUES,
  resolveStyle,
  styleMetaSchema,
  TONE_VALUES,
} from './style.js'

describe('style enums', () => {
  it('carries the three axis value lists', () => {
    expect(ENGAGEMENT_VALUES).toEqual(['leading', 'balanced', 'following'])
    expect(TONE_VALUES).toEqual(['warm', 'playful', 'snarky', 'direct', 'formal'])
    expect(ORIENTATION_VALUES).toEqual(['listening', 'balanced', 'solutions'])
  })

  it('defaults to balanced, warm, listening', () => {
    expect(DEFAULT_STYLE).toEqual({
      engagement: 'balanced',
      tone: 'warm',
      orientation: 'listening',
    })
  })
})

describe('styleMetaSchema', () => {
  it('accepts an empty object, because every axis is optional in the file', () => {
    const parsed = styleMetaSchema.safeParse({})
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).toEqual({})
  })

  it('rejects a value outside an axis enum', () => {
    expect(styleMetaSchema.safeParse({ tone: 'sardonic' }).success).toBe(false)
  })

  it('does not invent defaults on parse', () => {
    const parsed = styleMetaSchema.parse({ engagement: 'leading' })
    expect(parsed).toEqual({ engagement: 'leading' })
    expect('tone' in parsed).toBe(false)
  })
})

describe('resolveStyle', () => {
  it('fills every unset axis from DEFAULT_STYLE', () => {
    expect(resolveStyle(undefined)).toEqual(DEFAULT_STYLE)
    expect(resolveStyle({})).toEqual(DEFAULT_STYLE)
  })

  it('keeps the axes that are set', () => {
    expect(resolveStyle({ tone: 'direct' })).toEqual({
      engagement: 'balanced',
      tone: 'direct',
      orientation: 'listening',
    })
  })
})
