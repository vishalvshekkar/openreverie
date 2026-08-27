import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeStores } from '../nodeStore.js'
import { ensureMemoryTree, memoryPaths } from '../paths.js'
import { loadProfile, writeProfile } from '../profile.js'
import { styleToProfile } from './styleToProfile.js'

async function makeContext(configText: string) {
  const root = await mkdtemp(join(tmpdir(), 'reverie-migrate-'))
  const paths = memoryPaths(join(root, 'memory'), nodeStores())
  await ensureMemoryTree(paths, 'UTC')
  const configPath = join(root, 'config.toml')
  await writeFile(configPath, configText, 'utf8')
  return { paths, configPath, timezone: 'UTC' }
}

const CONFIG_WITH_STYLE = `memoryDir = "/tmp/does-not-matter"

[provider]
name = "openai"
apiKeyEnv = "OPENAI_API_KEY"

[models]
chat = "gpt-5"
reflection = "gpt-5-mini"
embeddings = "text-embedding-3-small"

[safety]
mode = "companion"

[style]
engagement = "leading"
tone = "snarky"
orientation = "solutions"
`

const CONFIG_WITHOUT_STYLE = CONFIG_WITH_STYLE.slice(0, CONFIG_WITH_STYLE.indexOf('[style]'))

describe('style-to-profile migration', () => {
  it('has a stable id and a description', () => {
    expect(styleToProfile.id).toBe('style-to-profile')
    expect(styleToProfile.description.length).toBeGreaterThan(10)
  })

  // Case 1 from spec section 4: config has style, profile has none.
  it('moves style into the profile and drops the config table', async () => {
    const ctx = await makeContext(CONFIG_WITH_STYLE)
    expect(await styleToProfile.isPending(ctx)).toBe(true)

    const result = await styleToProfile.apply(ctx, { dryRun: false })
    expect(result.applied).toBe(true)

    const profile = await loadProfile(ctx.paths, ctx.timezone)
    expect(profile.meta.style).toEqual({
      engagement: 'leading',
      tone: 'snarky',
      orientation: 'solutions',
    })
    const config = await readFile(ctx.configPath, 'utf8')
    expect(config).not.toContain('[style]')
    expect(config).toContain('[safety]')
    expect(await styleToProfile.isPending(ctx)).toBe(false)
  })

  // Case 2: config has no style table and the profile already has style.
  it('is a no-op and reports already done', async () => {
    const ctx = await makeContext(CONFIG_WITHOUT_STYLE)
    const profile = await loadProfile(ctx.paths, ctx.timezone)
    await writeProfile(ctx.paths, {
      ...profile,
      meta: { ...profile.meta, style: { tone: 'direct' } },
    })
    expect(await styleToProfile.isPending(ctx)).toBe(false)
    const result = await styleToProfile.apply(ctx, { dryRun: false })
    expect(result.applied).toBe(false)
    expect([result.summary, ...result.details].join(' ')).toContain('nothing to move')
  })

  // Case 3: both have style. The profile wins, the config table is dropped
  // anyway, and the step says which values it kept and which it discarded.
  it('keeps the profile values and says which config values it discarded', async () => {
    const ctx = await makeContext(CONFIG_WITH_STYLE)
    const profile = await loadProfile(ctx.paths, ctx.timezone)
    await writeProfile(ctx.paths, {
      ...profile,
      meta: { ...profile.meta, style: { tone: 'direct' } },
    })

    const result = await styleToProfile.apply(ctx, { dryRun: false })
    const merged = await loadProfile(ctx.paths, ctx.timezone)
    expect(merged.meta.style?.tone).toBe('direct')
    expect(merged.meta.style?.engagement).toBe('leading')
    const reported = [result.summary, ...result.details].join(' ')
    expect(reported).toContain('kept')
    expect(reported).toContain('tone')
    expect(reported).toContain('discarded')
    expect(await readFile(ctx.configPath, 'utf8')).not.toContain('[style]')
  })

  // Case 4: neither has style.
  it('is a no-op when neither file has style', async () => {
    const ctx = await makeContext(CONFIG_WITHOUT_STYLE)
    expect(await styleToProfile.isPending(ctx)).toBe(false)
    const result = await styleToProfile.apply(ctx, { dryRun: false })
    expect(result.applied).toBe(false)
    expect([result.summary, ...result.details].join(' ')).toContain('nothing to move')
  })

  it('changes nothing on a dry run, and says what it would do', async () => {
    const ctx = await makeContext(CONFIG_WITH_STYLE)
    const configBefore = await readFile(ctx.configPath, 'utf8')
    const profileBefore = await readFile(ctx.paths.profile, 'utf8')

    const result = await styleToProfile.apply(ctx, { dryRun: true })
    expect(result.applied).toBe(false)
    expect(result.summary).toContain('would move')
    expect(await readFile(ctx.configPath, 'utf8')).toEqual(configBefore)
    expect(await readFile(ctx.paths.profile, 'utf8')).toEqual(profileBefore)
  })

  it('is idempotent: a second run leaves both files byte-identical', async () => {
    const ctx = await makeContext(CONFIG_WITH_STYLE)
    await styleToProfile.apply(ctx, { dryRun: false })
    const configAfterFirst = await readFile(ctx.configPath, 'utf8')
    const profileAfterFirst = await readFile(ctx.paths.profile, 'utf8')

    await styleToProfile.apply(ctx, { dryRun: false })
    expect(await readFile(ctx.configPath, 'utf8')).toEqual(configAfterFirst)
    expect(await readFile(ctx.paths.profile, 'utf8')).toEqual(profileAfterFirst)
  })

  it('leaves the rewritten config readable only by its owner', async () => {
    const ctx = await makeContext(CONFIG_WITH_STYLE)
    await styleToProfile.apply(ctx, { dryRun: false })
    const { stat } = await import('node:fs/promises')
    const stats = await stat(ctx.configPath)
    expect(stats.mode & 0o777).toBe(0o600)
  })
})
