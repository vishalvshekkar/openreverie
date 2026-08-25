import { describe, expect, it } from 'vitest'
import { subcommandHelp, TOP_LEVEL_HELP } from './help.js'

describe('TOP_LEVEL_HELP', () => {
  it('matches the exact layout specified in the CLI polish spec', () => {
    expect(TOP_LEVEL_HELP).toBe(
      `reverie: a self-hosted companion agent with a memory that does not forget.

Usage: reverie [command] [options]

Commands:
  (none)          Start the terminal chat REPL.
  setup           Run the first-run setup wizard.
  web             Start the local web interface.
  read [target]   Print part of your memory record from disk. No network call.
  reindex         Rebuild the SQLite search index from the memory folder.
  reflect         Run maintenance now (reflect stale sessions, build rollups).
  dream           Run, preview, list, or read dreams.
  doctor          Check config, provider, and memory folder health.
  version         Print the installed version.
  help [command]  Show this message, or help for one command.

Options:
  -v, --version   Print the installed version.
  -h, --help      Show this message.
  --config <path> Use a config file at this path instead of the default.

Run 'reverie help <command>' for details on a specific command.
`,
    )
  })
})

describe('subcommandHelp', () => {
  it('returns the exact reflect help block', () => {
    expect(subcommandHelp('reflect')).toBe(
      `reverie reflect

Runs maintenance immediately: reflects any stale unreflected sessions and builds any
daily or weekly rollups that are due, instead of waiting for it to happen automatically
on next chat start. Requires a working config and a reachable model provider.

Usage: reverie reflect [--config <path>]
`,
    )
  })

  it('returns the exact dream help block', () => {
    expect(subcommandHelp('dream')).toBe(
      `reverie dream

Runs a dream now, honoring your dreaming settings, if one is due: at least 5 reflected
sessions, dreaming turned on, and the current period not already covered. Prints the
outcome, or a plain reason why it did not run.

Usage: reverie dream [--force | --dry-run | --list | --show <dreamId>] [--config <path>]

  --force             Run even when dreaming is off or the current period is already covered.
  --dry-run           Print the period, dueness, seeds with their weights, and the walk.
                      Makes no model calls and spends nothing.
  --list              List past dreams: date, period, insight count, narrative present.
  --show <dreamId>    Print one dream's narrative, its insight headlines with any feedback,
                      and the path to its process log.
`,
    )
  })

  it('returns the exact doctor help block', () => {
    expect(subcommandHelp('doctor')).toBe(
      `reverie doctor

Checks whether reverie is set up correctly: config file present and valid, API key
resolvable, memory folder present and writable, memory folder's git state, and SQLite
index present and rebuildable. Never prints secret values. Exits non-zero if any check
fails.

Usage: reverie doctor [--config <path>]
`,
    )
  })

  it('returns the exact read help block, including its argument forms', () => {
    expect(subcommandHelp('read')).toBe(
      `reverie read [target]

Prints part of your memory record straight from the files on disk. No network call,
no engine, no provider: this works even when the provider is offline or unconfigured.

With no arguments, lists your constitution, arcs, realms, and people. Other forms:
  reverie read constitution     Print the constitution in full.
  reverie read arc <name>       Print one arc by a case-insensitive substring match.
  reverie read realm <name>     Print one realm the same way.
  reverie read person <name>    Print one person the same way.

Usage: reverie read [constitution | arc <name> | realm <name> | person <name>] [--config <path>]
`,
    )
  })

  it('returns undefined for an unknown command name', () => {
    expect(subcommandHelp('bogus')).toBeUndefined()
  })

  it('has a help block for every command listed in the top-level Commands section', () => {
    const names = [
      'setup',
      'web',
      'read',
      'reindex',
      'reflect',
      'dream',
      'doctor',
      'version',
      'help',
    ]
    for (const name of names) {
      expect(subcommandHelp(name)).toBeDefined()
    }
  })
})
