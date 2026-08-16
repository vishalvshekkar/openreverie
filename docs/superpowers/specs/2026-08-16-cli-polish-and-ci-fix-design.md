# CLI polish and CI flake fix design

Date: 2026-08-16
Status: proposed
Target release: v0.6.0 (tentative, no release has been cut for this scope yet)
Scope: two unrelated pieces of small, practical work bundled into one spec because each is too
small to justify its own document. Part 1 rounds out the CLI's operator-facing surface (version,
help, doctor, exit codes, config override, error handling). Part 2 fixes a real CI failure on
`main` that is a test-isolation flake, not a code defect.

This is the smallest of four parallel specs written the same day. It does not touch persona
behavior, memory format, or the web interface.

## Part 1: CLI polish

### 1.1 Current CLI surface, verified

`packages/cli/src/index.ts:119-181`, `mainWith()`, dispatches on `args[0]` with a chain of
string-equality checks:

- `setup` -> `runSetupCommand()` (`packages/cli/src/setup.ts`), the first-run wizard.
- `web` -> `runWebCommand()` (`packages/cli/src/web.ts`), starts the local server.
- `read` -> `runRead()` (`packages/cli/src/read.ts`), filesystem-only, no engine, no provider.
  Already returns an integer exit code (`packages/cli/src/read.ts`; confirmed by grep, every one
  of its 26 `return` statements is `return 0` or `return 1`, no other exit values appear).
- `reindex` and `reflect` -> both open a full `MemoryEngine` and a provider via
  `openCliContext()` (`packages/cli/src/chat.ts:358-386`) first.
- any other value of `args[0]`, including `undefined` -> falls through to the chat REPL branch.
  **This is the actual bug this spec fixes first**: `reverie --version`, `reverie --help`, and a
  genuine typo like `reverie reflcet` all currently fall through to `openCliContext()`, which
  loads config, resolves the API key, and opens the memory engine, then start the interactive
  chat loop. A typo today costs a provider round-trip and an unwanted chat session instead of a
  one-line error.

`openCliContext()` (`packages/cli/src/chat.ts:358-386`) collapses three distinct failure kinds
into one undifferentiated shape:

```ts
export async function openCliContext(deps: CliEngineDeps): Promise<CliContextResult> {
  let config: ReverieConfig
  try {
    config = await deps.loadConfig()
  } catch (err) {
    return { ok: false, message: errorMessage(err) }
  }
  // ... buildChat/buildEmbeddings failures -> same { ok: false, message } shape
  // ... engine.open() failures -> same { ok: false, message } shape
}
```

All three become `process.exitCode = 1` in `mainWith()` (`index.ts:151-155`). There is currently
no way for a caller (a script, a systemd unit, a person scripting around `reverie`) to tell "your
config file is broken" from "the provider is unreachable" from "everything parsed fine but
something else failed." This spec's exit code table (1.5) requires distinguishing them, which
means `CliContextResult`'s failure variant needs a `kind` field, not just a `message` string.

Config loading: `loadConfig(configPath?: string)` (`packages/core/src/config.ts:111-128`) already
accepts an optional explicit path and falls back to `defaultConfigPath()`
(`packages/core/src/config.ts:107-109`, `~/.reverie/config.toml`) only when the argument is
omitted. `mainWith()` never passes a path through; every call site uses `deps.configPath =
defaultConfigPath()` fixed at `index.ts:196`. So the plumbing for a config path override already
exists one layer down. `--config <path>` (1.6) is wiring, not new capability, in `core`.

`resolveApiKey()` (`packages/core/src/config.ts:160-176`) never returns or logs the key itself on
the success path; on failure it names the env var it looked for, never a value. `doctor` (1.4)
must preserve that: report whether a key resolved, never what it is.

Readline-backed `ChatIo` (`index.ts:59-87`, `readlineChatIo()`) and `runChat`
(`packages/cli/src/chat.ts:141-175` onward) are unchanged by this spec. The setup wizard
(`packages/cli/src/setup.ts`) is unchanged.

No argument-parsing library is currently a direct dependency anywhere in this repo. `cac` and
`minimist` appear in `pnpm-lock.yaml` only as transitive dependencies of `vite` and other
dev tooling (verified: `grep -n "cac\|minimist" pnpm-lock.yaml` shows them nested under other
packages' dependency blocks, not under `packages/cli/package.json`, which lists only the four
`@openreverie/*` workspace packages as dependencies). All argument handling in `index.ts` today is
hand-rolled `if`/`else` string comparison. See 1.7 for whether to keep it that way.

### 1.2 `--version`, `-v`, and `version`

Behavior: any of `reverie --version`, `reverie -v`, or `reverie version` prints the package
version and exits `0`, doing no config load, no engine open, no network call. Checked before
subcommand dispatch, so it wins even if combined with other garbage arguments (`reverie
--version --config /bogus` still just prints the version).

Output: the bare version string, no prefix, no name, matching the convention of `node --version`
and `git --version` piping cleanly into scripts:

```
0.5.0
```

Sourcing the version, verified mechanism: `packages/cli/package.json` currently pins `"version":
"0.5.0"` and is a plain `"type": "module"` package built by `tsc -b` with no bundler (confirmed:
`packages/cli/tsconfig.json` sets `rootDir: "src"`, `outDir: "dist"`, and `packages/cli/package.json`'s
`build` script is exactly `tsc -b`, nothing else). Hardcoding the version string in source is
rejected: it drifts from `package.json` the moment either changes and nothing catches it (the
existing `packages/cli/src/release.test.ts` only asserts every manifest's `version` field is
`0.5.0`; it says nothing about a hardcoded string in `index.ts`, which is a second place someone
would have to remember to bump).

The mechanism that actually works in this build: read `package.json` from disk relative to the
compiled module's own location, at runtime, not at build time:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

function readOwnVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string }
  return pkg.version
}
```

Why `../package.json` relative to the compiled file is correct and durable, not a guess: `tsc -b`
with `rootDir: src` / `outDir: dist` and no bundler preserves the source tree shape one-to-one, so
`packages/cli/dist/index.js` sits exactly one directory below `packages/cli/package.json`, both in
a local dev checkout and inside the published npm tarball (`packages/cli/package.json`'s `files`
field is `["dist"]`; npm always includes the manifest itself regardless of `files`, so
`package.json` ships next to `dist/` in every install shape: local build, `npm link`, or a global
install). This is the same relative-path pattern the codebase already trusts elsewhere: `release.test.ts`
derives repo root from `import.meta.url` with the identical justification (documented in that
file's own comment, quoted in 1.1).

Two things this rules out, stated so a reviewer does not have to rediscover them:

- `import pkg from '../package.json' with { type: 'json' }` (a JSON import attribute) would avoid
  the manual `readFileSync`, but it couples the compiled output's import graph to a JSON file
  outside `rootDir`, which `tsc -b`'s project-reference build does not resolve the same way across
  every Node version this repo supports (`engines.node >= 22` per the root `package.json`, but
  import attributes for JSON were stabilizing across that exact version range and behavior varies
  by minor version). `readFileSync` at runtime has no such version sensitivity. Reject the import
  form.
- Reading `process.env.npm_package_version` is rejected outright: it is only set when the process
  is actually invoked by npm/pnpm as a script, never when a user runs `reverie` or `reverie
  --version` directly from a shell or a global install, which is the common case for this CLI.

Testing: a unit test on the extracted `readOwnVersion()` function (or equivalent), run against the
real `packages/cli/package.json` on disk (same pattern `release.test.ts` already uses:
`import.meta.url`-relative reads, not a mock filesystem), asserting the returned string equals
`JSON.parse(await readFile('package.json')).version`. This makes the test fail the moment the two
values diverge, by construction, rather than by someone remembering to update a second literal.

### 1.3 `--help`, `-h`, and per-subcommand help

Behavior: `reverie --help`, `reverie -h`, or `reverie help` prints top-level help and exits `0`.
`reverie <subcommand> --help` or `reverie help <subcommand>` prints that subcommand's help and
exits `0`. Same precedence rule as `--version`: checked before the subcommand tries to do
anything real, so `reverie reflect --help` never opens an engine.

Top-level help text layout (exact):

```
reverie: a self-hosted companion agent with a memory that does not forget.

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
```

The `migrate` command from the parallel time-as-first-class spec is deliberately absent from this
list: it does not exist yet at the time this spec is written. See "Dependency on the migrate
command" below for how this help text and the parser must still accommodate it landing later.

Each of `setup`, `web`, `read`, `reindex`, `version`, `help` gets an equivalent block: one
paragraph restating what the README's Usage section already says about that command (see
`README.md:66-69`, the four subcommand bullets under the "Usage" heading, which already carries
this prose and is the source to draw from, not duplicate divergently), plus a `Usage:` line.
`read` additionally documents its argument forms (`read`, `read constitution`, `read arc <name>`,
`read realm <name>`, `read person <name>`) since those are not shared by any other command.

Per-subcommand help, layout per command, one paragraph plus any command-specific notes, e.g.
`reverie help reflect`:

```
reverie reflect

Runs maintenance immediately: reflects any stale unreflected sessions and builds any
daily or weekly rollups that are due, instead of waiting for it to happen automatically
on next chat start. Requires a working config and a reachable model provider.

Usage: reverie reflect [--config <path>]
```

and `reverie help doctor`:

```
reverie doctor

Checks whether reverie is set up correctly: config file present and valid, API key
resolvable, memory folder present and writable, memory folder's git state, and SQLite
index present and rebuildable. Never prints secret values. Exits non-zero if any check
fails.

Usage: reverie doctor [--config <path>]
```

### 1.4 `reverie doctor`

New subcommand. Runs a fixed sequence of checks, each independent (one check's failure does not
skip the rest), prints one line per check, and exits `0` only if every check passes.

Output layout, one line per check, `ok` or `fail` plus a short actionable message on failure:

```
reverie doctor

config file .......... ok      (~/.reverie/config.toml)
api key .............. ok      (resolved via OPENAI_API_KEY)
memory folder ......... ok      (~/.reverie/memory, writable)
memory folder git ..... ok      (clean, 42 commits)
sqlite index .......... ok      (present, rebuildable)

All checks passed.
```

or, on failure:

```
reverie doctor

config file .......... ok      (~/.reverie/config.toml)
api key .............. fail    OPENAI_API_KEY is not set. Set it, or run: reverie setup
memory folder ......... ok      (~/.reverie/memory, writable)
memory folder git ..... fail    not a git repository yet (created on first reflect or /bye)
sqlite index .......... fail    index.db missing; run: reverie reindex

2 of 5 checks failed.
```

Checks, in order, and what each verifies:

1. **Config file**: exists at the resolved config path (default or `--config` override) and
   parses under `configSchema` (`packages/core/src/config.ts`, same schema `loadConfig` uses).
   Failure message names the path and, for a parse failure, reuses the same
   `formatZodError`-based message `loadConfig` already produces (`config.ts:126-128`), so the
   wording a person sees here matches what they would see from a failed normal startup.
2. **API key**: calls `resolveApiKey(config)` (`config.ts:160-176`) and reports only whether it
   resolved and by what mechanism (`apiKey` set directly, or `apiKeyEnv` naming an env var that is
   set), never the value. On failure, the message is exactly `resolveApiKey`'s own thrown message
   (it already names the env var it looked for, not a secret) or "not set" phrasing for the
   direct-`apiKey` case. Skipped (reported as `skip`, not `fail`) if the config check above
   failed, since there is no parsed config to resolve a key from.
3. **Memory folder**: `config.memoryDir` exists as a directory and a real write-then-delete probe
   (a temp file inside it) succeeds, proving actual writability rather than trusting stat
   permission bits, which lie under some filesystems and containers. Skipped if config failed.
4. **Memory folder git state**: reports whether `memoryDir/.git` exists; if it does, runs `git
   status --porcelain` and `git log --oneline -1` (read-only git calls, no commit, no `-A add`)
   and reports clean/dirty and commit count, or a plain count of commits. If `.git` does not
   exist yet, this is reported as `ok` with a note that it is created on first reflect, not as a
   failure: an unversioned brand-new memory folder is expected state, not a problem. Skipped if
   the memory folder check failed.
5. **SQLite index**: the index file exists at the expected path under the memory folder
   (`memoryPaths(config.memoryDir).indexDb` or equivalent) and, if present, opens successfully; if
   absent, reports `fail` with the exact remediation `reverie reindex`. This check deliberately
   does **not** run a full reindex itself (that would make `doctor` a slow, destructive-adjacent
   operation instead of a fast, read-only report); it only confirms the file exists and opens,
   and points at the command that rebuilds it.

`doctor` never opens a `MemoryEngine` and never calls `runMaintenance()` (so it never calls
`commitMemory()`, which matters directly for Part 2: a diagnostic command should not itself be a
source of git-subprocess side effects). It never constructs a `ChatProvider` or makes a network
call: checking that a key *resolves* is not the same as checking that it *works*, and this spec
does not add a live provider ping, since a doctor command a person might run offline or before
deciding to spend a token should not require network reachability to report anything at all.

Exit code: `0` if all checks pass, `1` (usage/generic doctor-failure code, see 1.5) if any check
reports `fail`. `skip` results do not by themselves cause failure beyond the upstream check they
depend on already having failed.

### 1.5 Exit codes

No exit code convention exists in this codebase today beyond `0` and a blanket `1` for every
failure (`index.ts:153`, `index.ts:219`; every one of `read.ts`'s 26 return statements is `0` or
`1`). This spec introduces a small fixed table, used consistently across every subcommand added or
touched here:

| Code | Meaning | Examples |
|------|---------|----------|
| 0 | Success | Normal exit, `--version`, `--help`, `doctor` all-pass, chat session ended with `/bye` |
| 1 | Usage error | Unknown subcommand, unknown flag, malformed arguments (a `read` target that doesn't parse, `--config` given with no value) |
| 2 | Config error | Config file missing, config file fails schema validation, `doctor`'s config check fails |
| 3 | Provider error | API key does not resolve, provider construction fails, a live provider call fails during chat/reflect/reindex |
| 4 | Interrupted | Second Ctrl-C during chat (already distinguished in `runChat`'s `interruptLevel` handling, `chat.ts:184-201`, but currently exits the same way as any other clean stop; this spec makes that path set `process.exitCode = 4` explicitly instead of `0`) |

This requires `CliContextResult`'s failure branch (`chat.ts:358-386`) to carry a `kind: 'config' |
'provider'` tag instead of only `message`, so `mainWith()` can map it to code 2 or 3 instead of
always 1. This is the one required source change beyond pure addition: today, config load
failure, provider construction failure, and engine-open failure are already three separate `try`
blocks in `openCliContext` (chat.ts:360-364, 368-373, 375-385) that each currently return the same
shape; tagging each `catch` with its own `kind` is a small, mechanical change to that existing
function, not a redesign.

`doctor`'s own failure is reported as code 1 (a usage-shaped "something about your setup needs
attention" signal), not 2 or 3, since a single `doctor` run can fail on multiple different kinds
of checks at once and picking one of 2/3 to represent the whole run would be arbitrary. `doctor`'s
value is in its per-check output, not its exit code's granularity.

Code 4 is scoped narrowly to interactive chat's own interrupt handling and is not retrofitted onto
`reindex` or `reflect`; those commands do not currently have an interrupt-specific code path to
hang this on, and inventing one is out of scope here. This spec picks a small sequential code (4)
rather than the shell convention of 128+signal (130 for SIGINT), because the surrounding table is
already a small sequential scheme (0-3) and mixing in a 128-based value for one row only would
make the table harder to read, not more standard; nothing in this codebase currently depends on
the 128+signal convention, and a script consuming `reverie`'s exit code needs to check this
table regardless of which number is picked.

`read.ts` is touched by this spec (it gains `--config` and a per-command help block, 1.3, 1.6) but
its existing 19 `return 1` sites are overwhelmingly "not found" results (no such arc, no such
person, no matching document), not usage errors in the sense code 1 means everywhere else in this
table. This spec does not change `read.ts`'s existing exit behavior: its `1` is grandfathered,
kept exactly as it is today, precisely because reclassifying "person not found" as a new code
would be an unrelated, riskier change to a command this spec did not set out to redesign. Anyone
implementing this table should treat `read`'s exit codes as a known, deliberate exception, not an
oversight to be smoothed over while doing the CLI-wide sweep.

### 1.6 `--config <path>`

Behavior: `reverie --config /path/to/config.toml [command]` (flag position before or after the
subcommand, both accepted, e.g. `reverie --config ./x.toml reflect` and `reverie reflect --config
./x.toml` behave identically) routes that path into every place `defaultConfigPath()` is currently
used as the fallback. Missing value (`reverie --config` with nothing after it, or as the last
argument) is a usage error, code 1, message: `--config requires a path argument`.

Implementation shape: `mainWith()` already threads `deps.configPath` through every subcommand that
touches config (`index.ts:134, 145, 171`, all via `deps.loadConfig(deps.configPath)` or
equivalent). The only change needed in `index.ts` is extracting `--config <path>` from `argv`
before dispatch and overriding `deps.configPath` with it when present; `loadConfig()` in
`packages/core/src/config.ts` already accepts an explicit path with no change needed there
(confirmed at `config.ts:111`: `configPath?: string`, defaults internally only when omitted).
`saveConfig` (used by `setup`) takes the same optional-path shape (`config.ts` `saveConfig`,
referenced from `setup.ts:239`), so `reverie setup --config <path>` writes to the override path
too, consistently.

### 1.7 Unknown subcommand and unknown flag handling

Behavior, replacing the current silent fallthrough into chat (1.1): any `argv[0]` that is not one
of the known subcommands, and is not empty, and is not a recognized top-level flag (`--version`,
`-v`, `--help`, `-h`, `--config`), is a usage error: print a one-line message naming the unknown
value and pointing at help, then exit code 1, without touching config, provider, or engine.

```
reverie: unknown command 'reflcet'
Run 'reverie --help' for a list of commands.
```

Same shape for an unrecognized flag anywhere in argv (e.g. `reverie --frobnicate`):

```
reverie: unknown option '--frobnicate'
Run 'reverie --help' for a list of options.
```

This is the one behavior change in Part 1 that is a genuine bug fix rather than a pure addition:
today a typo silently starts a real chat session (config load, API key resolution, engine open,
readline prompt) instead of failing fast. That is worth stating plainly rather than folding it
quietly into "polish."

### Dependency on the migrate command

A companion spec, `2026-08-16-time-as-first-class-design.md`, is being written in parallel (not
yet present in `docs/superpowers/specs/` at the time this spec was written) and introduces
`reverie migrate` with a migration registry. This spec does not design that command, its registry,
or its output format. What this spec commits to, so the two land without conflict:

- The top-level help layout in 1.3 lists commands alphabetically-ish by workflow grouping, not
  strictly alphabetically (chat REPL and `setup` first since they are the two things a new user
  runs, then the working commands, then `doctor`/`version`/`help` last as meta-commands); `migrate`
  slots in among the working commands (after `reflect`, before `doctor`) without reordering
  anything else.
- The exit code table (1.5) is a general table, not CLI-command-specific, so a `migrate` command
  reports Config Error (2) if it cannot read what it needs to migrate, or a new Migration Error
  code if the parallel spec decides it needs one distinct from Provider Error (open question, not
  answered here, since it belongs in that command's own design).
- The argument parsing shape recommended in 1.8 (hand-rolled, but organized as a lookup table of
  subcommand handlers) accommodates adding one more entry without restructuring dispatch, whichever
  library or non-library approach is chosen.
- `doctor`'s check list (1.4) does not include a migration-version check in this spec. Whether it
  should, once `migrate` exists, is for the parallel spec or a follow-up to decide, not this one.

### 1.8 Argument parsing: recommendation

Recommendation: **keep it hand-rolled.** Do not add a dependency (`commander`, `yargs`, `cac`,
`meow`, or similar) for this.

Reasoning:

- Current surface after this spec: roughly eight subcommands, two of which (`read`, and later
  `migrate`) take a sub-argument, three top-level flags (`--version`/`-v`, `--help`/`-h`,
  `--config <path>`), and per-subcommand `--help`. That is within reach of a plain lookup table
  (`Record<string, SubcommandHandler>`) plus a small flag-extraction pass run once before dispatch,
  which is what `index.ts` already does in spirit (`mainWith`'s `if (subcommand === 'x')` chain),
  just needing the chain replaced with a table and the fallthrough branch fixed per 1.7.
- This is a self-hosted personal tool (per `AGENTS.md`: no telemetry, no phoning home, a memory
  folder that is entirely the user's). A CLI framework dependency is small in isolation but is
  exactly the kind of "small" dependency this project's `AGENTS.md` orchestration section asks
  agents to be deliberate about pulling in: every added dependency is one more thing to audit for
  a project whose entire premise is that the user's private reflections never leave their control.
  `packages/cli/package.json` today depends on nothing outside the `@openreverie/*` workspace
  packages, and that is worth preserving as long as it costs little to. Contrast with the
  `smol-toml` and `zod` dependencies already in `core`: those exist because they solve something
  hand-rolling genuinely cannot (a config file format, and structured runtime validation).
  Argument parsing for eight subcommands is not in that category.
- The project already has a working, tested pattern for this exact shape of problem: `read.ts`
  hand-parses its own sub-arguments (`arc <name>`, `realm <name>`, `person <name>`) with plain
  string comparisons and returns typed exit codes, and it works fine at this scale. Extending the
  same style to top-level dispatch is consistent, not a compromise.
- The counter-consideration, stated honestly: a real parsing library buys automatic `--help`
  generation, better error messages for combined short flags, and shields against parsing bugs
  (an option value being swallowed by the next flag, etc.) that a hand-rolled pass can get subtly
  wrong. If the CLI's surface grows materially past this spec (real flag combinations, repeated
  flags, subcommands with many options each), that calculus flips and a library becomes the right
  call. That point is not reached by this spec's additions.

Concretely: extract argv pre-processing (pull out `--version`/`-v`/`--help`/`-h`/`--config
<path>`/`help <cmd>` before touching the subcommand table) into one small function in `index.ts`,
tested directly with plain arrays of strings in `index.test.ts` (or a new test file for this
function specifically), no CLI framework, no process spawning.

## Part 2: CI flake fix

### 2.1 The failure, confirmed

`.github/workflows/ci.yml` (read in full): one job, `check`, on `ubuntu-latest`: checkout, pnpm
setup, Node 22 with pnpm cache, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm build`, `pnpm
test`, in that order, no matrix, no retries.

Confirmed directly:

- `main` is currently at `e72377b` (`git log --oneline -5` on this checkout shows `e72377b` as
  `HEAD -> main, origin/main`), the merge commit for PR #4 (v0.5.0). No commit exists after it.
  **`main` is red right now for a flaky reason, not a code defect, and there is nothing to push to
  retrigger CI**: the next thing that lands on `main`, whatever it is, will retrigger the workflow
  and is expected to go green, since the code did not change and the failure is a race, confirmed
  reproducible-as-a-race and not reproducible on a clean local run (below).
- The `pull_request` run for the identical tree at `f72ece9` passed. The `push`-to-`main` run for
  the merge commit `e72377b` (same file content, per `git show --stat e72377b`, which touches only
  `packages/web`, root docs, and version bump files across seven `package.json` manifests) failed,
  and only on `pnpm test`, with:

  ```
  FAIL  @openreverie/memory  src/engine.test.ts
    > sessionContext recentSummaries > caps recentSummaries at three, keeping the three most
      recent and dropping the oldest
  Error: ENOTEMPTY: directory not empty, rmdir '/tmp/openreverie-engine-recent-OGnRio/.git/objects/pack'
  Tests  1 failed | 615 passed (616)
  ```

- PR #4 touched only `packages/web`, root docs, and version bump lines in `package.json` files
  (verified: `git show --stat e72377b` output lists `README.md`, `ROADMAP.md`, seven manifests,
  `packages/cli/src/release.test.ts`, and `packages/web/**`; nothing under `packages/memory`).
  Neither `engine.test.ts` nor `gitSync.ts` was touched.

Root cause, traced through the actual code:

1. `MemoryEngine.open()` (`packages/memory/src/engine.ts:234-264`) calls `engine.runMaintenance()`
   unconditionally unless the caller explicitly passes `{ maintenance: false }`
   (`options.maintenance !== false` at line 252).
2. `runMaintenance()` (`engine.ts:990` onward) ends by calling `commitMemory()`
   (`engine.ts:1075-1081`) unconditionally, every time, with no flag to skip it.
3. `commitMemory()` (`packages/memory/src/gitSync.ts:18-53`) shells out to a real `git` binary:
   `git init -q`, `git config user.name`/`user.email`, `git add -A`, `git status --porcelain`,
   and, if there is anything staged, `git commit -q -m <message>` (via `execFile`, promisified,
   `gitSync.ts:6-11, 55-57`). This runs against `this.paths.root`, which in every affected test is
   a real directory under the OS temp dir created by `mkdtemp`.
4. The failing test's `describe` block (`packages/memory/src/engine.test.ts:2838-2850`) creates
   its temp dir in `beforeEach` and destroys it in `afterEach` with a bare `rm(dir, { recursive:
   true, force: true })` (line 2848-2850), run immediately after each test's `await
   engine.close()`, with no retry and no delay.
5. `git commit` (and `git init`/`git add` under some conditions) can trigger detached background
   housekeeping (`git gc --auto` style forking, or on some git builds, deferred writes into
   `.git/objects/pack`) that is not guaranteed to have exited by the time the awaited `execFile`
   call resolves; `execFile`'s promise resolves when the direct child exits, not when everything
   that child may have spawned or scheduled has finished. `rm -rf` racing that leftover writer
   into `.git/objects/pack` is exactly what `ENOTEMPTY: directory not empty, rmdir
   '.../.git/objects/pack'` reports: `rm` succeeded in deleting most of the tree and then found
   the pack directory non-empty again (or still being written to) on the pass that expected it
   empty.
6. This test (`engine.test.ts:2883`, "caps recentSummaries at three...") does not touch git or
   maintenance timing in any way that would make it special; it is unlucky, not implicated. Any of
   the 82 (of 87 total `MemoryEngine.open()` call sites in this file; only 5 pass `{ maintenance:
   false }`) tests that open an engine with maintenance enabled and get torn down promptly
   afterward is exposed to the same race. This one lost the race on this run, on this machine.
7. Confirmed independently: a clean worktree at `e72377b` passed `616/616` on three consecutive
   local runs. The code is not wrong; the test suite's isolation from OS-level async cleanup is.

### 2.2 Fix, layer 1: stop git from forking detached housekeeping

Add `-c gc.auto=0` to every `git` invocation `gitSync.ts` makes, in the shared `git()` helper
(`gitSync.ts:55-57`) so every call site picks it up without repeating the flag:

```ts
async function git(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run('git', ['-c', 'gc.auto=0', ...args], { cwd: root })
}
```

This attacks the actual cause: with `gc.auto` disabled, `git commit` (and `git add`/`git init`)
have no threshold that triggers a background `git gc --auto` fork, which is the specific mechanism
that can outlive the parent invocation. This is a one-line, low-risk change scoped entirely to
`gitSync.ts`; it does not change what gets committed, when, or with what message, and every
existing `gitSync.test.ts`-style assertion about commit behavior is unaffected since `gc.auto=0`
only suppresses opportunistic housekeeping, never the commit itself.

### 2.3 Fix, layer 2: retry the recursive rm in afterEach

Belt and braces, applied at `engine.test.ts:2848-2850` and every other `afterEach`/`finally` in
this file (and any other test file) that does a bare `rm(dir, { recursive: true, force: true })`
right after closing an engine that had maintenance enabled. A small retry helper:

```ts
async function rmWithRetry(path: string, attempts = 3, delayMs = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (err) {
      if (i === attempts - 1) throw err
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}
```

Honesty about what this is: this does not fix the race, it papers over its consequence. `fs.rm`
racing an external process writing into the same tree is a real, general hazard that layer 1
narrows but cannot prove eliminated (see 2.5's honesty note on testing). A short retry with
backoff is the standard, low-cost mitigation for exactly this shape of flake and costs at most a
couple hundred milliseconds on the rare run that needs it, nothing on every other run. Apply it as
a shared test helper (e.g. in a test-utils module already used by `engine.test.ts`, or inline if
no shared test-utils module exists yet) rather than duplicating the retry loop at each of the ~19
`afterEach` sites that currently call `rm` directly, so a future change to the retry policy is
one edit, not nineteen.

### 2.4 Deeper option: make git sync injectable, evaluated

The proposal: `runMaintenance()` calls `commitMemory()` unconditionally on every
`MemoryEngine.open()` (confirmed: 82 of 87 `MemoryEngine.open()` call sites in `engine.test.ts` do
not pass `{ maintenance: false }`, so 82 of that file's test cases each spawn up to three real
`git` subprocesses, `init`+`config`+`config`, `add`, `status`, and conditionally `commit`, and
materialize a real `.git` directory inside a temp dir, purely as a side effect of opening an
engine, whether or not the test has anything to do with git sync at all). Making the git-sync call
an injected dependency (added to `EngineDeps`, `engine.ts:116-121`, alongside `chat`, `embeddings`,
`reflectionModel`, `embeddingModel`) that tests can supply a no-op fake for would remove this
entire class of flake at the source, for every current and future test in this file, not just the
one that happened to fail this run, and would very likely speed up the suite noticeably (spawning
and waiting on up to three subprocesses per engine-open, 82 times, is not free, though this spec
does not have a measured before/after number).

Cost and blast radius, assessed concretely rather than abstractly:

- `commitMemory()` is called directly (imported, not injected) from six sites in `engine.ts`:
  lines 520, 807, 882, 982, 1075, and 1202 (confirmed via `grep -n "commitMemory" engine.ts`). Each
  would need to go through `this.deps.gitSync(...)` or equivalent instead of the free function
  import. That is six call-site edits plus the `EngineDeps` interface change plus a default
  real-`commitMemory` implementation wired at every production call site that constructs
  `EngineDeps` (`packages/cli/src/index.ts`'s `openCliContext` usage, `packages/server`'s
  equivalent wiring, and any other place `EngineDeps` is constructed for real use, which this spec
  has not exhaustively enumerated beyond `engine.ts`/`chat.ts`).
- Every one of the 82 affected test call sites in `engine.test.ts` would then need either a shared
  "fake git sync" fixture threaded through `fakeDeps(...)` (the helper these tests already use to
  build `EngineDeps`, referenced throughout the file, e.g. `fakeDeps(new FakeChatProvider([]))` at
  line 2829, 2873) or to rely on `fakeDeps` defaulting to a no-op so no per-test change is needed
  at all. The second shape (default no-op inside the shared `fakeDeps` helper, real implementation
  only wired at the production entry points) is the one that keeps the blast radius to roughly the
  `EngineDeps` interface, `engine.ts`'s six call sites, `fakeDeps`'s own definition, and the
  production wiring points, rather than touching 82 individual test bodies.
- Risk: this is a real interface change to a type (`EngineDeps`) that crosses package boundaries
  (`memory` is depended on by both `cli` and `server` per `AGENTS.md`'s architecture rule), so it
  is not purely test-internal. It needs its own TDD pass (a failing test asserting the injected
  git sync is called instead of the real one, per `AGENTS.md`'s engineering-practice rule) and its
  own review, not a drive-by inside a flake-fix change.

Recommendation: **do layers 1 and 2 now, defer the injectable git-sync refactor to its own
follow-up, not this spec.** Reasoning: layers 1 and 2 are a same-day, low-risk fix that plausibly
eliminates the observed race entirely (layer 1) with a safety net (layer 2), scoped to exactly the
file that caused the failure. The injectable-dependency refactor is a good idea and is worth doing
soon, since it removes a whole class of flake and likely speeds up the suite, but it is a
cross-package interface change with its own blast radius (six call sites in production code, an
`EngineDeps` shape change, wiring at every real construction point) that deserves to be scoped,
tested, and reviewed as its own piece of work rather than riding in on a spec whose stated job is
"fix the thing that made CI red." Bundling it here risks exactly the failure mode `AGENTS.md`
warns about in its review-practices section: a change reported as "the flake is fixed" that also
quietly changed engine wiring, reviewed under the assumption it was a small mechanical patch.

## Testing plan

Covers both parts; each part's tests are independent of the other's.

Part 1 (CLI polish), TDD per `AGENTS.md`'s requirement for deterministic logic:

- `--version`/`-v`/`version`: a test asserting the printed output equals
  `JSON.parse(readFileSync('packages/cli/package.json')).version` exactly, read independently of
  whatever function under test does the reading, so the test would catch both a wrong path and a
  stale hardcoded fallback. Falsifiable directly: hardcode a wrong string in the implementation,
  watch the test fail, revert.
- `--help`/`-h`/per-subcommand help: exact-string assertions against the layouts specified in 1.3,
  not substring checks, since a substring check would pass even if half the command list silently
  went missing. Falsifiable: delete one line from the implementation's help text, watch the exact
  match fail.
- `doctor`: one test per check (five), each constructed so the check under test is the only one
  that can fail (a valid config, a resolvable key, a writable folder, a clean or absent git state,
  a present index, except for the one check being tested), asserting both the per-check pass/fail
  line and the overall exit code. A secrets test: construct a config with a real-looking API key
  string and assert it never appears anywhere in doctor's output, across every check, not only the
  api-key check's own line (guards against, e.g., a config-parse-error message accidentally
  echoing the raw file content).
- Exit codes: one test per row of the table in 1.5, driving `mainWith()` with fakes exactly the
  way the existing `index.test.ts` (referenced by `packages/web/src/App.test.tsx`-style pattern
  used elsewhere in this repo; check `packages/cli/src/index.test.ts` if it exists, or
  `chat.test.ts`'s pattern for `openCliContext`) already fakes `deps`, asserting
  `process.exitCode` lands on the specified value for a config-load failure, a provider-build
  failure, an engine-open failure, an unknown subcommand, and a clean success.
- `--config <path>`: a test asserting a fake `loadConfig` receives the overridden path rather than
  `defaultConfigPath()`'s value, for at least one flag-before-subcommand and one
  flag-after-subcommand argv arrangement.
- Unknown subcommand/flag: a test asserting the fallthrough-to-chat bug (1.1, 1.7) is actually
  fixed, i.e. asserting that a fake `openCliContext`/`runChat` is never called when `argv[0]` is
  an unrecognized string. This is the falsifiable regression test for the bug this spec names
  explicitly: delete the new unknown-command check, watch this specific test fail (it would not
  fail today, since today's behavior is exactly what the deleted check would have prevented),
  restore it.

Part 2 (CI flake fix): a flake fix is fundamentally hard to test directly, and this spec says that
plainly rather than overclaiming. No test can prove a race does not exist; a test can only fail to
reproduce it, which is weaker than absence. What a passing suite after this change actually shows
is "did not reproduce the specific interleaving that failed once in CI," not "cannot reproduce."
Concretely, for this change:

- There is no unit test to write for `-c gc.auto=0` beyond confirming (by reading `gitSync.ts`
  after the change, and by running the existing `gitSync.test.ts` suite, which already asserts on
  the commands `commitMemory` produces and their effects) that the flag is present on every
  invocation and that commit behavior, messages, and staged-file handling are unchanged. That is a
  real, falsifiable test (remove the flag from one call site, watch a "every git call passes
  gc.auto=0" assertion fail, if such an assertion is added; or fall back to inspecting the actual
  args passed to a mocked `execFile` in `gitSync.test.ts`, which is the stronger version of this
  and should be preferred: mock `execFile` and assert the args array for each call includes `-c
  gc.auto=0` before the subcommand).
- For the retry helper, a real unit test is possible and should be written: a fake `rm` that
  throws `ENOTEMPTY` on its first N calls and succeeds after, asserting the helper retries the
  right number of times and eventually resolves, and a second test asserting it re-throws after
  exhausting attempts rather than swallowing a real persistent failure. This is directly
  falsifiable (delete the retry loop, first test fails immediately).
- Confidence beyond that comes from operational signal, not a new test: running the full `pnpm
  test` suite locally several times in a row (as was already done, three consecutive clean runs
  pre-fix, 616/616 each time) and, after landing the fix, watching CI itself over the next several
  pushes to `main` for a recurrence of this specific `ENOTEMPTY` failure, or its absence. A single
  green run after the fix is weak evidence given the failure was already rare (one failure
  observed across the runs referenced in this spec); several green runs over time, plus the fact
  that layer 1 removes the specific mechanism traced in 2.1 step 5 rather than a guessed-at one, is
  what actually earns confidence here. This spec does not claim the race is proven gone, only that
  its known cause is closed off and its consequence is cushioned.

## Deferred / out of scope

- The injectable git-sync dependency refactor (2.4): recommended, not designed here, deferred to
  its own follow-up spec or task.
- Any CI workflow change beyond what `gitSync.ts` and the test `afterEach` need (no new job, no
  matrix, no retry-the-whole-job wrapper at the GitHub Actions level; retrying at that level would
  mask the same class of race in code this spec did not audit, e.g. other packages' temp-dir
  tests, rather than fixing the one root cause identified here).
- `reverie migrate` and its registry: belongs entirely to the parallel time-as-first-class spec.
- A live provider reachability check inside `doctor` (an actual network call to confirm the model
  responds): deliberately not included, per 1.4's reasoning; could be a future `doctor --live` or
  similar, not designed here.
- Auto-generated help text from a parsing library's own help renderer: rejected as part of the
  hand-rolled recommendation in 1.8; the exact layouts in 1.3 are the spec, whatever writes them.

## Open questions

- Whether `EngineDeps`, once the deeper git-sync refactor (2.4) is eventually done, should default
  to a real `commitMemory` implementation (so every non-test construction site is unaffected by
  default and only tests opt into a fake) or require every caller to supply it explicitly (safer
  against a silently-missing git sync in a real deployment, noisier for every real call site).
  This spec does not resolve it since it defers the refactor itself; whoever picks it up should
  decide deliberately rather than let it fall out of whichever shape is easiest to type.
- Whether exit code 4 (Interrupted) should extend to `reindex`/`reflect` if they ever grow their
  own interrupt handling. Not needed for this spec's scope; noted so it is not forgotten if those
  commands change later.
