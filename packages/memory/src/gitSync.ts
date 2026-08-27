// Best-effort git versioning of the memory folder. Every call inits a repo
// if one is missing, stages everything, and commits. This is a convenience
// layer, not a required dependency: any failure is swallowed into a
// warning and the function never throws.
//
// The git invocation itself (child_process) is left alone: P0-1 is about
// filesystem access, and there is no injected interface for shelling out to
// git. Its one fs call (checking that root, and root/.git, are directories)
// is converted below.
//
// commitMemory itself is gated on FileStore.capabilities.versioning, so a
// host with no git skips all of this entirely; see the comment at the top
// of commitMemory for why the gate lives here rather than at each caller.

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { FileStore } from './store.js'

const run = promisify(execFile)

export interface CommitResult {
  ok: boolean
  warning?: string
}

export async function commitMemory(
  files: FileStore,
  root: string,
  message: string,
): Promise<CommitResult> {
  // Gated on capabilities.versioning as the very first statement, before
  // the isDirectory check below, so a host with no git (a machine with no
  // filesystem at all) never pays for that storage query and never shells
  // out to git. This mirrors the same flag's use in paths.ts to skip
  // seeding .gitignore, and putting the guard here instead of at engine.ts's
  // seven call sites means every one of them, plus any future caller, is
  // covered by one check at the source rather than by seven people
  // remembering to add it.
  //
  // Returns ok: true with no warning, not ok: false. A host with no
  // versioning capability has nothing wrong with it: git auto-commit was
  // never applicable there, the same way an unchanged working tree already
  // returns ok: true below with no commit made. ok: false is reserved for
  // an attempt that was made and failed. Every engine.ts call site only
  // surfaces commitResult.warning when !commitResult.ok, so a false result
  // here with no warning would still read silently, but it would also
  // misreport a no-op as a failure to whatever future caller inspects `ok`
  // on its own. Returning ok: true keeps that distinction honest without
  // relying on nobody ever reading `ok` in isolation.
  if (!files.capabilities.versioning) {
    return { ok: true }
  }

  if (!(await isDirectory(files, root))) {
    return { ok: false, warning: `Memory root ${root} is not a directory; skipped git commit.` }
  }

  try {
    if (!(await isDirectory(files, join(root, '.git')))) {
      await git(root, ['init', '-q'])
      await git(root, ['config', 'user.name', 'reverie'])
      await git(root, ['config', 'user.email', 'reverie@local'])
    }

    await git(root, ['add', '-A'])

    const status = await git(root, ['status', '--porcelain'])
    if (status.stdout.trim().length === 0) {
      return { ok: true }
    }

    await git(root, [
      '-c',
      'user.name=reverie',
      '-c',
      'user.email=reverie@local',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      message,
    ])
    return { ok: true }
  } catch (err) {
    return { ok: false, warning: `git commit failed: ${errorMessage(err)}` }
  }
}

// Every git invocation this module makes gets -c gc.auto=0, so that
// git commit (and git add/git init under some conditions) never triggers
// a detached `git gc --auto` fork. That fork's own writes into
// .git/objects/pack are not guaranteed to have finished by the time the
// awaited execFile call resolves, which is the actual mechanism behind
// an ENOTEMPTY race against a test's own `rm -rf` on the same directory
// right after engine.close(). See
// docs/superpowers/specs/2026-08-16-cli-polish-and-ci-fix-design.md
// section 2.2. Extracted as its own pure function so the flag's presence
// is directly testable without mocking child_process.
export function gitArgs(args: string[]): string[] {
  return ['-c', 'gc.auto=0', ...args]
}

async function git(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run('git', gitArgs(args), { cwd: root })
}

// FileStore.stat carries no is-a-directory flag (the frozen interface only
// exposes mtimeMs and size), so this narrows from a real directory check to
// existence. In practice that only changes behavior in a corner case
// neither caller of commitMemory can hit: root and root/.git are always
// directories when they exist, since ensureMemoryTree and `git init` are
// the only things that ever create them, and this whole function already
// swallows any downstream failure into a warning rather than throwing.
async function isDirectory(files: FileStore, path: string): Promise<boolean> {
  return files.exists(path)
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
