# Living with dreaming: a guide

This is a walkthrough for someone who has decided to turn dreaming on. For what dreaming is
and how it is designed, read the README's [Dreaming](../README.md#dreaming) section first.
This guide assumes you have read it and covers the part it does not: what you actually type,
what you will actually see, and what to expect once it is running.

## Turning it on

Dreaming is off by default and can only be switched on by hand, in your config file
(`~/.reverie/config.toml` unless you passed `--config`). Add or edit:

```toml
[dreaming]
enabled = true
cadence = "daily"
```

`cadence` is `daily` or `weekly`, nothing else. There is no switch for this in the web
interface: the config file is the only way in or out.

Optionally, give dreaming its own model:

```toml
[models]
dreaming = "gpt-5-mini"
```

If you leave `models.dreaming` unset, dreaming uses whatever `models.reflection` is set to.

Once it is on, expect nothing to happen at first. Dreaming needs at least 5 reflected
sessions in your memory folder before it will run at all. If you have just started using
reverie, this is normal: keep talking to it, and once you have five reflected sessions
behind you, the next trigger (see below) will produce a dream.

## Seeing what it would do, before it spends anything

Before you wait around, or before you wonder whether it is worth turning on:

```
reverie dream --dry-run
```

This is the single most useful command for understanding the feature, and it makes no model
call at all: it costs nothing. It prints the current cadence period, whether that period is
due for a dream, the seeds it would start from with their weights, and the walk it would take
across your graph from those seeds. If you have fewer than 5 reflected sessions, or dreaming is
off, it still runs the selection and shows you what it would pick once you are past that point.
Run this any time you want to see the mechanism working without paying for it.

## Running one on demand

```
reverie dream
```

Runs a dream now, if one is due: dreaming turned on, at least 5 reflected sessions, and the
current period not already covered by an earlier dream. If it is not due, it prints a plain
reason instead of running (`dreaming is off`, a session-count shortfall, or `period ... is
already covered`).

```
reverie dream --force
```

Runs one anyway, whether dreaming is off or the period is already covered. Use this to see a
real dream without waiting for the next period, or to check that the pipeline still works.

Besides `--force`, three other triggers can also produce a dream without you running anything:
after a session's reflection finishes, in the background when reverie starts up, and (if you
run `reverie web`) from the server's own timer every 30 minutes. Whichever fires first in a
due period runs the dream; the rest are no-ops for that period. At most one dream runs per
cadence period, and a missed period is never made up: if your machine is off for a week under a
daily cadence, you get one dream the next time something triggers it, not seven.

## Reading them back

```
reverie dream --list
```

Lists past dreams: date, cadence period, insight count, and whether a narrative was written.

```
reverie dream --show <dreamId>
```

Prints one dream's narrative in full, then its insight headlines (each with any feedback
verdict already recorded against it), then the path to that run's process log.

The same material is in the web interface's Dreams tab, with the narrative and the insights
shown as separate sections and feedback controls on each insight.

Each dream is honestly two different kinds of writing, plus an audit trail, stored under
`dreams/<date>-<dreamId>/` in your memory folder:

- `dream.md`: a short piece of creative writing, meant for you to read. Non-literal, built
  from the same seeds as the insights, but not a factual account.
- `insight.md`: the hedged observations the companion draws on in later conversations. Each
  one names a kind (pattern, change over time, connection, open question, or strength), a
  confidence, and points at the specific session, document, or graph entity it came from.
- `process.jsonl`: the audit trail for that one run: which seeds were picked and why, what the
  tool loop looked at, what each model call returned.

Not every dream has a narrative. A tone gate can withhold `dream.md` if the writing does not
land the way dreaming is supposed to (positive or gently curious, never a nightmare); when that
happens, `insight.md` still exists and `reverie dream --show` says plainly that no narrative
was written. The web Dreams view says the same thing in that case.

`dreams/log.jsonl`, one level up, is the append-only record of coverage and feedback across
every run. None of these files are ever edited after they are written.

## Giving feedback

For each insight, you can say it is right, wrong, or that you would rather it not come up
again. Two ways to do this:

- From the web Dreams view: open a dream, and each insight has Right, Wrong, and a
  do-not-bring-up control next to it.
- In conversation: just tell the companion. If a dream insight comes up and you correct it or
  confirm it, it records the verdict through a tool of its own.

Be clear about what a verdict actually does. Marking an insight wrong or do-not-bring-up
removes it permanently from the system prompt section and from the opener; it will not be
brought up to you again. Future dreams are also told about the verdict, which makes them less
likely to raise the same framing again. What it does not do: nothing stops a future dream from
noticing something similar from new material and raising it as a new insight of its own. A
verdict corrects that one insight, not the topic forever.

The CLI only shows verdicts that have already been recorded (through the web view or in
conversation); `reverie dream --show` has no command of its own to record a new one from the
terminal.

## Tuning how it reads

Three preferences, stored in `profile.md`, change nothing about whether or how often dreaming
runs, only how a dream reads once it has:

- `dreams.voice`: `first`, `second`, or `third` person for the narrative. Default is `first`
  ("I dreamt...").
- `dreams.openerMention`: whether a fresh, unread dream may get a light mention when you next
  start a conversation. Default on.
- `dreams.promptSection`: whether dream insights are available to the companion during
  conversation at all. Default on.

Set these from the web interface's Settings view, under its own Dreams section, or by hand in
`profile.md` if you would rather edit the file directly.

## What to expect

- At most one dream per cadence period, no matter how many of the triggers fire.
- Missed periods are never made up. Dreaming is about the present state of your memory, not
  about producing an artifact for every calendar slot you were offline for.
- Some dreams will have insights but no narrative: the tone gate withheld the story that time.
  That is expected behavior, not a bug.
- This runs on your own machine, best effort, whenever it happens to be on. It is not a
  service with guaranteed uptime.

## An honesty note

The pipeline itself, selection, scheduling, the tool loop, the structured output and its
validation, is covered by automated tests, run against scripted fake providers. No human has
yet judged the quality of what a real model actually writes: whether a narrative feels like a
genuine recombination rather than something generic, or whether an insight is a good,
well-grounded observation rather than merely schema-valid. That judgment is still open. See the
manual testing queue in [`docs/dreaming.md`](dreaming.md) (section 13) for exactly what is left
to check by hand.
