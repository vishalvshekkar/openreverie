// profile.md: structured personal facts about the person, at the memory
// folder root beside constitution.md.
//
// Three files hold facts about the person and the line between them is
// drawn deliberately. config.toml is infrastructure (provider, models,
// memory folder, safety mode) and is validated with z.strictObject, which
// rejects unknown keys on purpose. constitution.md is meaning: prose
// testimony about who the person is, never a reliable machine-parseable
// source. profile.md is the machine-readable middle: fields a piece of code
// has to read back out and feed to something, starting with the timezone
// that Intl.DateTimeFormat needs.
//
// The schema here is deliberately NOT strict. Config is a closed set of
// knobs where an unknown key is almost always a typo worth rejecting hard.
// Profile is an open, growing set of personal facts, so an unrecognized or
// forward-written key is passed through untyped rather than making the file
// fail to load, matching the [key: string]: unknown posture DocumentMeta
// already takes for every other document in the folder.

import { z } from 'zod'
import { newId, readDocument, writeDocumentAtomic } from './documents.js'
import type { MemoryPaths } from './paths.js'
import { type StyleMeta, styleMetaSchema } from './style.js'
import { isValidIanaTimeZone, systemTimeZone } from './time.js'

export interface ProfileMeta {
  id: string
  timezone?: string
  timezoneSource?: 'system-default' | 'user-confirmed'
  preferredName?: string
  pronouns?: string
  location?: string
  birthday?: string
  occupation?: string
  birthdayGreetings?: boolean
  style?: StyleMeta
  [key: string]: unknown
}

export interface Profile {
  meta: ProfileMeta & { [key: string]: unknown }
  body: string
}

// MM-DD or YYYY-MM-DD. The year is optional because plenty of people
// will say the day without the year, and a profile field records what
// was actually said rather than demanding a shape nobody offered.
export const BIRTHDAY_PATTERN = /^(\d{4}-)?\d{2}-\d{2}$/

export const profileMetaSchema = z
  .object({
    id: z.string(),
    timezone: z
      .string()
      .refine(isValidIanaTimeZone, { message: 'is not a recognized IANA timezone' })
      .optional(),
    timezoneSource: z.enum(['system-default', 'user-confirmed']).optional(),
    preferredName: z.string().optional(),
    pronouns: z.string().optional(),
    location: z.string().optional(),
    birthday: z.string().regex(BIRTHDAY_PATTERN).optional(),
    occupation: z.string().optional(),
    birthdayGreetings: z.boolean().optional(),
    style: styleMetaSchema.optional(),
  })
  .passthrough()
export const PROFILE_STARTER_BODY = `This file holds structured facts about you that reverie needs to read back
out in code, starting with your timezone. It is machine managed and safe to
hand edit; keep the frontmatter valid YAML.
`

export function starterProfileDocument(
  path: string,
  timezone: string,
): { path: string; meta: ProfileMeta & { [key: string]: unknown }; body: string } {
  return {
    path,
    meta: { id: newId('doc'), timezone, timezoneSource: 'system-default' },
    body: PROFILE_STARTER_BODY,
  }
}

// A folder created after this shipped always has profile.md, because
// ensureMemoryTree seeds it. A folder that predates it does not, and
// `reverie migrate` is what writes one. Until that runs, this returns an
// in-memory system default and writes nothing: a read must never have a
// write as a side effect.
export async function loadProfile(paths: MemoryPaths): Promise<Profile> {
  let raw: Awaited<ReturnType<typeof readDocument>>
  try {
    raw = await readDocument(paths.profile)
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return {
        meta: { id: newId('doc'), timezone: systemTimeZone(), timezoneSource: 'system-default' },
        body: PROFILE_STARTER_BODY,
      }
    }
    throw err
  }

  const parsed = profileMetaSchema.safeParse(raw.meta)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(
        (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
      )
      .join('; ')
    throw new Error(`Profile at ${paths.profile} is not valid: ${detail}`)
  }

  return { meta: parsed.data as ProfileMeta & { [key: string]: unknown }, body: raw.body }
}

export async function writeProfile(paths: MemoryPaths, profile: Profile): Promise<void> {
  await writeDocumentAtomic({ path: paths.profile, meta: profile.meta, body: profile.body })
}
