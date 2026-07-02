---
severity: blocker
---

# No swallowed errors

This codebase has a zero error tolerance policy: there are no unimportant
errors, because there are no unimportant functions. Every error must
surface so it can be identified and fixed fast. An error nobody sees is a
bug with a delay timer.

## Flag

- empty catch blocks and `catch { return someDefault }`;
- `.catch(() => {})`, unhandled promise rejections, fire-and-forget async
  calls whose failure nobody observes;
- ignored error return values and ignored non-zero exit codes.

## Do not flag

- catch blocks that genuinely handle the error (compensate, translate it
  into a domain error, or rethrow with added context);
- an intentionally ignored error with a comment stating the reason it is
  safe to ignore.

## Examples

### Bad

```js
try {
  await syncInventory(order);
} catch {
  // sync is not critical
}
```

### Good

```js
try {
  await syncInventory(order);
} catch (err) {
  logger.error('inventory sync failed', { orderId: order.id, err });
  throw err;
}
```
