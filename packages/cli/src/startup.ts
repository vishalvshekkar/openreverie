// A dim, decorative spinner shown while MemoryEngine.open runs at CLI
// startup: it cycles through a handful of quiet, reflective phrases until
// the engine is open, then clears itself. It is deliberately not tied to
// the engine's internal phases (reflecting stale sessions, building
// rollups, draining legacy proposals, refreshing doc paths); the wait was
// silent before and the phrases only give the person watching the
// terminal something to read. Same mechanics as the status line: \r and
// \x1b[K so each phrase overwrites the last, the rotation advances on an
// injected interval, and everything is gated on colorEnabled so no escape
// sequence ever reaches a non-TTY stream.

const ANSI_DIM = '\x1b[2m'
const ANSI_RESET = '\x1b[0m'

// The approved phrases from the mode-at-launch spec. Keep the register
// quiet and reflective; do not add new ones or brighten the tone.
export const STARTUP_PHRASES = [
  'Getting my thoughts in order...',
  'Looking back...',
  'Contemplating past conversations...',
  'Tidying up loose ends...',
  'Making sense of things...',
  'Settling in...',
] as const

// Long enough for each phrase to be read, short enough that the rotation
// is clearly alive when the engine open takes a while.
export const PHRASE_INTERVAL_MS = 1500

export interface StartupSpinnerDeps {
  write: (text: string) => void
  colorEnabled: boolean
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

export interface StartupSpinner {
  start(): void
  stop(): void
}

export function createStartupSpinner(deps: StartupSpinnerDeps): StartupSpinner {
  if (!deps.colorEnabled) {
    return {
      start() {},
      stop() {},
    }
  }

  let handle: unknown
  let index = 0
  let active = false

  function render(): void {
    const phrase = STARTUP_PHRASES[index % STARTUP_PHRASES.length] ?? STARTUP_PHRASES[0]
    deps.write(`\r${ANSI_DIM}${phrase}${ANSI_RESET}\x1b[K`)
  }

  return {
    start() {
      if (active) {
        deps.clearInterval(handle)
      }
      index = 0
      active = true
      render()
      handle = deps.setInterval(() => {
        index += 1
        render()
      }, PHRASE_INTERVAL_MS)
    },
    stop() {
      if (!active) return
      deps.clearInterval(handle)
      handle = undefined
      active = false
      deps.write('\r\x1b[K')
    },
  }
}
