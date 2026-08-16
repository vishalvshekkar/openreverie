import { describe, expect, it } from 'vitest'
import { clearPositions, loadPositions, savePositions } from './positions.js'

class FakeStorage implements Storage {
  private store = new Map<string, string>()

  get length(): number {
    return this.store.size
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }
}

class ThrowingStorage implements Storage {
  readonly length = 0

  getItem(): never {
    throw new Error('storage unavailable')
  }

  setItem(): never {
    throw new Error('storage unavailable')
  }

  removeItem(): never {
    throw new Error('storage unavailable')
  }

  clear(): never {
    throw new Error('storage unavailable')
  }

  key(): never {
    throw new Error('storage unavailable')
  }
}

describe('positions storage', () => {
  it('round trips saved positions through the same storage key', () => {
    const storage = new FakeStorage()
    savePositions({ 'person:ada': { x: 12, y: -4 } }, storage)

    expect(loadPositions(storage)).toEqual({ 'person:ada': { x: 12, y: -4 } })
  })

  it('returns an empty object when nothing has been saved', () => {
    const storage = new FakeStorage()
    expect(loadPositions(storage)).toEqual({})
  })

  it('drops corrupt JSON and returns an empty object', () => {
    const storage = new FakeStorage()
    storage.setItem('openreverie.atlas.positions', '{not json')

    expect(loadPositions(storage)).toEqual({})
  })

  it('drops a value with the wrong shape and returns an empty object', () => {
    const storage = new FakeStorage()
    storage.setItem('openreverie.atlas.positions', '[1, 2, 3]')
    expect(loadPositions(storage)).toEqual({})

    storage.setItem('openreverie.atlas.positions', '"just a string"')
    expect(loadPositions(storage)).toEqual({})
  })

  it('drops individual entries whose coordinates are not finite numbers', () => {
    const storage = new FakeStorage()
    storage.setItem(
      'openreverie.atlas.positions',
      JSON.stringify({
        'person:ada': { x: 1, y: 2 },
        'person:bad-string': { x: 'nope', y: 2 },
        'person:bad-nan': { x: Number.NaN, y: 2 },
        'person:missing-y': { x: 1 },
      }),
    )

    expect(loadPositions(storage)).toEqual({ 'person:ada': { x: 1, y: 2 } })
  })

  it('returns an empty object instead of throwing when getItem throws', () => {
    expect(loadPositions(new ThrowingStorage())).toEqual({})
  })

  it('returns an empty object instead of throwing when setItem throws', () => {
    expect(() =>
      savePositions({ 'person:ada': { x: 1, y: 2 } }, new ThrowingStorage()),
    ).not.toThrow()
  })

  it('never serializes non-finite coordinates', () => {
    const storage = new FakeStorage()
    savePositions(
      {
        'person:ada': { x: 17, y: -8 },
        'person:invalid': { x: Number.NaN, y: Number.POSITIVE_INFINITY },
      },
      storage,
    )

    expect(JSON.parse(storage.getItem('openreverie.atlas.positions') ?? '{}')).toEqual({
      'person:ada': { x: 17, y: -8 },
    })
  })

  it('keeps stale node ids in the loaded result without erroring', () => {
    const storage = new FakeStorage()
    savePositions(
      { 'person:retracted-long-ago': { x: 3, y: 4 }, 'person:ada': { x: 1, y: 1 } },
      storage,
    )

    // positions.ts has no knowledge of which nodes currently exist in the
    // graph; it is layout.ts's job (via `known`) to only look up ids that
    // are present, so a stale entry simply never gets read. Round-tripping
    // it back out unfiltered here proves loadPositions never throws or
    // crashes on data it can no longer place.
    expect(loadPositions(storage)).toEqual({
      'person:retracted-long-ago': { x: 3, y: 4 },
      'person:ada': { x: 1, y: 1 },
    })
  })

  it('clears the stored key without throwing on a throwing storage', () => {
    const storage = new FakeStorage()
    savePositions({ 'person:ada': { x: 1, y: 1 } }, storage)
    clearPositions(storage)
    expect(loadPositions(storage)).toEqual({})

    expect(() => clearPositions(new ThrowingStorage())).not.toThrow()
  })
})
