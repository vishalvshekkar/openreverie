#!/usr/bin/env node
// Builds the publishable openreverie CLI: a single bundled ESM file plus
// the web interface's built assets, copied next to it.
//
// This is the step that turns four workspace packages
// (@openreverie/core, memory, providers, server) plus this package's own
// source into the one file npm actually ships. better-sqlite3 stays
// external: it is a native module that resolves its compiled .node binary
// by walking the filesystem relative to its own package directory
// (lib/database.js), and bundling its JS would break that lookup.
//
// Runs on every root `pnpm build` (not just at publish time), and again
// automatically at `npm pack` / `npm publish` through the `prepack`
// script, so the executable bit and the bundle contents are a property of
// the build rather than a manual step someone has to remember.
//
// Assumes the workspace has already been built with `pnpm build`: it
// reads @openreverie/{core,memory,providers,server}'s compiled dist
// output and packages/web's built assets, and fails loudly if either is
// missing instead of silently shipping a broken package.

import { spawn } from 'node:child_process'
import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const cliDir = join(scriptsDir, '..')
const packagesDir = join(cliDir, '..')
const repoRoot = join(packagesDir, '..')

async function assertExists(path, hint) {
  try {
    await stat(path)
  } catch {
    throw new Error(`Missing ${path}. ${hint}`)
  }
}

async function main() {
  const webIndexHtml = join(packagesDir, 'web', 'dist', 'index.html')
  await assertExists(
    webIndexHtml,
    'Run `pnpm build` at the repo root first: it builds the web interface with vite.',
  )
  for (const name of ['core', 'memory', 'providers', 'server']) {
    const distEntry = join(packagesDir, name, 'dist', 'index.js')
    await assertExists(
      distEntry,
      'Run `pnpm build` at the repo root first: it compiles the workspace packages this bundle pulls in.',
    )
  }

  const outDir = join(cliDir, 'dist')
  const outfile = join(outDir, 'index.js')
  await mkdir(outDir, { recursive: true })

  await build({
    entryPoints: [join(cliDir, 'src', 'index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // better-sqlite3 is a native module: it resolves its compiled binary
    // relative to its own installed package directory at runtime
    // (lib/database.js), so it must stay a real, separately installed
    // dependency rather than bundled JS. Everything else this CLI
    // depends on (the four workspace packages, zod, gray-matter,
    // smol-toml, ulid) is pure JavaScript and safe to inline.
    external: ['better-sqlite3'],
    // gray-matter (a dependency of @openreverie/memory) reassigns
    // `exports` inside its own files, which forces esbuild to wrap it as
    // a CommonJS module rather than hoist its requires into static
    // imports. A wrapped module's require() calls, including for a node
    // builtin such as 'fs', go through esbuild's own runtime shim, which
    // only works if a real top-level `require` exists. An ESM file has
    // none by default, so without this banner every such call threw
    // "Dynamic require of ... is not supported" at module load time,
    // before any command ran: gray-matter is statically imported from
    // @openreverie/memory, so its top-level require('fs') executed while
    // the bundle's own module graph was being evaluated, ahead of argv
    // parsing. Every command failed identically, `reverie version`
    // included. This was caught by actually running the installed
    // tarball, not by reading the bundle. The smoke test below now
    // catches the same class of failure automatically, on every build.
    banner: {
      js: "import { createRequire as __openreverieCreateRequire } from 'node:module';\nconst require = __openreverieCreateRequire(import.meta.url);\n",
    },
    logLevel: 'info',
  })

  // esbuild preserves a leading `#!` shebang from the entry file, but
  // fix it in place explicitly rather than trust that silently: a build
  // that ever changed entry points would otherwise ship a bundle Node
  // refuses to run as a script with no obvious signal why.
  const bundled = await readFile(outfile, 'utf8')
  if (!bundled.startsWith('#!/usr/bin/env node\n')) {
    throw new Error(
      `${outfile} does not start with the expected shebang. The published binary would not run as a script.`,
    )
  }

  // tsc writes dist/index.js at mode 644; a plain `npm link` then breaks
  // because the file is not executable. Set the bit here, as part of the
  // build that produces the file, so it cannot regress on a later
  // rebuild the way a manual `chmod` after the fact would.
  await chmod(outfile, 0o755)

  // A smoke test, not a full check: actually run the bundle and confirm
  // it starts. This is what would have caught the gray-matter dynamic
  // require failure above at build time instead of only by installing
  // the tarball and running it by hand. `version` is used because it
  // needs no config file and no network access, so this stays fast and
  // deterministic on every build; it still exercises the entire bundle's
  // module graph, since every statically imported module (which is all
  // of them, including gray-matter through @openreverie/memory) runs at
  // load time, before argv is even parsed.
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [outfile, 'version'], { stdio: 'pipe' })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(undefined)
      } else {
        reject(new Error(`${outfile} version exited ${code}, the bundle does not run.\n${stderr}`))
      }
    })
  })

  const webDistDir = join(packagesDir, 'web', 'dist')
  const bundledWebDir = join(outDir, 'web')
  await rm(bundledWebDir, { recursive: true, force: true })
  await cp(webDistDir, bundledWebDir, { recursive: true })

  await writeFile(join(cliDir, 'README.md'), await readFile(join(repoRoot, 'README.md')))
  await writeFile(join(cliDir, 'LICENSE'), await readFile(join(repoRoot, 'LICENSE')))
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
