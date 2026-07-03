# Changelog

## 0.2.0 — 2026-07-03

- `agentlint init`: idempotent project setup — starter config with the
  default rule library, project rules directory, optional husky wiring
  via `--hook`.
- Rule management group: `agentlint rule add | edit | delete | list`.
  `add` and `edit` generate and rewrite rules from plain-language
  descriptions in any language, validated against the rule format
  contract; `list` shows the effective rule set in precedence order.
  The `add-rule` command is replaced by `rule add`.
- Review commands move under an explicit noun: `agentlint review
diff|staged|commit|range|snapshot`; bare `agentlint` still reviews the
  working tree.
- The `quick` profile reviews the diff in a single shot without repo
  exploration: hook latency is now deterministic. Per-profile timeouts
  are configurable via `timeoutMinutes`.
- The system prompt travels via a temp file instead of argv, removing
  Windows command-line length limits with large rule sets.
- The project `.agentlint/rules/` directory always loads, with or
  without a `rules` key in the config, and wins over library and global
  rules.
- Rules outrank the task description: a task demanding what a rule
  forbids is reported as a conflict, verified by an adversarial e2e test.
- The `comments/no-history-comments` library rule covers living
  documentation: version-anchored notes, tombstones of removed features,
  retrofitted asides on dated log entries.
- The `--commit` flag is removed: the gate judges, the caller acts —
  exit code `0` is the "safe to commit" signal.

## 0.1.0 — 2026-07-02

First release: review targets (diff, staged, commit, range, snapshot),
built-in principles plus Markdown rules with severities, depth profiles
(quick/standard/deep with a refutation pass), task intent, `--fix`,
JSON/Markdown reports, husky/CI gate semantics.
