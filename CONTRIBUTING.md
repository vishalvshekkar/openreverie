# Contributing to openreverie

Thank you for considering it. Please read this whole page before opening anything.

## The bar

This project stores people's most personal thoughts. A subtle bug here is not a broken button; it can lose or corrupt someone's record of their own life, or leak it. So the contribution bar is deliberately high:

- Contribute only in areas you genuinely understand. If you are unsure whether that includes you, it probably does not yet, and that is fine; using the tool and filing precise issues is a real contribution.
- Read [AGENTS.md](AGENTS.md) and the current spec in `docs/superpowers/specs/` before writing code. PRs that contradict the spec without discussion will be closed.
- AI-assisted contributions are fine (this project is largely built that way), but you must fully understand and stand behind every line you submit. "The agent wrote it and it seemed to work" does not clear the bar.

## Ground rules

- Open an issue and get agreement on direction before any non-trivial PR.
- Tests are required for deterministic logic. See the engineering practice section of AGENTS.md.
- Follow the writing style rules in AGENTS.md in all prose, including commit messages.
- Never include real personal memory data in issues, fixtures, or tests. Fixtures must be synthetic.
- Safety-mode behavior changes require explicit maintainer sign-off, always.

## Setup

```
pnpm install
pnpm build
pnpm test
pnpm lint
```

Node 22 or newer, pnpm 10.

## Scope honesty

The project is in its design phase. Until the memory engine lands and stabilizes, large feature PRs are premature; small, well-understood improvements and issue reports are the useful contributions right now.
