# Mode at launch: design

## Context

The modes epoch (Phase D, `2026-08-17-modes-profile-settings-plan.md`) shipped the mechanism for
conversation modes: a ten-mode catalogue, a persona overlay, `set_mode`, a CLI command table, a
mode stream event, session mode over HTTP, and a web mode picker for switching mid-conversation.
It never specified what mode a session starts in, or what the person sees during the CLI's
startup work before the first prompt. This spec resolves both, worked out with the human directly
in a design workshop, not decided unilaterally, per AGENTS.md's rule that the spec is the source
of truth before implementation.

Verified against the code before this workshop:

- `AgentSession.start` (`packages/core/src/agent.ts:197`) defaults `options.mode` to `'general'`.
  The CLI never passes anything else, so every CLI session starts `general` today.
- The web's `POST /api/v1/sessions` accepts an optional mode, and the Task 21 picker calls
  `POST /api/v1/sessions/:id/mode` after creation for a live switch. CLI and web already disagreed
  about whether mode is a launch-time choice.
- Nothing persists or reads a "last used mode." Session mode is written once per session and
  never read back as a default for the next one.
- `MemoryEngine.open` runs startup maintenance (`runMaintenance`, `drainLegacyProposals`,
  `refreshDocPaths`) before any session exists, and that work is mode-independent.

## Decision: CLI always starts in `general`

No change from today's behavior. Every CLI session starts `general`, with no launch-time prompt
and no persisted "last mode." `/mode` remains the only way to change it, for that conversation
only.

Rejected: remembering the last used mode as the CLI default. It would need a new persisted field
and makes mode sticky across conversations, which contradicts the existing doctrine that mode is
a property of one conversation, not a setting.

## Decision: the CLI startup wait gets a decorative status spinner

In the CLI, engine start and session start are the same process invocation, back to back:
`MemoryEngine.open`'s maintenance work runs, then the session opens in `general`. That wait is
silent today.

Add a spinner that cycles through a small set of predetermined phrases while `MemoryEngine.open`
runs. It is purely decorative, not tied to the engine's actual internal phases (reflecting stale
sessions, building rollups, draining legacy proposals, refreshing doc paths). No progress-event
plumbing in `MemoryEngine.open` is needed; this is a CLI-side timer loop that runs until `open()`
resolves, after which the `general`-mode session starts.

Approved phrases (the implementer may reorder or lightly edit for length; keep the register quiet
and reflective, no marketing tone, no em dashes, per AGENTS.md):

- "Getting my thoughts in order..."
- "Looking back..."
- "Contemplating past conversations..."
- "Tidying up loose ends..."
- "Making sense of things..."
- "Settling in..."

## Decision: the web defers session creation to a mode-card picker

On the web, the server keeps one `MemoryEngine` open across many sessions, so engine start (and
its maintenance work) happens once at server boot, decoupled from any individual session or "new
chat" click. That decoupling is what makes this workable: gating session creation on the web costs
nothing in wait time, because the expensive work already happened before anyone loaded the page.

New chat flow: navigating to "new chat" shows the mode catalogue as clickable cards. No session
exists yet, and no `POST /api/v1/sessions` call happens until the person clicks a card. Clicking a
card creates the session with that mode in the same action, and the session's system prompt
assembles for that mode from the first message onward. Abandoning the picker screen, closing the
tab, navigating away, leaves nothing to clean up, since no session was ever created.

This is a deliberate divergence from the CLI's "always general, no gate" policy. The two
interfaces are different mediums, a REPL versus a page-based app, and the decoupling of engine
start from session start exists only on the web. Forcing the CLI to gate on a picker would mean
gating every single invocation with no equivalent decoupling to make that free. Forcing the web to
skip the picker would throw away a natural fit its architecture already offers for free.

The mode-card screen is not a reintroduction of "remember the last mode": cards are shown
uniformly, with no pre-selection or highlighting based on history. A "most recently used"
affordance, if ever wanted, needs its own decision and its own persisted field, not smuggled in
here.

## Out of scope

- The existing mid-conversation mode switcher stays as-is on both interfaces: the CLI's `/mode`
  command, and the web's per-session `POST /api/v1/sessions/:id/mode` picker (Task 21). Neither
  changes.
- Safety mode (companion/firewall) is untouched. It is not selected via the mode-card screen, has
  no launch-time gate, and `GET /api/v1/settings` remains the only way to read it, with no write
  route. A mode adjusts style within the safety stance; it never adjusts the safety stance itself.
- The mode catalogue's actual ten modes and the persona overlay are unchanged. This spec only
  decides when and how a mode gets chosen, not what the modes are.

## Implementation notes for the next agent

- CLI: the spinner is new CLI-side code around the existing `MemoryEngine.open()` call in the
  startup path. It does not require changes to `packages/memory` or `packages/core`.
- Web: the new-chat screen's mode cards replace whatever the current "new chat" entry point does
  today. Confirm what that is before changing it; this spec did not audit that component. Session
  creation moves from however it happens today to strictly "on card click." The web already
  enumerates the mode catalogue for the Task 21 switcher; reuse that, do not add a second source
  of truth for the mode list.
- Neither change touches the ten-mode catalogue, `core/personas.ts`, or the safety batch. Do not
  open those files for this work.
