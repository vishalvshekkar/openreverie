import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type MemoryPaths, memoryPaths } from './paths.js'
import {
  loadProfile,
  MODEL_WRITE_FIELDS,
  profileMetaSchema,
  profileSettingsPatchSchema,
  profileUpdatesSchema,
  starterProfileDocument,
  updateProfileArgsSchema,
  writeProfile,
} from './profile.js'

describe('profileMetaSchema', () => {
  it('accepts a valid IANA timezone', () => {
    const result = profileMetaSchema.safeParse({
      id: 'doc_1',
      timezone: 'Asia/Kolkata',
      timezoneSource: 'user-confirmed',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a timezone Intl does not recognize', () => {
    const result = profileMetaSchema.safeParse({ id: 'doc_1', timezone: 'Nowhere/Fake' })
    expect(result.success).toBe(false)
  })

  it('rejects a timezoneSource outside the two known values', () => {
    const result = profileMetaSchema.safeParse({ id: 'doc_1', timezoneSource: 'guessed' })
    expect(result.success).toBe(false)
  })

  it('passes an unknown key through untouched instead of stripping or rejecting it', () => {
    const result = profileMetaSchema.safeParse({
      id: 'doc_1',
      timezone: 'Asia/Kolkata',
      pronouns: 'she/her',
    })
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ id: 'doc_1', timezone: 'Asia/Kolkata', pronouns: 'she/her' })
  })

  it('accepts a document with no timezone at all', () => {
    const result = profileMetaSchema.safeParse({ id: 'doc_1' })
    expect(result.success).toBe(true)
  })
})

describe('loadProfile and writeProfile', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-profile-'))
    paths = memoryPaths(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips a written profile', async () => {
    await writeProfile(paths, {
      meta: { id: 'doc_profile', timezone: 'Asia/Kolkata', timezoneSource: 'user-confirmed' },
      body: 'Machine managed.\n',
    })

    const loaded = await loadProfile(paths)
    expect(loaded.meta.timezone).toBe('Asia/Kolkata')
    expect(loaded.meta.timezoneSource).toBe('user-confirmed')
    expect(loaded.meta.id).toBe('doc_profile')
  })

  it('returns an in-memory system-default profile when the file does not exist, and writes nothing', async () => {
    const loaded = await loadProfile(paths)
    expect(loaded.meta.timezoneSource).toBe('system-default')
    expect(typeof loaded.meta.timezone).toBe('string')
    await expect(rm(paths.profile)).rejects.toThrow()
  })

  it('reports a schema failure against the path it came from', async () => {
    await writeFile(paths.profile, '---\nid: doc_x\ntimezone: Nowhere/Fake\n---\nBody.\n', 'utf8')
    await expect(loadProfile(paths)).rejects.toThrow(paths.profile)
  })

  it('keeps an unknown frontmatter key across a load and a rewrite', async () => {
    await writeFile(
      paths.profile,
      '---\nid: doc_x\ntimezone: Asia/Kolkata\npronouns: she/her\n---\nBody.\n',
      'utf8',
    )
    const loaded = await loadProfile(paths)
    expect(loaded.meta.pronouns).toBe('she/her')

    await writeProfile(paths, {
      meta: { ...loaded.meta, timezone: 'America/New_York' },
      body: loaded.body,
    })
    const reloaded = await loadProfile(paths)
    expect(reloaded.meta.pronouns).toBe('she/her')
    expect(reloaded.meta.timezone).toBe('America/New_York')
  })

  it('builds a starter document carrying the given zone as a system default', () => {
    const doc = starterProfileDocument(paths.profile, 'Asia/Kolkata')
    expect(doc.meta.timezone).toBe('Asia/Kolkata')
    expect(doc.meta.timezoneSource).toBe('system-default')
    expect(doc.meta.id.startsWith('doc_')).toBe(true)
    expect(doc.body.length).toBeGreaterThan(0)
  })
})

describe('profileMetaSchema personal fields', () => {
  it('accepts every field from the spec, all optional', () => {
    const parsed = profileMetaSchema.safeParse({
      id: 'doc_1',
      preferredName: 'Vish',
      pronouns: 'he/him or they/them',
      location: 'Bengaluru',
      timezone: 'Asia/Kolkata',
      timezoneSource: 'user-confirmed',
      birthday: '1990-04-02',
      occupation: 'nurse',
      birthdayGreetings: true,
      style: { engagement: 'leading', tone: 'direct', orientation: 'solutions' },
    })
    expect(parsed.success).toBe(true)
  })

  it('invents no defaults: a file with only an id yields nothing else', () => {
    const parsed = profileMetaSchema.parse({ id: 'doc_1' })
    expect(parsed).toEqual({ id: 'doc_1' })
    expect(parsed.style).toBeUndefined()
    expect(parsed.preferredName).toBeUndefined()
  })

  it('does not return warm as a tone for a file with no style block', () => {
    const parsed = profileMetaSchema.parse({ id: 'doc_1', timezone: 'Asia/Kolkata' })
    expect(parsed.style?.tone).toBeUndefined()
  })

  it('accepts a birthday with and without a year', () => {
    expect(profileMetaSchema.safeParse({ id: 'd', birthday: '04-02' }).success).toBe(true)
    expect(profileMetaSchema.safeParse({ id: 'd', birthday: '1990-04-02' }).success).toBe(true)
  })

  it('rejects a birthday that is neither shape', () => {
    expect(profileMetaSchema.safeParse({ id: 'd', birthday: 'April 2nd' }).success).toBe(false)
  })

  it('rejects a style axis value outside its enum', () => {
    expect(profileMetaSchema.safeParse({ id: 'd', style: { tone: 'sardonic' } }).success).toBe(
      false,
    )
  })

  it('passes an unknown key through unchanged, because the profile is an open set', () => {
    const parsed = profileMetaSchema.parse({ id: 'd', favouriteTea: 'assam' })
    expect(parsed.favouriteTea).toBe('assam')
  })

  it('round-trips dreams preferences and rejects an invalid voice', () => {
    const ok = profileMetaSchema.safeParse({
      id: 'doc_1',
      dreams: { voice: 'second', openerMention: false },
    })
    expect(ok.success).toBe(true)
    if (ok.success) {
      expect(ok.data.dreams).toEqual({ voice: 'second', openerMention: false })
    }

    const bad = profileMetaSchema.safeParse({ id: 'doc_1', dreams: { voice: 'fourth' } })
    expect(bad.success).toBe(false)
  })

  it('passes an unknown key inside dreams through, since dreams is passthrough too', () => {
    const parsed = profileMetaSchema.parse({
      id: 'doc_1',
      dreams: { voice: 'first', futureField: true },
    })
    expect((parsed.dreams as Record<string, unknown>).futureField).toBe(true)
  })
})

describe('MODEL-WRITE profile schemas', () => {
  const allowed = {
    preferredName: 'Vish',
    pronouns: 'they/them',
    location: 'Bengaluru',
    timezone: 'Asia/Kolkata',
    birthday: '04-02',
    occupation: 'nurse',
    birthdayGreetings: false,
  }

  it('updateProfileArgsSchema accepts every allowlisted field', () => {
    expect(updateProfileArgsSchema.safeParse(allowed).success).toBe(true)
  })

  it('profileUpdatesSchema accepts every allowlisted field', () => {
    expect(profileUpdatesSchema.safeParse(allowed).success).toBe(true)
  })

  it('both accept an empty object, since every key is optional', () => {
    expect(updateProfileArgsSchema.safeParse({}).success).toBe(true)
    expect(profileUpdatesSchema.safeParse({}).success).toBe(true)
  })

  // This is the test that keeps the style/mode split real. Adding style to
  // either allowlist makes the corresponding assertion fail, because the
  // schema would then accept exactly what the rule says it must not.
  it('updateProfileArgsSchema rejects a style key', () => {
    const parsed = updateProfileArgsSchema.safeParse({ style: { tone: 'direct' } })
    expect(parsed.success).toBe(false)
  })

  it('profileUpdatesSchema rejects a style key', () => {
    const parsed = profileUpdatesSchema.safeParse({ style: { tone: 'direct' } })
    expect(parsed.success).toBe(false)
  })

  it('both reject a nested style axis smuggled in at the top level', () => {
    expect(updateProfileArgsSchema.safeParse({ tone: 'direct' }).success).toBe(false)
    expect(profileUpdatesSchema.safeParse({ orientation: 'solutions' }).success).toBe(false)
  })

  it('the allowlist is exactly the seven fields from the spec', () => {
    expect([...MODEL_WRITE_FIELDS].sort()).toEqual(
      [
        'birthday',
        'birthdayGreetings',
        'location',
        'occupation',
        'preferredName',
        'pronouns',
        'timezone',
      ].sort(),
    )
  })

  it('rejects a timezone Intl does not recognize', () => {
    expect(updateProfileArgsSchema.safeParse({ timezone: 'Mars/Olympus' }).success).toBe(false)
  })

  it('rejects a birthday that is neither MM-DD nor YYYY-MM-DD', () => {
    expect(profileUpdatesSchema.safeParse({ birthday: 'next tuesday' }).success).toBe(false)
  })
})

describe('profileSettingsPatchSchema', () => {
  it('accepts style and prose, which no MODEL-WRITE schema may accept', () => {
    const parsed = profileSettingsPatchSchema.safeParse({
      style: { tone: 'direct' },
      prose: 'Prefers to be called Vish by everyone except his mother.',
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts null to clear a field', () => {
    expect(profileSettingsPatchSchema.safeParse({ location: null }).success).toBe(true)
  })

  it('rejects infrastructure keys that belong to config.toml', () => {
    for (const body of [
      { provider: { apiKey: 'sk-test' } },
      { safety: { mode: 'firewall' } },
      { models: { chat: 'gpt-5' } },
      { memoryDir: '/tmp/elsewhere' },
    ]) {
      expect(profileSettingsPatchSchema.safeParse(body).success).toBe(false)
    }
  })

  it('rejects timezoneSource, which is not a setting', () => {
    expect(profileSettingsPatchSchema.safeParse({ timezoneSource: 'user-confirmed' }).success).toBe(
      false,
    )
  })
})
