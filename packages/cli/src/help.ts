// Exact help text for `reverie --help`/`-h`/`help` and `reverie help
// <command>`/`reverie <command> --help`. See
// docs/superpowers/specs/2026-08-16-cli-polish-and-ci-fix-design.md
// section 1.3 for the required top-level layout and the reflect/doctor
// examples this module's other blocks follow the shape of. Each
// per-subcommand block restates what README.md's Usage section already
// says about that command, rather than diverging from it.

export const TOP_LEVEL_HELP = `reverie: a self-hosted companion agent with a memory that does not forget.

Usage: reverie [command] [options]

Commands:
  (none)          Start the terminal chat REPL.
  setup           Run the first-run setup wizard.
  web             Start the local web interface.
  read [target]   Print part of your memory record from disk. No network call.
  reindex         Rebuild the SQLite search index from the memory folder.
  reflect         Run maintenance now (reflect stale sessions, build rollups).
  doctor          Check config, provider, and memory folder health.
  version         Print the installed version.
  help [command]  Show this message, or help for one command.

Options:
  -v, --version   Print the installed version.
  -h, --help      Show this message.
  --config <path> Use a config file at this path instead of the default.

Run 'reverie help <command>' for details on a specific command.
`

const SUBCOMMAND_HELP: Record<string, string> = {
  setup: `reverie setup

Runs the first-run setup wizard: asks for your provider API key, your safety mode,
and where you want your memory folder to live, then writes a config file. Run it
once before anything else.

Usage: reverie setup [--config <path>]
`,
  web: `reverie web

Starts the local web interface and prints its bootstrap URL. The server listens on
127.0.0.1 only, so only processes on your own machine can reach it. Copy the printed
URL into your browser to start; this command does not open the browser for you.

Usage: reverie web [--config <path>]
`,
  read: `reverie read [target]

Prints part of your memory record straight from the files on disk. No network call,
no engine, no provider: this works even when the provider is offline or unconfigured.

With no arguments, lists your constitution, arcs, realms, and people. Other forms:
  reverie read constitution     Print the constitution in full.
  reverie read arc <name>       Print one arc by a case-insensitive substring match.
  reverie read realm <name>     Print one realm the same way.
  reverie read person <name>    Print one person the same way.

Usage: reverie read [constitution | arc <name> | realm <name> | person <name>] [--config <path>]
`,
  reindex: `reverie reindex

Rebuilds the SQLite search index from your memory folder from scratch. Safe to run
any time: the index is always derived and disposable, never a source of truth.

Usage: reverie reindex [--config <path>]
`,
  reflect: `reverie reflect

Runs maintenance immediately: reflects any stale unreflected sessions and builds any
daily or weekly rollups that are due, instead of waiting for it to happen automatically
on next chat start. Requires a working config and a reachable model provider.

Usage: reverie reflect [--config <path>]
`,
  doctor: `reverie doctor

Checks whether reverie is set up correctly: config file present and valid, API key
resolvable, memory folder present and writable, memory folder's git state, and SQLite
index present and rebuildable. Never prints secret values. Exits non-zero if any check
fails.

Usage: reverie doctor [--config <path>]
`,
  version: `reverie version

Prints the installed version and exits. Same as reverie --version or reverie -v.

Usage: reverie version
`,
  help: `reverie help

Shows the top-level command list, or details for one command.

Usage: reverie help [command]
`,
}

export function subcommandHelp(name: string): string | undefined {
  return SUBCOMMAND_HELP[name]
}
