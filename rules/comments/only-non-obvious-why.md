---
severity: warning
---

# A comment explains a non-obvious why

A comment is justified only when it explains a non-obvious reason behind
the current code — something the reader cannot get from the code itself,
and that would still belong there if the file were written from scratch
today. Comments describe the unexpected; they never retell the code.

## Flag

- comments that state the obvious purpose of an obvious construct;
- comments that duplicate the name of the function or variable they sit on;
- a surprising piece of code (magic constant, deliberate deviation from the
  usual pattern, workaround) with NO comment — the missing why is also a
  violation.

## Do not flag

- doc comments on public APIs describing contract and units;
- comments carrying constraints invisible in the code ("keep in sync is
  impossible here because X", "order matters: B reads what A wrote").

## Examples

### Bad

```js
// increment the counter
counter += 1;
```

### Good

```js
// The vendor API counts pages from 1, everything else here counts from 0.
const vendorPage = page + 1;
```
