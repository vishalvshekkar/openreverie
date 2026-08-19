// Moves the [style] table out of config.toml and into profile.md.
//
// config.toml holds infrastructure: provider, API key, model names, memory
// folder, safety mode, crisis resources. Nothing personal. A preference
// about how someone likes to be spoken to has no business sitting in the
// file that holds the API key and is written 0600 for exactly that reason.
//
// This is the first migration that reads and rewrites config.toml, which
// is why MigrationContext carries configPath: the file lives outside the
// memory folder and its location is overridable with --config, so a
// migration must not guess the default path.

import { randomBytes } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { loadProfile, writeProfile } from '../profile.js'
import { type StyleMeta, styleMetaSchema } from '../style.js'
import type { Migration, MigrationContext, MigrationResult } from './index.js'

async function readRawConfig(configPath: string): Promise<Record<string, unknown> | undefined> {
  let text: string
  try {
    text = await readFile(configPath, 'utf8')
  } catch {
    return undefined
  }
  try {
    return parseToml(text) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function readConfigStyle(raw: Record<string, unknown> | undefined): StyleMeta | undefined {
  if (!raw || raw.style === undefined) return undefined
  const parsed = styleMetaSchema.safeParse(raw.style)
  return parsed.success ? parsed.data : undefined
}

// Written with the same 0600 permissions saveConfig uses, and through the
// same temp-file-then-rename dance, because this file holds the API key.
async function writeConfigWithoutStyle(
  configPath: string,
  raw: Record<string, unknown>,
): Promise<void> {
  const { style: _dropped, ...rest } = raw
  const text = stringifyToml(rest)
  const tmpPath = join(
    dirname(configPath),
    `.${basename(configPath)}.tmp-${randomBytes(6).toString('hex')}`,
  )
  await writeFile(tmpPath, text, { encoding: 'utf8', mode: 0o600 })
  await rename(tmpPath, configPath)
}

export const styleToProfile: Migration = {
  id: 'style-to-profile',
  description: 'Move the [style] table from config.toml into profile.md.',

  async isPending(ctx: MigrationContext): Promise<boolean> {
    const raw = await readRawConfig(ctx.configPath)
    return raw !== undefined && raw.style !== undefined
  },

  async apply(ctx: MigrationContext, opts: { dryRun: boolean }): Promise<MigrationResult> {
    const raw = await readRawConfig(ctx.configPath)
    const configStyle = readConfigStyle(raw)

    if (raw === undefined || raw.style === undefined) {
      return {
        id: 'style-to-profile',
        applied: false,
        summary: 'config.toml has no [style] table: nothing to move.',
        details: [],
      }
    }

    const profile = await loadProfile(ctx.paths)
    const profileStyle = profile.meta.style ?? {}

    // The profile wins on any axis it already has a value for, because a
    // value the user set in the settings pane must not be overwritten by a
    // stale one from TOML. The config table is dropped either way, and the
    // step says plainly which values it kept and which it discarded.
    const kept: string[] = []
    const discarded: string[] = []
    const merged: StyleMeta = { ...profileStyle }
    for (const axis of ['engagement', 'tone', 'orientation'] as const) {
      const fromConfig = configStyle?.[axis]
      if (fromConfig === undefined) continue
      if (merged[axis] === undefined) {
        ;(merged as Record<string, string>)[axis] = fromConfig
      } else if (merged[axis] !== fromConfig) {
        kept.push(`${axis}=${merged[axis]}`)
        discarded.push(`${axis}=${fromConfig}`)
      }
    }

    const details: string[] = []
    if (kept.length > 0) {
      details.push(
        `profile.md already had style, so it wins: kept ${kept.join(', ')}, discarded ${discarded.join(', ')} from config.toml.`,
      )
    }

    if (opts.dryRun) {
      return {
        id: 'style-to-profile',
        applied: false,
        summary: `would move style from ${ctx.configPath} into ${ctx.paths.profile} and drop the [style] table.`,
        details,
      }
    }

    await writeProfile(ctx.paths, { ...profile, meta: { ...profile.meta, style: merged } })
    await writeConfigWithoutStyle(ctx.configPath, raw)
    return {
      id: 'style-to-profile',
      applied: true,
      summary: `moved style into ${ctx.paths.profile} and removed [style] from config.toml.`,
      details,
    }
  },
}
