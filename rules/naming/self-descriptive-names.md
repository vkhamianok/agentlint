---
severity: warning
---

# Self-descriptive names

Names carry the design. A reader should understand what a variable,
function, or file holds or does from the name alone, without opening the
body. Code is written once and read many times; a minute spent on a name is
repaid on every read.

## Flag

- names that lie or have drifted from behavior (a `getUser` that creates
  one, an `isValid` that also saves);
- vague names that could mean anything: `data`, `info`, `temp`, `result2`,
  `process`, `handle`, `doStuff`, grab-bag `utils`;
- abbreviations and one-letter names outside tiny local scopes;
- a name that needs a comment to be understood — the name should absorb the
  comment.

## Do not flag

- conventional short names in conventional places: `i` in a small loop,
  `err` in a catch, `req`/`res` in middleware;
- long names where length genuinely earns clarity — verbosity itself is not
  a virtue, but it is not this rule's target.

## Examples

### Bad

```js
function process(data) {
  const temp = data.filter((d) => d.a > 0);
  return temp.length;
}
```

### Good

```js
function countActiveSubscriptions(subscriptions) {
  const active = subscriptions.filter((sub) => sub.daysLeft > 0);
  return active.length;
}
```
