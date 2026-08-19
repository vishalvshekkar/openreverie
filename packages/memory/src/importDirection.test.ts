// The dependency rule in AGENTS.md is downward only: core depends on
// memory, never the reverse. This test fails the build the moment any
// file in @openreverie/memory reaches up into @openreverie/core, which is
// exactly what moving StyleConfig down here exists to prevent.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_DIR = new URL('.', import.meta.url).pathname

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(full)))
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(full)
    }
  }
  return files
}

describe('memory package import direction', () => {
  it('never imports from @openreverie/core', async () => {
    // Excludes this file itself: its own source has to spell out the
    // import syntax it looks for, which would otherwise always flag itself.
    const files = (await collectSourceFiles(SRC_DIR)).filter(
      (file) => !file.endsWith('importDirection.test.ts'),
    )
    expect(files.length).toBeGreaterThan(5)
    const offenders: string[] = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      // Matches the quoted module specifier, which covers a static import,
      // a dynamic import() and a require() alike. Matching only "from '...'"
      // would let a dynamic import through. Prose that explains the
      // dependency direction names the package without quoting it as a
      // specifier, so an explanatory comment does not trip this.
      if (text.includes("'@openreverie/core'")) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('owns StyleConfig itself rather than re-exporting it from elsewhere', async () => {
    const text = await readFile(join(SRC_DIR, 'style.ts'), 'utf8')
    expect(text).toContain('export interface StyleConfig')
  })
})
