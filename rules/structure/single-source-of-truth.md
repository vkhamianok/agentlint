---
severity: warning
---

# Single source of truth

The same fact, constant, or piece of logic must not live in two places.
Copies always drift apart, and the reader has no way to know which one is
right. This applies to code, configuration, documentation, and prompts
alike.

## Flag

- logic copy-pasted instead of extracted and reused, especially when the
  copies already differ slightly;
- the same constant, threshold, or URL defined in several files;
- documentation restating what code or another document already says,
  instead of referencing it.

## Do not flag

- intentional decoupling: two things that look alike today but serve
  different owners and will evolve independently;
- test fixtures that repeat production shapes — tests may prefer literal
  clarity over reuse.

## Examples

### Bad

```js
// pricing.js
const MAX_DISCOUNT_PERCENT = 40;
// checkout.js
const MAX_DISCOUNT = 40; // must match pricing.js
```

### Good

```js
// pricing.js
export const MAX_DISCOUNT_PERCENT = 40;
// checkout.js
import { MAX_DISCOUNT_PERCENT } from './pricing.js';
```
