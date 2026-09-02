# Remember by default design

Date: 2026-08-15
Status: approved (decided with the project owner after a dogfooding failure)
Target release: v0.3.1
Scope: remove permission asking entirely, widen what gets captured, and surface what is already
known so the companion stops needing to search for it.

Amends [the Phase A spec](2026-08-14-phase-a-companion-quality-design.md), which removed proposal
generation but left the persona still instructing the model to raise proposals and still able to
ask. This spec finishes that job and changes the capture model behind it.

## 1. What went wrong

From a real session on a memory folder predating v0.3.0:

```
reverie> Hey, before we dive in, a tiny housekeeping thing I'd been meaning to ask: since you
mentioned Nadia, do you want me to add her to your people list?
you> Yes, add Nadia to your list.
reverie> Done. Do you want me to keep it as just her name, or note the basics?
```

The session opened with housekeeping instead of a hello, and it asked permission to remember,
twice, in a product whose defining property is remembering without being asked.

Five causes, all verified:

1. `PENDING_PROPOSALS` in `personas.ts` ships in every system prompt and instructs the model to
   raise pending proposals early and fold them into the greeting. v0.3.0 stopped reflection
   creating proposals but never revisited this line.
2. `pendingProposalsSection` in `context.ts` repeats it and names the tool to resolve them with.
3. `resolve_proposal` is still a registered tool, so asking is available.
4. Nothing forbids asking permission to remember. That is the second question, which was not a
   proposal at all.
5. `SessionContext` surfaces realms and arcs but not people, so the companion cannot know a
   person exists without searching.

## 2. Asking is removed, not narrowed

- `PENDING_PROPOSALS` is deleted from the persona.
- `pendingProposalsSection` is deleted from the assembled prompt.
- `resolve_proposal` is removed from the tool list and its dispatch, so the model structurally
  cannot ask. A test asserts its absence.
- Legacy queues drain silently: on engine open, any pending proposal is materialized and its
  resolution recorded, with no conversation. The owner's queue is empty, but the repo is public
  and other folders are not. This keeps the compatibility promise without ever asking.
- The persona gains an explicit rule: never ask permission to remember something. If it is worth
  keeping, keep it. Use `remember` silently and do not narrate it.

Proposal generation stays retired. `proposals.jsonl` and its format stay. Proposals may return
later for a different purpose, arbitration only the user can settle (merging two nodes that turn
out to be the same human, closing an arc gone quiet, resolving a contradiction between what was
said months ago and today), in a surface that is not a conversation. Not in this release.

## 3. The persona explains the memory it has

The model has tools but no mental model of what they feed, so it cannot reason well about what
belongs where. The persona gains a short, plain orientation: verbatim transcripts at the bottom,
never edited; items as the atomic unit, of kind observation, feeling, event or intention; session
summaries above them; daily and weekly rollups above those; arcs as ongoing storylines it
maintains, realms as life domains, and the constitution as the living record of the person; and
the graph as the actual record of how things connect, where prose is testimony and `graph.jsonl`
is the record.

Orientation, not a manual. It exists so the model's judgment about what to capture improves.

## 4. A node and a page are different decisions

This is the substantive change. One judgment currently decides both whether something is
remembered and whether it gets a maintained document, which is why the funnel is narrow.

- **A node is nearly free.** One line in `graph.jsonl`, permanent and queryable. Nodes are
  created generously, on first mention, for anyone or anything with a real part in the user's
  life.
- **A page is expensive.** It is a maintained document that reflection's second pass rewrites
  with a model call every session that touches it. A page is granted when earned: the subject
  recurs across sessions, or clearly mattered within a single one.

What earns a node:

- **People**, using the existing `person` node type: real people in the user's life, and also
  public figures and fictional characters when they have a part in how the user thinks or talks.
  A partner, a manager, a therapist, but also a novelist they keep returning to or a character
  they identify with.
- **Non-people things**, using the existing `entity` node type, which the original spec reserved
  as the escape hatch and which nothing has ever used: films, books, companies, places, bands,
  works of fiction. Entities get nodes and are surfaced in context. They do not get pages in this
  release, deliberately, until it is clear whether a maintained page per film reads well.
- **Events** need nothing new. `item` already has kind `event`.

What must not be captured: general facts about the world, and public people or incidents
mentioned only as an analogy or an example. The test is whether the thing has a part in the
user's life, not whether it was mentioned. Something invoked to illustrate a point is not a node.

Requirements:

- Reflection's structured output must express "this deserves a node" separately from "this
  deserves a page." The current `newPersons` shape conflates them.
- **Promotion must be possible.** Something captured as a node only, which later recurs, must be
  able to gain a page in a later session. Reflection therefore needs to see which known people
  and entities already have pages and which do not.
- `MemoryEngine` needs a path that creates a person or entity node with no page, alongside the
  existing `createPersonPage`.
- Pass two already drops narrative updates naming a node with no `doc`, so unpaged nodes are safe
  there. This must be verified rather than assumed.

The entity and arc boundary matters: an arc is a storyline with movement (the job search), an
entity is a thing that appears in storylines (the company). Blurring them makes the graph mush.

## 5. Surfacing what is already known

- `SessionContext` gains people and entities alongside realms and arcs, each carrying its name and
  whether a page exists, rendered in the prompt the way arcs and realms already are.
- Recent `intention` items are surfaced. They are captured today and nothing ever brings them
  back, which is why the companion appears to forget what the user said they wanted to do.
- Active arcs untouched for a while are identifiable, so the greeting can open with one.

No new open-threads or reminders subsystem. Intentions and arcs already exist; what was missing
was resurfacing. If use shows this is not enough, a first-class version belongs in the web
interface release, where a surface exists to display it.

## 6. The greeting never opens with admin

The greeting instruction gains an explicit prohibition: never open with housekeeping,
bookkeeping, or anything about managing memory. Open with the person's life.

## 7. Compatibility

- No existing file changes format. `entity` nodes use a node type the schema already allows.
- Pending proposals in older folders are materialized silently rather than stranded.
- `reverie read person <name>` must distinguish a person known with no page from a person never
  heard of. Reporting "not found" for someone present in the graph is the same class of
  dishonesty already fixed once in that command.
- Both safety modes ship unweakened. The only persona changes are removing the proposals
  paragraph and adding the memory orientation and the no-asking rule. Crisis text is untouched.

## 8. Deferred

- Pages for entities.
- Proposals returning for arbitration, in a non-conversational surface.
- A first-class open-threads concept.
