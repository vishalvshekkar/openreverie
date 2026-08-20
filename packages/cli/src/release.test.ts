import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

// This file lives at packages/cli/src/release.test.ts, so the repo root is
// three path segments up. Deriving it from import.meta.url keeps the test
// honest regardless of the process working directory, which matters because
// vitest runs this package in project mode rather than from the repo root.
const repoRoot = new URL('../../../', import.meta.url)

async function readAt(path: string): Promise<string> {
  return readFile(new URL(path, repoRoot), 'utf8')
}

describe('release', () => {
  it('marks every workspace package as v0.6.0', async () => {
    const manifests = [
      'package.json',
      'packages/cli/package.json',
      'packages/core/package.json',
      'packages/memory/package.json',
      'packages/providers/package.json',
      'packages/server/package.json',
      'packages/web/package.json',
    ]
    for (const path of manifests) {
      expect(JSON.parse(await readAt(path)).version).toBe('0.6.0')
    }
  })

  it('documents the web interface without claiming atlas features that do not exist', async () => {
    const readme = await readAt('README.md')
    expect(readme).toContain('local web interface')
    expect(readme).toContain('reverie web')

    // Saved positions, label search, and progressive labels were built, so the
    // README is allowed to claim them now. These three are still absent and the
    // README must keep saying so. Overstating status is a defect in this
    // project, so this test guards the claims rather than the wording.
    expect(readme).toContain(
      'Realm influence visualization and a history time lens still do not exist',
    )
    expect(readme).toContain('the worker build the library ships with is not used yet')
    expect(readme).toContain('the server caps it at 8 MiB and never paginates')
  })
})
