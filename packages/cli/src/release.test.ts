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
  it('marks every workspace package as v0.9.1', async () => {
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
      expect(JSON.parse(await readAt(path)).version).toBe('0.9.1')
    }
  })

  it('does not force @openreverie/web on every @openreverie/server consumer', async () => {
    const manifest = JSON.parse(await readAt('packages/server/package.json'))
    expect(manifest.dependencies).not.toHaveProperty('@openreverie/web')
  })

  // Ordinary internal `dependencies` (core -> memory, server -> core, and so
  // on) are deliberately left as `workspace:*` in every package's source: the
  // release pipeline packs with pnpm, which rewrites that protocol to an
  // exact version in the published manifest, and pinning them by hand would
  // break local workspace linking (pnpm's default link-workspace-packages is
  // false, so a bare "0.9.0" here would resolve from the registry instead of
  // the workspace, before these packages are even published there). A
  // `peerDependencies` entry is different: the task that added the first
  // one deliberately wrote a real range there instead of trusting the
  // rewrite, so this guards that one field against the workspace: specifier
  // creeping back in, which would be the mistake this whole change exists to
  // prevent.
  it('declares no workspace: specifier in peerDependencies of a published package', async () => {
    const manifests = [
      'packages/cli/package.json',
      'packages/core/package.json',
      'packages/memory/package.json',
      'packages/providers/package.json',
      'packages/server/package.json',
      'packages/web/package.json',
    ]
    for (const path of manifests) {
      const manifest = JSON.parse(await readAt(path))
      const peers: Record<string, string> = manifest.peerDependencies ?? {}
      for (const [name, specifier] of Object.entries(peers)) {
        expect(
          specifier.startsWith('workspace:'),
          `${path} peerDependencies.${name} is "${specifier}", an uninstallable specifier for a consumer outside this workspace`,
        ).toBe(false)
      }
    }
  })

  it('never marks packages/web private, or a recursive publish would silently skip it', async () => {
    const manifest = JSON.parse(await readAt('packages/web/package.json'))
    expect(manifest.private).not.toBe(true)
  })

  it('keeps the @openreverie/web peer range in step with the version it ships beside', async () => {
    // A caret range on a 0.x version does not cross a minor: ^0.9.0 admits
    // 0.9.7 and refuses 0.10.0. So a peer range written once and left alone
    // stops admitting the very package it ships beside the moment the minor
    // moves, and nothing else here would notice: the version-parity test
    // above reads `version` fields and never looks at a range. Pinned to
    // ^major.minor.0 rather than to the exact current version so a patch
    // release does not churn it, while a minor bump has to be deliberate.
    const root = JSON.parse(await readAt('package.json'))
    const [major, minor] = String(root.version).split('.')
    const server = JSON.parse(await readAt('packages/server/package.json'))
    expect(server.peerDependencies?.['@openreverie/web']).toBe(`^${major}.${minor}.0`)
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
