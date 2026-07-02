---
severity: warning
---

# Error messages you can debug from

An error message is read at the worst possible moment — during an incident.
It must say what failed and with what input, so the reader can act without
reproducing the problem first.

## Flag

- messages with no context: "something went wrong", "invalid input",
  "operation failed";
- rethrows that drop the original error or its stack;
- assertions and validations that do not include the offending value.

## Do not flag

- messages shown to end users, where hiding internals is deliberate — as
  long as the full context is logged elsewhere;
- hot paths where attaching heavy context is measurably too expensive.

## Examples

### Bad

```js
if (!isValidRange(from, to)) throw new Error('invalid range');
```

### Good

```js
if (!isValidRange(from, to)) {
  throw new Error(`invalid range: from=${from} to=${to} (from must be <= to)`);
}
```
