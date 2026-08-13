// Best-effort git versioning of the memory folder. Every call inits a repo
// if one is missing, stages everything, and commits. This is a convenience
// layer, not a required dependency: any failure is swallowed into a
// warning and the function never throws.

import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface CommitResult {
  ok: boolean
  warning?: string
}

export async function commitMemory(root: string, message: string): Promise<CommitResult> {
  if (!(await isDirectory(root))) {
    return { ok: false, warning: `Memory root ${root} is not a directory; skipped git commit.` }
  }

  try {
    if (!(await isDirectory(join(root, '.git')))) {
      await git(root, ['init', '-q'])
      await git(root, ['config', 'user.name', 'reverie'])
      await git(root, ['config', 'user.email', 'reverie@local'])
    }

    await git(root, ['add', '-A'])

    const status = await git(root, ['status', '--porcelain'])
    if (status.stdout.trim().length === 0) {
      return { ok: true }
    }

    await git(root, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message])
    return { ok: true }
  } catch (err) {
    return { ok: false, warning: `git commit failed: ${errorMessage(err)}` }
  }
}

async function git(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run('git', args, { cwd: root })
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
