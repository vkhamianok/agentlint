---
severity: blocker
---

# No silent fallbacks

A fallback value that replaces a failure hides it. Degrading gracefully is
allowed only when the degradation itself is loudly visible — logged,
reported, or shown — so someone will come and fix the cause.

## Flag

- a default or placeholder returned where an operation failed, with no log
  or signal ("unknown", empty list, zero, cached stale value);
- `??` / `||` defaults papering over a value that is absent because
  something upstream went wrong;
- catch-and-return-default in any layer that leaves no trace of the failure.

## Do not flag

- defaults for genuinely optional values, where absence is a normal state
  and not a failure;
- visible degradation: the fallback is applied AND the failure is logged
  with enough context to debug.

## Examples

### Bad

```js
function displayName(user) {
  try {
    return formatName(user);
  } catch {
    return 'unknown';
  }
}
```

### Good

```js
function displayName(user) {
  try {
    return formatName(user);
  } catch (err) {
    logger.warn('falling back to raw name', { userId: user.id, err });
    return user.rawName;
  }
}
```
