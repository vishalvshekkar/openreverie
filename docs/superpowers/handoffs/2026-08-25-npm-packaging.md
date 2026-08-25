# npm packaging for the openreverie CLI

Documents the release mechanism added on 2026-08-25: how `npm i -g openreverie` is meant to
work, what was actually built, and what was and was not verified. The owner has not published
yet; this records the mechanism for whoever runs that publish, and for anyone changing it later.

## Publish target: `packages/cli`, not a new package

`packages/cli`'s manifest already carried `"name": "openreverie"` and `"bin": {"reverie":
"dist/index.js"}`, so it stayed the publish target. Its `package.json` was rewritten rather than
a new top-level package created:

- `dependencies` dropped the four `workspace:*` entries and now holds only `better-sqlite3`.
- `@openreverie/core`, `memory`, `providers`, and `server` moved to `devDependencies`, still as
  `workspace:*`. This keeps `pnpm install` symlinking them into `packages/cli/node_modules` for
  local development, `tsc -b` typechecking, and the bundle step's own module resolution, without
  publishing an unresolvable specifier in `dependencies`. `npm publish` writes `devDependencies`
  into the published manifest verbatim (confirmed: see Verification below), but npm never
  installs a dependency's `devDependencies` for a consumer, whether that consumer is `npm i -g`
  or another package's `node_modules`, so the `workspace:*` entries there are inert for anyone
  installing the package. Only `dependencies` is what actually gets installed, and that field
  holds nothing but `better-sqlite3`.
- `files` is an explicit whitelist: `["dist/index.js", "dist/web", "README.md", "LICENSE"]`, not
  `"dist"` wholesale. `tsc -b` (part of the ordinary workspace build) still writes a full
  per-file compiled tree into `packages/cli/dist` for typechecking; nothing in the workspace
  imports it, so it is harmless clutter locally, and the whitelist keeps it out of the tarball
  regardless.
- Added `repository` and `bugs`, pointing at `github.com/vishalvshekkar/openreverie`.
  `--provenance` needs `repository` to match the publishing repo.
- Added `engines.node: ">=22"`, matching the rest of the workspace.
- Dropped `types`: the published artifact is a bundled binary, not a library; no `.d.ts` ships.

## The bundle step

`packages/cli/scripts/bundle.mjs`, using esbuild (added as a `devDependency` of
`packages/cli`). Entry point `packages/cli/src/index.ts`, `bundle: true`, `platform: 'node'`,
`format: 'esm'`, `target: 'node22'`, output `packages/cli/dist/index.js`. It assumes the
workspace has already been built (`pnpm build`, which runs `tsc -b` for the four workspace
dependencies and `vite build` for `packages/web`) and asserts each required input exists before
doing anything, failing loudly instead of silently shipping a broken package.

Two things had to stay external, not one:

- **`better-sqlite3`**, per the task brief: it resolves its compiled `.node` binary by walking
  the filesystem relative to its own installed package directory (`lib/database.js`), so
  bundling its JS would break that lookup. It stays a real, separately installed `dependency`.
- **`gray-matter`** (a dependency of `@openreverie/memory`), found only by actually running the
  bundle, not by reading it. `gray-matter` reassigns `exports` inside its own files
  (`lib/engines.js`: `const engines = exports = module.exports;`), which forces esbuild to wrap
  it as a CommonJS module rather than hoist its `require()` calls into static imports. A wrapped
  module's `require()` calls, including for a node builtin like `'fs'`, go through esbuild's own
  runtime shim, which only works if a real top-level `require` exists. An ESM file has none by
  default, so every such call threw `Dynamic require of "fs" is not supported` at module load
  time, before any command ran at all: `gray-matter` is statically imported from
  `@openreverie/memory`, so its top-level `require('fs')` executed while the bundle's own module
  graph was being evaluated, ahead of argv parsing. `reverie version` failed with the identical
  error, not just `reverie doctor`; every command did. Fixed with esbuild's `banner` option,
  injecting `const require = createRequire(import.meta.url)` at the top of the output so
  esbuild's shim has a real `require` to delegate to. `packages/server/src/index.ts` already
  declared its own top-level `const require = createRequire(...)` for a different reason (see
  below); it was renamed to `nodeRequire` to avoid colliding with the banner's binding in the
  merged output.
- The bundle script now guards this class of failure on every build, not just this one instance
  of it: after chmod, it spawns `node dist/index.js version` and fails the build if that exits
  non-zero. `version` needs no config file and no network access, so the check stays fast and
  deterministic, and it still exercises the entire module graph, since every statically imported
  module runs at load time regardless of which subcommand was asked for. Falsified by removing
  the banner and confirming the smoke test fails the build with the same dynamic-require error,
  then restoring the banner and confirming it passes again.

No other dependency in the runtime path (`zod`, `smol-toml`, `ulid`, and the rest of
`gray-matter`'s own dependency tree: `js-yaml`, `kind-of`, `section-matter`,
`strip-bom-string`) needed to be external. Checked directly: no other `.node` binary anywhere
in the dependency tree of `cli`, `core`, `memory`, `providers`, or `server` (`fsevents` and
`@rollup/rollup-darwin-arm64` do exist under `node_modules`, but only as devDependencies of the
web build tooling, never in the runtime path); no other `require.resolve`, `createRequire`, or
dynamic `import()` anywhere in those five packages' `src`.

The shebang: esbuild preserves a leading `#!` from the entry file automatically, keeping it as
the literal first line of the output ahead of the banner. The bundle script asserts this
explicitly after the build rather than trusting it silently.

The executable bit: `tsc -b` writes `dist/index.js` at mode 644, which is what broke the
owner's `npm link` on every rebuild. The fix is not a one-time `chmod`; it is that the bundle
script runs `chmod(outfile, 0o755)` itself, every time it runs, and the root `pnpm build` script
was changed to always run the bundle step last:

```
tsc -b --force && pnpm --filter @openreverie/web exec vite build && pnpm --filter openreverie run bundle
```

So an ordinary `pnpm build` always ends with a freshly bundled, freshly executable
`dist/index.js`, not something that only happens at publish time. `prepack` in
`packages/cli/package.json` runs the same script (`node ./scripts/bundle.mjs`, not `pnpm run
bundle`, since the eventual publisher is npm, not necessarily pnpm), so `npm pack` and `npm
publish` also produce a fresh bundle on their own regardless of whether `pnpm build` already ran.

## The static asset fix (`resolveStaticDir`)

`packages/server/src/index.ts` used to locate the web interface's built assets with
`require.resolve('@openreverie/web/package.json')`, then read `dist/` alongside it. That only
works when `@openreverie/web` is a real, separately resolvable package, true in the monorepo
(it is a `workspace:*` dependency of `@openreverie/server`) but never true for the published
`openreverie` package, which does not depend on `@openreverie/web` at all: its built assets are
copied straight into `packages/cli/dist/web` by the bundle script instead.

`resolveStaticDir` (now exported, previously private) checks for a `web/index.html` sitting
next to its own running module first, and only falls back to the `require.resolve` path if that
does not exist:

```ts
export async function resolveStaticDir(
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
): Promise<string> {
  const bundledAssets = join(moduleDir, 'web')
  if (await isFile(join(bundledAssets, 'index.html'))) {
    return bundledAssets
  }
  const webPackage = nodeRequire.resolve('@openreverie/web/package.json')
  return join(dirname(webPackage), 'dist')
}
```

A positive check (the file exists) rather than a try/catch on the `require.resolve` throwing,
so the monorepo path (where `dist/web` never exists next to `packages/server/dist`) falls
through cleanly and deterministically rather than depending on which branch happens to throw
first. `moduleDir` defaults to this file's own directory and is only overridden by the new test,
`packages/server/src/index.test.ts`, which exercises both branches: one with a temp `web/`
directory present (the bundled-install layout), one without it, where it falls through to the
real `@openreverie/web` workspace dependency resolving inside this monorepo (the dev layout).
Both were falsified individually before being trusted: forcing the first branch to `if (false)`
made the bundled-layout test fail with the actual monorepo path instead of the expected temp
path, then the fix was restored and reverified green.

## Verification actually performed

All of the following were run against a locally built tarball, not a report of the build having
produced a file:

- `pnpm build`, `pnpm test` (1431 passed, up from the 1429 baseline by the two new
  `resolveStaticDir` tests; 0 skipped), `pnpm lint` (exit 0), all from the repo root.
- `npm pack --dry-run` inside `packages/cli`: 10 files, 397.0 kB packed / 1.8 MB unpacked
  (`LICENSE`, `README.md`, `dist/index.js`, five files under `dist/web/assets`,
  `dist/web/index.html`, `package.json`). No source, no tests, no `.superpowers/`, no
  `docs/superpowers/`, nothing from a memory folder.
- `npm pack` for real, into a scratchpad directory, then `npm install --prefix <scratch prefix>
  -g <tarball>` from outside the repo. Confirmed only `better-sqlite3` and its own transitive
  dependencies were installed (39 packages total); no `@openreverie/*` package was ever
  attempted.
- From a directory that is not the repo, with that scratch prefix's `bin` on `PATH`:
  `reverie version` printed `0.7.0` and exited 0. `reverie doctor` against a real
  `~/.reverie/config.toml` on this machine reported all five checks passing, including the
  SQLite index check, though that check only confirms `index.db` exists on disk, not that
  `better-sqlite3` actually constructs a `Database`.
- The construction question was settled separately: `reverie --config <scratch config> doctor`
  against a fresh scratch memory folder, then `reverie --config <scratch config> web` started in
  the background and printed a bootstrap URL. `curl` against `/` returned 200,
  `content-type: text/html; charset=utf-8`, and the actual `index.html` body (confirming
  `resolveStaticDir`'s bundled-layout branch and `assertStaticDirectory` both ran correctly).
  `curl` against one of the JS asset paths named in that HTML returned 200,
  `content-type: text/javascript; charset=utf-8`, and a body byte count matching the file on
  disk exactly. This is the definitive check that `better-sqlite3` constructs correctly (through
  `MemoryEngine.open`) and that the web assets serve from the installed location, not just that
  the process started.
- The executable bit: `stat` showed `755` on `packages/cli/dist/index.js` after the first
  `pnpm build`, and again, unchanged, after a second `pnpm build` run back to back.
- `pnpm install --frozen-lockfile` from the repo root, the literal first step of both the CI and
  the publish workflow, succeeded after the manifest rewrites (`packages/cli/package.json`
  changed shape, `esbuild` added): "Lockfile is up to date, resolution step is skipped."
- `npx`. `npx --yes --package=<tarball> reverie version` printed `0.7.0`. More importantly,
  `npx --yes file:<tarball> version` (spec name `openreverie`, no `--package`, no explicit bin
  name) also printed `0.7.0`: npx installed the package under its own name, found it had exactly
  one bin (`reverie`) not matching that name, and ran it anyway. That is the same fallthrough a
  real `npx openreverie version` will use once the package is on the registry; name resolution
  against the registry is the only part this did not exercise.

## Not verified

- The GitHub Actions publish workflow itself has never run. It cannot be exercised without
  pushing a version tag, and this task was scoped not to push or tag. Configured with
  `permissions: id-token: write` at the job level and `actions/setup-node`'s `registry-url` set,
  which are the two concrete prerequisites for `--provenance` and for `NODE_AUTH_TOKEN` actually
  reaching npm; both are read from the workflow file, not exercised.
- Whether the real npm registry accepts a publish with `workspace:*` sitting in
  `devDependencies`. `npm pack` and `npm install` from a local tarball both behave exactly as
  expected (see above), but neither one is the registry itself; nothing here submits anything to
  a live registry.
- Windows and Linux. Everything above ran on macOS (arm64). `better-sqlite3` publishes prebuilt
  binaries for the common platforms, and nothing in the bundle or the static-dir fix is
  platform-specific in an obvious way, but the actual install-and-run pass was only done on one
  platform.

## Known rough edge

`files` in `packages/cli/package.json` does not list `scripts/`, so the published tarball
carries a `prepack` entry pointing at a file (`./scripts/bundle.mjs`) it does not itself contain.
This is harmless on every path that actually matters: a registry install (`npm i -g`, `npm i`,
`npx`) never runs `prepack` or `prepare` for a package it is installing as a dependency, only for
the root project being developed, and the tarball install was confirmed clean above. It would
only break `npm pack` run a second time directly against an already-unpacked, published copy of
the package, which is not a real usage path. Left as is rather than restructured.

## Left for the owner

Run `npm login`, then push a version tag (`v0.7.1` or whatever the next real release is) to
trigger `.github/workflows/publish.yml`. `NPM_TOKEN` needs to exist as a repository secret
first; this task did not create one.
