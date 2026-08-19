// The startup spinner is decorative: it cycles through a handful of quiet,
// reflective phrases while MemoryEngine.open runs, then clears itself. It
// is deliberately not tied to any internal engine phase. These tests drive
// the phrase rotation with vitest's fake timers, so they never wait on a
// real interval, and they write through an injected buffer instead of a
// real terminal, mirroring status.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStartupSpinner, PHRASE_INTERVAL_MS, STARTUP_PHRASES } from './startup.js'

afterEach(() => {
  vi.useRealTimers()
})

function fakeDeps(colorEnabled = true) {
  const output: string[] = []
  return {
    output,
    deps: {
      write: (text: string) => output.push(text),
      colorEnabled,
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clearInterval: (handle: unknown) =>
        clearInterval(handle as Parameters<typeof clearInterval>[0]),
    },
  }
}

describe('createStartupSpinner', () => {
  it('cycles through every approved phrase while running, one per interval', () => {
    vi.useFakeTimers()
    const { output, deps } = fakeDeps()
    const spinner = createStartupSpinner(deps)

    spinner.start()
    // The first phrase renders immediately, before any interval fires.
    expect(output[0]).toContain('Getting my thoughts in order...')

    // One full cycle: six phrases at one per interval.
    vi.advanceTimersByTime(PHRASE_INTERVAL_MS * STARTUP_PHRASES.length)

    expect(output).toHaveLength(1 + STARTUP_PHRASES.length)
    for (const phrase of STARTUP_PHRASES) {
      expect(output.some((line) => line.includes(phrase))).toBe(true)
    }

    spinner.stop()
  })

  it('stops advancing phrases once stopped, and clears the line', () => {
    vi.useFakeTimers()
    const { output, deps } = fakeDeps()
    const spinner = createStartupSpinner(deps)

    spinner.start()
    vi.advanceTimersByTime(PHRASE_INTERVAL_MS * 2)
    const linesBeforeStop = output.length
    spinner.stop()

    expect(output[output.length - 1]).toBe('\r\x1b[K')
    expect(vi.getTimerCount()).toBe(0)

    // Time after stop keeps passing; nothing more is ever written.
    vi.advanceTimersByTime(PHRASE_INTERVAL_MS * 2)
    expect(output).toHaveLength(linesBeforeStop + 1)
  })

  it('writes nothing and registers no interval when colorEnabled is false', () => {
    vi.useFakeTimers()
    const { output, deps } = fakeDeps(false)
    const spinner = createStartupSpinner(deps)

    spinner.start()
    spinner.stop()

    expect(output).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
