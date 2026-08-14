import { describe, expect, it } from 'vitest'
import { createStatusLine } from './status.js'

function fakeDeps(colorEnabled = true) {
  const output: string[] = []
  const intervals: Array<() => void> = []
  let clearedCount = 0
  let nowValue = 0
  return {
    output,
    intervals,
    setNow: (value: number) => {
      nowValue = value
    },
    tick: (index = 0) => {
      intervals[index]?.()
    },
    clearedCount: () => clearedCount,
    deps: {
      write: (text: string) => output.push(text),
      colorEnabled,
      setInterval: (fn: () => void, _ms: number) => {
        intervals.push(fn)
        return intervals.length
      },
      clearInterval: (_handle: unknown) => {
        clearedCount += 1
      },
      now: () => nowValue,
    },
  }
}

describe('createStatusLine', () => {
  it('advances frames on the injected interval, not a real timer', () => {
    const { deps, output, tick } = fakeDeps()
    const status = createStatusLine(deps)

    status.start('thinking')
    expect(output).toHaveLength(1)
    expect(output[0]).toContain('thinking')

    tick()
    tick()

    expect(output).toHaveLength(3)
    expect(output[0]).not.toBe(output[1])

    status.stop()
  })

  it('gains an elapsed seconds counter once three seconds have passed on the injected clock', () => {
    const { deps, output, tick, setNow } = fakeDeps()
    const status = createStatusLine(deps)

    status.start('thinking')
    setNow(3200)
    tick()

    expect(output[output.length - 1]).toContain('thinking (3s)')

    status.stop()
  })

  it('writes nothing at all and registers no interval when colorEnabled is false', () => {
    const { deps, output, intervals } = fakeDeps(false)
    const status = createStatusLine(deps)

    status.start('thinking')
    status.stop()

    expect(output).toHaveLength(0)
    expect(intervals).toHaveLength(0)
  })

  it('clears the line with a bare carriage return and erase before any real output follows', () => {
    const { deps, output } = fakeDeps()
    const status = createStatusLine(deps)

    status.start('thinking')
    status.stop()

    expect(output[output.length - 1]).toBe('\r\x1b[K')
  })

  it('clears the previous interval before registering a new one when start() is called twice without an intervening stop()', () => {
    const { deps, clearedCount } = fakeDeps()
    const status = createStatusLine(deps)

    status.start('thinking')
    status.start('searching memory')

    expect(clearedCount()).toBe(1)

    status.stop()
  })
})
