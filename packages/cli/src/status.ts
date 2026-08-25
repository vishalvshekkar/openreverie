// A dim, animated status line shown between the end of the user's turn
// and the first real output: "thinking" while the model is working,
// or the honest tool label while a tool call is in flight. It writes
// through the same write funnel as everything else in the REPL, using
// \r and \x1b[K so each frame overwrites the last instead of scrolling
// the terminal. Frames advance on an injected setInterval and elapsed
// time is read from an injected clock, so tests never wait on a real
// timer.
//
// Gated entirely on colorEnabled: when the caller is not a color-capable
// TTY, start() and stop() do nothing at all, and no interval is ever
// registered. This preserves the existing invariant that no escape
// sequence reaches a non-TTY stream.

const ANSI_DIM = '\x1b[2m'
const ANSI_RESET = '\x1b[0m'
const FRAMES = ['|', '/', '-', '\\']
const FRAME_INTERVAL_MS = 120
const ELAPSED_THRESHOLD_MS = 3000

export interface StatusLineDeps {
  write: (text: string) => void
  colorEnabled: boolean
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
  now: () => number
}

export interface StatusLine {
  start(label: string): void
  stop(): void
  // True when start()/stop() actually render an animated frame (a
  // color-capable TTY). False in the no-op case (piped, non-TTY, or
  // color disabled), where start() and stop() do nothing at all and no
  // interval is ever registered. A caller that needs to know whether a
  // transient in-flight signal is actually visible to the person (so it
  // can fall back to a permanent one when it is not) asks this, rather
  // than re-deriving the same colorEnabled check itself: the status line
  // is the thing that actually knows whether it renders.
  readonly canRender: boolean
}

export function createStatusLine(deps: StatusLineDeps): StatusLine {
  if (!deps.colorEnabled) {
    return {
      start() {},
      stop() {},
      canRender: false,
    }
  }

  let handle: unknown
  let label = ''
  let startedAt = 0
  let frame = 0
  let active = false

  function render(): void {
    const elapsedMs = deps.now() - startedAt
    const text =
      elapsedMs >= ELAPSED_THRESHOLD_MS ? `${label} (${Math.floor(elapsedMs / 1000)}s)` : label
    const line = `${FRAMES[frame % FRAMES.length]} ${text}`
    deps.write(`\r${ANSI_DIM}${line}${ANSI_RESET}\x1b[K`)
  }

  return {
    start(nextLabel: string) {
      if (active) {
        deps.clearInterval(handle)
      }
      label = nextLabel
      startedAt = deps.now()
      frame = 0
      active = true
      render()
      handle = deps.setInterval(() => {
        frame += 1
        render()
      }, FRAME_INTERVAL_MS)
    },
    stop() {
      if (!active) return
      deps.clearInterval(handle)
      handle = undefined
      active = false
      deps.write('\r\x1b[K')
    },
    canRender: true,
  }
}
