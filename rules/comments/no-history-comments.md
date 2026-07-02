---
severity: warning
---

# No history in comments

The context of a change belongs in the commit message, not in the code.
Code describes the present; git describes the past. History comments rot
instantly: the next reader has no idea what "before" or "the old file"
refers to.

## Flag

- "moved from X", "renamed from Y", "previously this did Z", "see old
  implementation in ...";
- references to the change, ticket discussion, or review that produced the
  code, when they explain history rather than a live constraint;
- commented-out code kept "just in case" — git already remembers it.

## Do not flag

- a ticket/issue link that documents a live external constraint (a vendor
  bug being worked around, a spec being implemented);
- TODO/FIXME markers pointing forward, if the project allows them.

## Examples

### Bad

```js
// moved here from utils.js during the big refactor
// const legacyTotal = items.length * avgPrice;  (old approach, keep for now)
export function totalOf(items) { ... }
```

### Good

```js
export function totalOf(items) { ... }
```

The provenance goes into the commit message: "Move totalOf out of utils.js
so the pricing layer owns it."
