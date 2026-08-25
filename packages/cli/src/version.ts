// Reads reverie's own installed version at runtime, from the CLI
// package's own package.json, never a literal hardcoded in source.
// The published binary is a single bundled file at dist/index.js
// (see scripts/bundle.mjs), one directory below packages/cli/package.json,
// and that is true in every install shape (local build, npm link, global
// install): npm always ships package.json regardless of the "files"
// field. This function's own logic (join with '..') is what keeps that
// relationship correct; it does not depend on tsc mirroring the source
// tree, only on the bundle sitting in a `dist/` directory next to
// package.json. See
// docs/superpowers/specs/2026-08-16-cli-polish-and-ci-fix-design.md
// section 1.2 for why this mechanism, not a JSON import attribute or
// process.env.npm_package_version, is the one that works here.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function readOwnVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
    version: string
  }
  return pkg.version
}
