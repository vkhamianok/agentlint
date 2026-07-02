---
severity: warning
---

# No history in comments or docs

The context of a change belongs in the commit message — not in the code
and not in living documentation. Code and docs describe the present; git
describes the past. A living document reads as if the current design had
always been the design: when a feature is removed, it disappears from the
docs entirely — it does not leave a tombstone.

## Flag

- "moved from X", "renamed from Y", "previously this did Z", "see old
  implementation in ...";
- version-anchored change notes in living documents: "removed after v0.1",
  "(revised after ...)", "used to be ...";
- tombstones of removed features: "X is no longer supported", "we dropped
  Y", "Z is not needed anymore" — negative documentation of things that do
  not exist. Migrating readers get this from the CHANGELOG;
- references to the change, ticket discussion, or review that produced the
  code, when they explain history rather than a live constraint;
- commented-out code kept "just in case" — git already remembers it.

## Do not flag

- CHANGELOG files, release notes, and migration guides — recording history
  is their entire job;
- deliberate non-goals stated in present tense ("committing is out of
  scope", "the gate does not act") — they document a current design
  boundary, not a change;
- dated log documents (verification logs, dated decision records): their
  entries are records, not annotations. Retrofitting an old entry with a
  "this was later changed" aside is still a violation — append a new dated
  entry or leave it to git;
- a ticket/issue link that documents a live external constraint (a vendor
  bug being worked around, a spec being implemented);
- TODO/FIXME markers pointing forward, if the project allows them.

## Examples

### Bad

```js
// moved here from utils.js during the big refactor
export function totalOf(items) { ... }
```

```markdown
The --frobnicate flag is no longer supported (removed after v0.1);
use --munge instead. Auto-commit: No (revised after v0.1).
```

### Good

```js
export function totalOf(items) { ... }
```

```markdown
Use --munge to transform the input. Auto-commit: No — the gate judges,
the caller acts.
```

The docs describe `--munge` as if `--frobnicate` never existed; the
provenance lives in the commit message and the CHANGELOG.
