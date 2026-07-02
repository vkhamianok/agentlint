---
severity: warning
---

# Do not break working code: refactor in steps

A large change to a working area should arrive as a sequence of safe,
individually verifiable steps, not one big-bang rewrite. A rewrite that
replaces everything at once destroys the reviewer's ability to check it
and the team's ability to bisect what broke.

## Flag

- a working module rewritten wholesale in one change when incremental steps
  were clearly possible;
- a "refactoring" that also changes behavior, mixes moves with edits, or
  rewrites tests in the same breath — moves and behavior changes belong in
  separate steps;
- deleted-and-recreated files that hide the actual diff.

## Do not flag

- genuinely small areas where a full rewrite IS the incremental step;
- mechanical, tool-driven transformations (rename, format) applied broadly
  but verifiably.

## Examples

### Bad

One commit: "rework payment processing" — 40 files changed, the old module
deleted, a new one added, tests rewritten to match the new behavior.

### Good

A sequence: (1) extract interfaces, tests still green; (2) add the new
implementation behind the interface; (3) switch callers one group at a
time; (4) delete the old implementation once nothing uses it.
