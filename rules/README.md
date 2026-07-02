# Rules Library

The built-in library of default review rules: one rule per file, grouped by
category. The library will grow and change over time. A rule file is a
prompt: the reviewer reads it verbatim, so tuning the wording is the normal
way to tune the reviewer.

## Rule format

````markdown
---
severity: warning # info | warning | blocker — how hard violations hit
---

# Rule name

One paragraph: the rule and why it matters.

## Flag

- concrete triggers, as bullets.

## Do not flag

- explicit non-goals and borderline cases. This section fights noise.

## Examples

### Bad

\```js
// 3-8 lines showing a violation
\```

### Good

\```js
// the corrected version
\```
````

`severity` is the only frontmatter key and the only machine-read part;
everything else is prose for the reviewer. `Do not flag` and `Examples`
are optional but strongly recommended: negative examples are the best
tool against false positives.

## Categories

| Category      | Rules                                                         | Severity          |
| ------------- | ------------------------------------------------------------- | ----------------- |
| `root-cause/` | fix the cause, correct over easy                              | blocker           |
| `errors/`     | no swallowed errors, no silent fallbacks, debuggable messages | blocker / warning |
| `comments/`   | why-comments only, no history, command blocks                 | warning           |
| `structure/`  | SSOT, SRP, layers, 7±2, logical blocks, no big-bang rewrites  | warning           |
| `naming/`     | self-descriptive names                                        | warning           |
| `prose/`      | connected prose, no filler, plain language                    | warning           |

## Using the library

Enable rules per project in `.agentlint/config.json`:

```json
{
  "rules": [
    "library:structure",
    "library:comments/no-history-comments",
    "./team-rules/*.md",
    { "rule": "library:naming/self-descriptive-names", "severity": "info" }
  ]
}
```

`library:<category>` enables a whole category, `library:<category>/<rule>`
one rule; plain paths and globs load your own files; the object form
overrides a rule's severity. Without a `rules` key, agentlint falls back
to loading `.agentlint/rules/*.md` (project) and `~/.agentlint/rules/*.md`
(global). Global rules apply either way unless `"inheritGlobalRules": false`.
