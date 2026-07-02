---
severity: warning
---

# Plain language over jargon

Documentation and comments should be understandable beyond the circle of
specialists who wrote them. Technical terms are welcome when they are the
precise ones; jargon used to sound professional is a tax on every reader.

## Flag

- needlessly obscure phrasing where a plain word exists ("leverage" for
  use, "instantiate a paradigm" for apply an approach);
- unexplained project-internal slang and abbreviations in text a newcomer
  is expected to read;
- acronyms never expanded on first use in a document.

## Do not flag

- precise domain terms with no plain equivalent (idempotency, race
  condition, memoization);
- internal shorthand in scratch notes or code intended only for the
  immediate team, when the project accepts that.

## Examples

### Bad

```markdown
The orchestrator leverages the DLQ paradigm to guarantee at-least-once
semantics across the saga's compensation boundary.
```

### Good

```markdown
Failed messages go to a separate "dead letter" queue instead of being
lost. A recovery job retries them, so every message is processed at least
once, even across multi-step rollbacks.
```
