---
severity: warning
---

# Dependencies are a one-directional, layered graph

Packages, files, and documents depend downward: high-level layers use
low-level ones, never the reverse, and never in cycles. A cycle means the
parts cannot be understood, tested, or replaced separately. When a change
touches a tangled area, it should split the mass into layers, not thicken
the tangle.

## Flag

- a new import that creates a cycle between files or packages;
- a low-level module reaching up into a high-level one (a utility importing
  business logic, a library importing the app);
- "shared" modules that import from everywhere and are imported everywhere.

## Do not flag

- type-only circular references where the runtime graph stays acyclic and
  the language allows it — but mention it if it smells like a design cycle;
- dependency inversion done properly (a low layer defining an interface the
  high layer implements).

## Examples

### Bad

```js
// utils/format.js
import { currentTenant } from '../app/session.js';

// low layer reaching up
export const money = (n) => `${currentTenant().currency} ${n}`;
```

### Good

```js
// utils/format.js — knows nothing about the app
export const money = (n, currency) => `${currency} ${n}`;
// app code passes its own context downward
```
