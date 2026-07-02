---
severity: warning
---

# Group lines into logical blocks

Related lines belong together; unrelated lines belong apart. Blank lines
between logical blocks do for code and command sequences what paragraphs do
for text: they show the structure before the reader parses a single line.

## Flag

- walls of statements with no blank lines where several distinct steps are
  happening;
- interleaved concerns: setup, action, and cleanup lines shuffled together
  instead of grouped.

## Do not flag

- short functions that genuinely are one block;
- formatting choices a formatter already owns (indentation, line width).

## Examples

### Bad

```js
const user = await loadUser(id);
const orders = await loadOrders(id);
audit.log('viewed', id);
const total = sum(orders);
const name = user.displayName;
audit.log('summed', id);
return { name, total };
```

### Good

```js
const user = await loadUser(id);
const orders = await loadOrders(id);

const name = user.displayName;
const total = sum(orders);

audit.log('viewed-summary', id);
return { name, total };
```
