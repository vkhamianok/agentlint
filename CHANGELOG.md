# Changelog

## 0.4.0 — 2026-07-04

New:

- **Scopes: partial reviews of a monorepo.** Define named path filters under a
  `scopes` map in `.agentlint/config.json` (scope name to include globs), then
  run `agentlint review snapshot --scope orchestrator` to review only that
  subsystem. A scope is the inverse of `ignore` (an include-filter) and applies
  to every target — diff, staged, commit, range, snapshot; an unknown `--scope`
  name fails loudly. It turns a snapshot review of a large repo from one thin
  pass over everything into a focused, thorough pass over one part.
  `agentlint scope list` shows the scopes a project defines. Scopes merge by
  name across global and project config (project wins a clash).
- **Per-profile rules.** A profile can carry its own `rules` selectors — same
  grammar as top-level `rules` — added on top of `config.rules`, so a security
  `audit` profile pulls in security rules without every review paying for them.
  Setting `inheritProjectRules: false` on a profile (mirrors
  `inheritGlobalRules`) makes it stand alone: `config.rules` and the project
  `.agentlint/rules/` directory are dropped, leaving only the profile's own
  rules (global rules still apply per `inheritGlobalRules`) — a focused audit
  not diluted by the general rule set. Free-text `instructions` stay as the
  supplementary focus lens. `--scope` and `--profile` compose:
  `review snapshot --scope orchestrator --profile audit`.
- **A profile can carry a default scope.** `profiles.<name>.defaultScope`
  names a scope the profile restricts to unless an explicit `--scope`
  overrides it — for profiles that are inherently a slice, e.g. a `docs`
  profile that only ever looks at `docs/**`. A default scope that names no
  known scope fails loudly, like `--scope` does.

Fixed:

- The diff-only `quick` profile no longer reports phantom blockers about code
  it cannot see. A diff shows changed lines with only a little surrounding
  context, so a symbol may be declared just outside the visible hunk; the
  reviewer was treating an assumption about such a symbol as a verified bug. It
  is now told plainly: judge on the shown evidence, and if a finding depends on
  the definition of a symbol that is not shown, lower confidence or raise a
  question instead of blocking. (Found by dogfooding — this class of false
  positive had blocked a correct commit.)

## 0.3.0 — 2026-07-03

**Breaking config changes** (0.2.0 configs need updating; the validator
rejects the old keys loudly):

- `--depth` is renamed to `--profile`.
- The config `depth` context map is renamed `defaultProfile`.
- `models` and `timeoutMinutes` (separate maps keyed by profile) fold into
  `profiles.<name>.{model,timeoutMinutes,budgetUsd}`.
- The JSON/Markdown report field `depth` is renamed `profile`.

New:

- **Open profile set.** `profiles` is a named map: tune the three built-ins
  (quick/standard/deep) or add your own — e.g. a security `audit` on a
  stronger model. A custom profile inherits the standard numbers, carries
  free-text `instructions` appended to the reviewer prompt, and runs a
  thorough review (explore + refutation) like `deep`. `--profile <name>`
  runs any of them; unknown names fail loudly.
- **Verdict cache.** A passing verdict is cached in `.git/agentlint/cache`
  (per clone/worktree, never committed), keyed by the change and everything
  that shapes the verdict (guidance + the profile's model, focus, explore,
  refute). Re-reviewing an unchanged diff under the same profile is instant
  and free (`cached` in the report). Blocks and snapshots are never cached;
  `--no-cache` bypasses. Each profile caches for itself.
- `agentlint rule check`: a meta-review of the effective rule set —
  contradictions, duplication, vagueness, and noise risks, each with a
  concrete rewording.
- `budgetUsd` per profile: a hard spend cap, configurable like the timeout.
- A TTY-gated stderr progress line during engine-driven commands; agents,
  hooks, and CI see nothing.
- `--report -` writes the JSON report as the only stdout output, for pipes
  and calling agents.

Fixed:

- **Security:** the Claude CLI is never spawned through a shell. The old
  Windows shell-retry path joined arguments unescaped, so a repo's own
  config model name could inject shell commands. The fallback is removed
  (execa spawns npm `.cmd` shims directly), and model names are restricted
  to safe characters.

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
