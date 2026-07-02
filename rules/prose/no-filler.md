---
severity: warning
---

# No filler

Connected prose is not watery prose. Every sentence in documentation,
comments, and prompts must carry information the reader can act on; a
sentence that adds nothing steals attention from the ones that do.

## Flag

- sentences that restate the heading or the previous sentence;
- generic padding: "it is important to note", "as we all know", "this
  section describes";
- text duplicating what code or a neighboring document already says instead
  of referencing it.

## Do not flag

- deliberate repetition with a purpose: a warning repeated at the point of
  use, a summary after a long section;
- transitional sentences that genuinely guide the reader between topics.

## Examples

### Bad

```markdown
## Configuration

This section describes configuration. Configuration is important because
it lets you configure the tool. The config file is a file that contains
settings.
```

### Good

```markdown
## Configuration

Settings live in `.agentlint/config.json`; every key has a default, so an
empty file is valid.
```
