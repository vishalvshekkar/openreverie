// Migration "profile-seed": write profile.md into a memory folder that
// predates it. A folder created after this shipped gets profile.md from
// ensureMemoryTree on the next open, but a folder that already exists does
// not, and an explicit migration makes that seeding a listed, auditable
// action instead of a silent side effect. The file is written exactly as
// ensureMemoryTree would for a brand-new folder: a system-default timezone,
// marked as a guess rather than a fact the person confirmed.

import { access } from 'node:fs/promises'
import { writeDocumentAtomic } from '../documents.js'
import { starterProfileDocument } from '../profile.js'
import { systemTimeZone } from '../time.js'
import type { Migration, MigrationContext, MigrationResult } from './index.js'

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export const profileSeedMigration: Migration = {
  id: 'profile-seed',
  description:
    'Seed profile.md with a system-default timezone into a memory folder that predates it.',
  async isPending(ctx: MigrationContext): Promise<boolean> {
    return !(await fileExists(ctx.paths.profile))
  },
  async apply(ctx: MigrationContext, opts: { dryRun: boolean }): Promise<MigrationResult> {
    const summary = opts.dryRun
      ? 'would write profile.md with a system-default timezone'
      : 'wrote profile.md with a system-default timezone'
    if (!opts.dryRun) {
      const doc = starterProfileDocument(ctx.paths.profile, systemTimeZone())
      await writeDocumentAtomic(doc)
    }
    return {
      id: 'profile-seed',
      applied: !opts.dryRun,
      summary,
      details: [ctx.paths.profile],
    }
  },
}
