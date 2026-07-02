---
severity: warning
---

# Documentation reads as connected prose

Documentation, comments, and prompts are written once and read many times.
Text meant to explain must read as flowing sentences grouped into logical
paragraphs — not as a hacker's telegraph of fragments and arrows.

## Flag

- fragments and arrow chains (`A -> B -> fails`) where reasoning should be
  written out;
- bullet dumps used as a substitute for explanation — bullets are for
  enumerable facts, prose is for reasoning;
- walls of text: sentences not grouped into paragraphs by topic.

## Do not flag

- tables and bullet lists for genuinely enumerable content (options,
  commands, statuses);
- reference material where scannability beats narrative (API references,
  cheat sheets).

## Examples

### Bad

```markdown
auth: token -> middleware -> ctx.user. no token -> 401. expired -> refresh
-> retry -> else 401.
```

### Good

```markdown
Authentication starts at the middleware: it reads the bearer token and
attaches the resolved user to the request context. A missing token ends the
request with 401 immediately. An expired token triggers one refresh
attempt; if that fails too, the request ends with the same 401.
```
