---
severity: warning
---

# Docs updated with features

A commit that ships a new feature, a behavior change, or a new config or CLI
option must update the README and the CHANGELOG alongside the code. Docs
that lag the code silently rot: users hit undocumented flags, upgrade notes
go missing, and the next contributor has no record of why or when something
changed.

## Flag

- a new CLI flag, subcommand, or config key with no corresponding mention in
  the README;
- a changed default, changed output format, or changed behavior for an
  existing option with no README update reflecting the new behavior;
- a commit that adds or changes user-facing behavior with no CHANGELOG entry
  for the change;
- a CHANGELOG entry that only restates the commit message without telling
  the user what to do differently (e.g. new flag name, migration step).

## Do not flag

- internal refactors, performance work, or test-only changes with no
  user-visible effect;
- bug fixes that restore documented behavior rather than introduce new
  behavior — a CHANGELOG entry is still good practice but this rule targets
  new features, behavior changes, and new options;
- a multi-commit PR where an earlier or later commit in the same PR carries
  the doc update — judge the PR as a whole, not each commit in isolation, if
  the reviewer can see the full commit range;
- typo fixes, dependency bumps, or CI changes.

## Examples

### Bad

```diff
+ program.option('--retries <n>', 'number of retries', 3)
```

No README section for `--retries`, no CHANGELOG entry — the commit adds a
new CLI option and stops there.

### Good

```diff
+ program.option('--retries <n>', 'number of retries', 3)
```

```diff
+ ### CLI Options
+ - `--retries <n>`: number of times to retry a failed request (default: 3)
```

```diff
+ ## Unreleased
+ - Added `--retries` flag to control retry attempts on failed requests.
```
