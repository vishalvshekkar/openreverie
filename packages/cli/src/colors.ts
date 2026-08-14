// Raw ANSI escapes, no dependency. Every helper here takes an explicit
// `enabled` flag rather than sniffing process.stdout.isTTY or NO_COLOR
// itself: that sniffing happens once, at the edge, in index.ts, and gets
// threaded down as a plain boolean. That keeps these functions (and the
// tests that exercise them) free of any dependency on real process state.
const ANSI_RESET = '\x1b[0m'
const ANSI_DIM = '\x1b[2m'
const ANSI_CYAN = '\x1b[36m'
const ANSI_MAGENTA = '\x1b[35m'

function colorize(code: string, text: string, enabled: boolean): string {
  return enabled ? `${code}${text}${ANSI_RESET}` : text
}

// Tool notices and warning notes: dim gray, easy to skim past.
export function dim(text: string, enabled = false): string {
  return colorize(ANSI_DIM, text, enabled)
}

// The user's own prompt.
export function cyan(text: string, enabled: boolean): string {
  return colorize(ANSI_CYAN, text, enabled)
}

// reverie's speaker tag. Soft magenta rather than a bright or bold color,
// so it reads clearly without fighting the terminal's own foreground on
// either a light or a dark background.
export function magenta(text: string, enabled: boolean): string {
  return colorize(ANSI_MAGENTA, text, enabled)
}
