import { describe, expect, it } from 'vitest'
import { createStatusLine } from './status.js'

function fakeDeps(colorEnabled = true) {
  const output: string[] = []
  const intervals: Array<() => void> = []
  const clearedHandles: unknown[] = []
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
    clearedHandles,
    deps: {
      write: (text: string) => output.push(text),
      colorEnabled,
      setInterval: (fn: () => void, _ms: number) => {
        intervals.push(fn)
        // A distinguishable handle per call (1, 2, 3, ...), not a constant,
        // so a test can assert exactly which registration was cleared
        // instead of only how many times clearInterval ran.
        return intervals.length
      },
      clearInterval: (handle: unknown) => {
        clearedHandles.push(handle)
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

  it('clears the exact handle the first start() registered, not just some handle, when start() is called twice without an intervening stop()', () => {
    const { deps, clearedHandles } = fakeDeps()
    const status = createStatusLine(deps)

    status.start('thinking')
    status.start('searching memory')

    // Handle 1 is the first start()'s interval; an implementation that
    // cleared the wrong one (for instance the handle it is about to
    // register next, which does not exist yet) would leak the first
    // interval and this would not catch it if it only counted calls.
    expect(clearedHandles).toEqual([1])

    status.stop()

    expect(clearedHandles).toEqual([1, 2])
  })
})
