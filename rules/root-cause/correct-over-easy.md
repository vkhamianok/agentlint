---
severity: blocker
---

# Correct over easy — without overengineering

When the correct solution and the easy one diverge, require the correct
one. The easy path taken knowingly is debt with interest. But the rule cuts
both ways: when a simple solution is also correct, extra machinery is not
"more correct" — it is just more.

## Flag

- a shortcut the change itself admits: "for now", "quick fix", "temporary",
  "good enough";
- solving the case at hand in a way that obviously breaks the next case the
  same code must handle;
- speculative complexity: abstractions, options, and layers added for needs
  nobody stated.

## Do not flag

- a small, honest solution that covers the actual requirements — simple is
  not the same as easy;
- explicitly scoped MVPs when the task itself asked for one.

## Examples

### Bad

```js
// quick fix: parse the user id out of the error message text
const userId = error.message.match(/user (\d+)/)?.[1];
```

### Good

```js
const userId = error.context.userId; // the thrower now attaches context
```
