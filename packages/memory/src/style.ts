// Conversational style: how reverie talks with this person in general.
// These three axes live in profile.md frontmatter, not in config.toml,
// because they are a personal preference rather than infrastructure.
// They live in @openreverie/memory rather than @openreverie/core
// because the profile schema lives here and the dependency direction is
// core -> memory, never the reverse.
//
// The defaults deliberately sit in resolveStyle rather than in the zod
// schema. A profile.md with no style block must load with every axis
// absent, so nothing can mistake an unset axis for a chosen one; the
// persona still needs three concrete values to render, and that is what
// resolveStyle is for.

import { z } from 'zod'

export type Engagement = 'leading' | 'balanced' | 'following'
export type Tone = 'warm' | 'playful' | 'snarky' | 'direct' | 'formal'
export type Orientation = 'listening' | 'balanced' | 'solutions'

export interface StyleConfig {
  engagement: Engagement
  tone: Tone
  orientation: Orientation
}

export const ENGAGEMENT_VALUES: readonly Engagement[] = ['leading', 'balanced', 'following']
export const TONE_VALUES: readonly Tone[] = ['warm', 'playful', 'snarky', 'direct', 'formal']
export const ORIENTATION_VALUES: readonly Orientation[] = ['listening', 'balanced', 'solutions']

export const DEFAULT_STYLE: StyleConfig = {
  engagement: 'balanced',
  tone: 'warm',
  orientation: 'listening',
}

export const styleMetaSchema = z.strictObject({
  engagement: z.enum(['leading', 'balanced', 'following']).optional(),
  tone: z.enum(['warm', 'playful', 'snarky', 'direct', 'formal']).optional(),
  orientation: z.enum(['listening', 'balanced', 'solutions']).optional(),
})

export type StyleMeta = z.infer<typeof styleMetaSchema>

export function resolveStyle(style: StyleMeta | undefined): StyleConfig {
  return {
    engagement: style?.engagement ?? DEFAULT_STYLE.engagement,
    tone: style?.tone ?? DEFAULT_STYLE.tone,
    orientation: style?.orientation ?? DEFAULT_STYLE.orientation,
  }
}
