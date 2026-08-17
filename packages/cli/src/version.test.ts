import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { readOwnVersion } from './version.js'

describe('readOwnVersion', () => {
  it('matches the version field in packages/cli/package.json, read independently', async () => {
    const manifest = new URL('../package.json', import.meta.url)
    const expected = JSON.parse(await readFile(manifest, 'utf8')).version
    expect(readOwnVersion()).toBe(expected)
  })
})
