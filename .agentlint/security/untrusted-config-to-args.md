---
severity: blocker
---

# Restrict untrusted config values before they become process arguments

`.agentlint/config.json`, rule files, and commit messages are untrusted: they
travel with the repository and an attacker may control them. When a value from
one of those sources becomes an argument to a spawned process (a model name, a
ref, a path), it must first be checked against a strict allowlist pattern — the
exact characters a legitimate value uses, and nothing else. Validating on the
way in means later code cannot be surprised by a metacharacter, a leading dash
that turns into a flag, or a path traversal.

## Flag

- a config- or repo-sourced string passed to `execa` / spawn without a prior
  regex or enum check (e.g. a model name, branch, or file path);
- validation by denylist ("strip `;` and `&`") instead of an allowlist of the
  characters that are permitted;
- a pattern that is missing anchors (`^`…`$`), so a valid prefix lets arbitrary
  text ride along after it;
- a new config field that reaches a subprocess but skips the schema's existing
  pattern guards.

## Do not flag

- values already constrained by a zod schema pattern or a fixed enum before use
  (for example a model name matched against `MODEL_NAME_PATTERN`);
- fully internal constants that never originate from repository content.

## Examples

### Bad

```js
const model = config.profiles[name].model; // straight from config.json
await execa('claude', ['-p', '--model', model]);
```

### Good

```js
const MODEL_NAME_PATTERN = /^[A-Za-z0-9._:-]+$/;
const model = z.string().regex(MODEL_NAME_PATTERN).parse(config.profiles[name].model);
await execa('claude', ['-p', '--model', model]);
```
