---
severity: blocker
---

# Fix the cause, not the symptom

A change that makes a problem invisible without removing its cause is worse
than no change: the bug is still there, and now it is hidden. A trustworthy
fix makes clear why the bug happened; when the change does not, treat it as
suspect.

## Flag

- a special case or extra condition added only to make one failing input or
  test pass;
- a retry, sleep, or increased timeout that hides a race condition or an
  ordering bug;
- a check that was weakened, disabled, or deleted instead of fixing what it
  caught;
- a fix with no visible connection to a cause — if you cannot tell from the
  change why the bug happened, raise it as a question.

## Do not flag

- a documented, deliberate workaround for a third-party bug with a link to
  the upstream issue;
- retries around genuinely unreliable external calls (network, rate limits)
  when the underlying operation is idempotent.

## Examples

### Bad

```js
function totalOf(order) {
  // items[0] is sometimes undefined in production, skip it
  const items = order.items.filter(Boolean);
  return items.reduce((sum, item) => sum + item.price, 0);
}
```

The filter hides the real question: why does an order contain undefined
items at all?

### Good

```js
function totalOf(order) {
  return order.items.reduce((sum, item) => sum + item.price, 0);
}
// ...and the importer that produced undefined items is fixed at the source,
// with a test on the importer.
```
