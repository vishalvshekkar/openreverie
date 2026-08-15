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
  it('marks every workspace package as v0.4.1', async () => {
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
      expect(JSON.parse(await readAt(path)).version).toBe('0.4.1')
    }
  })

  it('documents Phase B without claiming Phase C atlas features', async () => {
    const readme = await readAt('README.md')
    const limitation =
      'The atlas in v0.4.0 has deterministic temporary layout, pan and zoom, type filtering, selection, and an accessible node list. It does not yet include saved graph positions, graph search, realm influence, progressive labels, or a history time lens.'
    expect(readme).toContain('local web interface')
    expect(readme).toContain('reverie web')
    expect(readme).toContain(limitation)
  })
})
