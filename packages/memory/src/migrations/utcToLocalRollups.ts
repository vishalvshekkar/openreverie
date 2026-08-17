// Migration "utc-to-local-rollups": delete every existing daily and weekly
// rollup file so the next maintenance pass rebuilds them from session
// summaries on local-day boundaries.
//
// Rollups are derived documents, synthesized by an LLM call from session
// summaries. They are not sacred the way transcripts are. Re-dating an
// existing rollup file in place is not a safe script to write for every
// edge case, and the synthesized prose inside would still describe whatever
// the old UTC boundary grouped together, so this migration discards them and
// lets runMaintenance regenerate them. Session summaries are untouched.
//
// This migration checks migrations.jsonl for its own id rather than only
// looking at the rollup directories: after it runs once, a later
// maintenance pass regenerates rollups (correctly, on local-day boundaries),
// and those must not be deleted again by a second `reverie migrate`.

import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type Migration,
  type MigrationContext,
  type MigrationResult,
  readAppliedMigrationIds,
} from './index.js'

const ID = 'utc-to-local-rollups'

async function listRollupFiles(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }
  return entries
    .filter((entry) => entry.endsWith('.md'))
    .sort()
    .map((entry) => join(dir, entry))
}

export const utcToLocalRollupsMigration: Migration = {
  id: ID,
  description: 'Delete every daily and weekly rollup so they rebuild on local-day boundaries.',
  async isPending(ctx: MigrationContext): Promise<boolean> {
    const applied = await readAppliedMigrationIds(ctx.paths)
    if (applied.has(ID)) {
      return false
    }
    const daily = await listRollupFiles(ctx.paths.rollupsDailyDir)
    const weekly = await listRollupFiles(ctx.paths.rollupsWeeklyDir)
    return daily.length > 0 || weekly.length > 0
  },
  async apply(ctx: MigrationContext, opts: { dryRun: boolean }): Promise<MigrationResult> {
    const daily = await listRollupFiles(ctx.paths.rollupsDailyDir)
    const weekly = await listRollupFiles(ctx.paths.rollupsWeeklyDir)
    const files = [...daily, ...weekly]
    const summary = opts.dryRun
      ? `would delete ${daily.length} daily and ${weekly.length} weekly rollup files; they will be regenerated with local-day boundaries on next use`
      : `deleted ${daily.length} daily and ${weekly.length} weekly rollup files; they will be regenerated with local-day boundaries on next use`
    if (!opts.dryRun) {
      for (const file of files) {
        await rm(file)
      }
    }
    return { id: ID, applied: !opts.dryRun, summary, details: files }
  },
}
